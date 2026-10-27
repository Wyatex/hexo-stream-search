import { PROGRESS_THROTTLE_MS } from '../../shared/constants'
import type { IndexedDoc, SearchMetaRecord, SearchPostRecord, SearchProgress } from '../../shared/types'
import { isMetaRecord, parseJsonlLine } from './protocol'

export interface StreamSyncHandlers {
  /** 收到元数据行 */
  onMeta?(meta: SearchMetaRecord): void
  /** 需要加入倒排索引的文档（新建或缓存命中） */
  onDocument(doc: IndexedDoc, kind: 'new' | 'cached'): void
  /** 服务端已删除的文章，需要从索引中移除 */
  onDocumentRemoved?(docId: string): void
  /** 进度上报 */
  onProgress?(progress: SearchProgress): void
}

export interface StreamSyncOptions {
  /** 索引文件地址 */
  url: string
  /** 本地缓存（同时作为流式处理过程中的文档池） */
  localMap: Map<string, IndexedDoc>
  /** 事件回调 */
  handlers: StreamSyncHandlers
  /** JSONL 记录 → 索引文档 */
  processPost: (raw: SearchPostRecord) => IndexedDoc
  /** 自定义 fetch 实现 */
  fetchImpl?: typeof fetch
  /** 计时函数（默认 performance.now） */
  now?: () => number
  /** 进度上报节流间隔 */
  throttleMs?: number
}

export interface StreamSyncResult {
  /** 需要写入缓存的文档 */
  toPut: IndexedDoc[]
  /** 需要从缓存中删除的文章 ID */
  toDelete: string[]
  /** 是否命中未变更缓存提前断开连接 */
  canceledEarly: boolean
  /** 实际扫描的文章数 */
  scannedCount: number
  /** 全站文章总数 */
  totalCount: number
}

function defaultNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/**
 * 流式拉取 JSONL 索引并做增量同步
 *
 * - 第 1 行为元数据：比对本地缓存，清理服务端已删除的文章，定位最后一个缺失项
 * - 其余为文章数据：未变更则复用缓存（不重复分词），变更则重新分词并即时入索引
 * - 当流位置越过最后一个缺失项时提前 cancel，释放服务端连接
 */
export async function syncJsonlStream(options: StreamSyncOptions): Promise<StreamSyncResult> {
  const { url, localMap, handlers, processPost } = options
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? defaultNow
  const throttleMs = options.throttleMs ?? PROGRESS_THROTTLE_MS

  // TODO(feat): 支持 fetch 断点续传
  // 当前每次同步都从文件开头重新拉取整包，仅靠「未变更不重复分词 + 越过最后缺失项后 cancel」来省流量。
  // 计划改为：
  //   1) 读取索引的 ETag / Last-Modified，并随 meta 头一起下发给客户端；
  //   2) 把已接收的字节偏移持久化到 IndexedDB；
  //   3) 下次请求带 `Range: bytes=<offset>-` 与 `If-Range: <etag>`，中断后从断点继续；
  //   4) 服务端不支持 Range（返回 200 而非 206）时，自动回退到当前的全量流式行为。
  const response = await fetchImpl(url)
  if (!response.ok) {
    throw new Error(`拉取索引失败: HTTP ${response.status}`)
  }
  if (!response.body) {
    throw new Error('响应不支持流式读取')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  let meta: SearchMetaRecord | null = null
  let lastMissingIndex = -1
  let postIndex = 0

  const toPut: IndexedDoc[] = []
  const toDelete: string[] = []
  let canceledEarly = false
  let lastProgressTime = 0

  const reportProgress = (force = false): void => {
    const current = now()
    if (!force && current - lastProgressTime < throttleMs) return
    lastProgressTime = current

    const total = meta ? meta.total : localMap.size
    const loaded = postIndex
    handlers.onProgress?.({
      loaded,
      total,
      percent: total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0,
      updated: toPut.length,
      scanned: postIndex,
    })
  }

  outer: while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const rawLine of lines) {
      const data = parseJsonlLine(rawLine)
      if (!data) continue

      // --- 元数据行 ---
      if (isMetaRecord(data)) {
        meta = data
        const validIds = new Set(meta.allIds)

        // 1. 清除本地缓存中已在服务端删除的文章
        for (const cachedId of [...localMap.keys()]) {
          if (!validIds.has(cachedId)) {
            toDelete.push(cachedId)
            localMap.delete(cachedId)
            handlers.onDocumentRemoved?.(cachedId)
          }
        }

        // 2. 检查本地是否缺失旧文章（防止上次同步中途关闭网页）
        // TODO(fix): 这里只统计了「本地完全没有」的文章。已在缓存中但 m 发生变化（内容已更新）的文章
        // 并不会推高 lastMissingIndex，若它排在某个未变更文章之后，就可能在读到它之前被断流跳过，
        // 导致索引里长期保留旧内容（详见 README「已知缺陷」一节）。
        // 计划修复：meta 头下发前 N 篇文章的 { id, m } 快照，据此精确计算首个不一致的位置。
        for (let i = 0; i < meta.allIds.length; i++) {
          if (!localMap.has(meta.allIds[i])) lastMissingIndex = i
        }

        postIndex = 0
        handlers.onMeta?.(meta)
        reportProgress(true)
        continue
      }

      // --- 文章数据行 ---
      const post = data as SearchPostRecord
      const currentIndex = postIndex++
      const cached = localMap.get(post.id)

      // 命中缓存且修改时间戳完全一致
      if (cached && cached.m === post.m) {
        handlers.onDocument(cached, 'cached')

        // 当前位置已越过所有缺失文章，说明后面的全部本地已有且未改动，直接中断连接
        if (currentIndex > lastMissingIndex) {
          canceledEarly = true
          try {
            await reader.cancel('Hit up-to-date cached post, stopping stream.')
          } catch {
            // 忽略取消流产生的非致命错误
          }
          postIndex = meta ? meta.total : localMap.size
          reportProgress(true)
          break outer
        }

        reportProgress(false)
        continue
      }

      // 新增或内容更新：分词并加入同步队列与当前倒排索引（已加载即可搜）
      const processed = processPost(post)
      localMap.set(processed.id, processed)
      toPut.push(processed)
      handlers.onDocument(processed, 'new')

      reportProgress(false)
    }
  }

  // 流自然结束（未被 cancel）时，处理 buffer 残留行
  if (!canceledEarly && buffer) {
    buffer += decoder.decode()
    const remaining = buffer.split('\n')
    for (const rawLine of remaining) {
      const data = parseJsonlLine(rawLine)
      if (!data || isMetaRecord(data)) continue

      const post = data as SearchPostRecord
      const cached = localMap.get(post.id)
      if (!cached || cached.m !== post.m) {
        const processed = processPost(post)
        localMap.set(processed.id, processed)
        toPut.push(processed)
        handlers.onDocument(processed, 'new')
      } else {
        handlers.onDocument(cached, 'cached')
      }
    }
  }

  if (!canceledEarly && meta && meta.total > 0) {
    postIndex = meta.total
  }
  reportProgress(true)

  return {
    toPut,
    toDelete,
    canceledEarly,
    scannedCount: postIndex,
    totalCount: meta ? meta.total : localMap.size,
  }
}
