import {
  DEFAULT_BATCH_INTERVAL_MS,
  DEFAULT_BATCH_SIZE,
  PROGRESS_THROTTLE_MS,
} from '../../shared/constants'
import type {
  IndexedDoc,
  IndexSyncState,
  SearchMetaRecord,
  SearchPostRecord,
  SearchProgress,
} from '../../shared/types'
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
  /** 历史同步状态（用于 HTTP Range 断点续传与协商缓存） */
  syncState?: IndexSyncState | null
  /** 分批持久化回调（每批次或流结束时触发） */
  onBatchCommit?: (batch: {
    toPut: IndexedDoc[]
    toDelete: string[]
    syncState: IndexSyncState
  }) => Promise<void>
  /** 兼容别名 */
  onPersistBatch?: (batch: {
    toPut: IndexedDoc[]
    toDelete: string[]
    syncState: IndexSyncState
  }) => Promise<void>
  /** 分批文档数量阈值（默认 50） */
  batchSize?: number
  /** 分批刷新最大时间间隔毫秒（默认 500） */
  batchIntervalMs?: number
}

export interface StreamSyncResult {
  /** 需要写入缓存的文档（包含整流过程中更新的全部文档） */
  toPut: IndexedDoc[]
  /** 需要从缓存中删除的文章 ID */
  toDelete: string[]
  /** 是否命中未变更缓存提前断开连接 */
  canceledEarly: boolean
  /** 实际扫描的文章数 */
  scannedCount: number
  /** 全站文章总数 */
  totalCount: number
  /** 本次是否为断点续传（206）或协商缓存（304） */
  resumed?: boolean
  /** 最终同步状态记录 */
  finalSyncState?: IndexSyncState
}

function defaultNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/**
 * 解析 HTTP Content-Range 响应头（格式：bytes <start>-<end>/<total>）
 */
function parseContentRange(header: string | null): { start: number; end: number; total?: number } | null {
  if (!header) return null
  const match = header.match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i)
  if (!match) return null
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: match[3] === '*' ? undefined : Number(match[3]),
  }
}

/**
 * 流式拉取 JSONL 索引并做增量同步（支持 HTTP Range 断点续传、304 协商缓存与分批原子持久化）
 *
 * - 支持 Range: bytes=<offset>- 与 If-Range 校验进行断点续传
 * - 206 Partial Content：复用已保存的 Meta 头并从断点字节继续
 * - 200 OK：若不支持 Range 或 ETag 变动，平滑回退为全量流式同步
 * - 416 Range Not Satisfiable：偏移失效自动重试全量拉取
 * - 304 Not Modified：0 字节瞬间完成
 * - 原始 Uint8Array 0x0A 扫描保证提交的字节偏移严格对齐行边界
 */
export async function syncJsonlStream(options: StreamSyncOptions): Promise<StreamSyncResult> {
  const { url, localMap, handlers, processPost } = options
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? defaultNow
  const throttleMs = options.throttleMs ?? PROGRESS_THROTTLE_MS
  const batchCommit = options.onBatchCommit ?? options.onPersistBatch
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  const batchIntervalMs = options.batchIntervalMs ?? DEFAULT_BATCH_INTERVAL_MS
  const syncState = options.syncState ?? null
  const syncStateKey = syncState?.key ?? (url.startsWith('sync_state:') ? url : `sync_state:${url}`)

  // 1. 组装条件请求头
  const requestHeaders: Record<string, string> = {}
  const canResume = Boolean(
    syncState &&
    syncState.byteOffset > 0 &&
    syncState.status === 'syncing' &&
    (syncState.etag || syncState.lastModified),
  )

  if (canResume && syncState) {
    requestHeaders['Range'] = `bytes=${syncState.byteOffset}-`
    if (syncState.etag) {
      requestHeaders['If-Range'] = syncState.etag
    } else if (syncState.lastModified) {
      requestHeaders['If-Range'] = syncState.lastModified
    }
  } else if (syncState?.status === 'completed' && (syncState.etag || syncState.lastModified)) {
    if (syncState.etag) {
      requestHeaders['If-None-Match'] = syncState.etag
    }
    if (syncState.lastModified) {
      requestHeaders['If-Modified-Since'] = syncState.lastModified
    }
  }

  let response = await fetchImpl(
    url,
    Object.keys(requestHeaders).length > 0 ? { headers: requestHeaders } : undefined,
  )

  // 2. 状态机分支处理
  // 304 Not Modified: 0 字节瞬间完成
  if (response.status === 304) {
    const cachedMeta = syncState?.meta
    if (cachedMeta) {
      handlers.onMeta?.(cachedMeta)
    }
    const total = cachedMeta ? cachedMeta.total : localMap.size
    handlers.onProgress?.({
      loaded: total,
      total,
      percent: 100,
      updated: 0,
      scanned: total,
    })
    return {
      toPut: [],
      toDelete: [],
      canceledEarly: false,
      scannedCount: 0,
      totalCount: total,
      resumed: true,
      finalSyncState: syncState ?? undefined,
    }
  }

  // 416 Range Not Satisfiable: 远端文件变小或偏移越界，丢弃 offset 自动重试全量
  if (response.status === 416) {
    response = await fetchImpl(url)
  }

  if (!response.ok) {
    throw new Error(`拉取索引失败: HTTP ${response.status}`)
  }
  if (!response.body) {
    throw new Error('响应不支持流式读取')
  }

  const isPartial = response.status === 206
  const responseEtag = response.headers.get('ETag') ?? syncState?.etag
  const responseLastModified = response.headers.get('Last-Modified') ?? syncState?.lastModified

  const toPut: IndexedDoc[] = []
  const toDelete: string[] = []
  const batchPut: IndexedDoc[] = []
  const batchDelete: string[] = []

  let initialByteOffset = 0
  if (isPartial && syncState) {
    const contentRange = parseContentRange(response.headers.get('Content-Range'))
    initialByteOffset = contentRange?.start ?? syncState.byteOffset
  } else if (canResume && !isPartial) {
    // 服务端返回 200 OK（不支持 Range 或 ETag 变动导致全量回退）：清空之前未完成的局部文档并加入删除队列
    for (const id of localMap.keys()) {
      toDelete.push(id)
      batchDelete.push(id)
      handlers.onDocumentRemoved?.(id)
    }
    localMap.clear()
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  let currentStreamOffset = initialByteOffset
  let lastCommittedByteOffset = initialByteOffset
  const lineOffsets: number[] = []

  let meta: SearchMetaRecord | null = null
  let lastDivergentIndex = -1
  let postIndex = 0

  let canceledEarly = false
  let lastProgressTime = 0
  let lastBatchTime = now()

  let currentSyncState: IndexSyncState = {
    key: syncStateKey,
    url,
    byteOffset: lastCommittedByteOffset,
    etag: responseEtag,
    lastModified: responseLastModified,
    status: 'syncing',
    completed: false,
    meta: isPartial ? syncState?.meta : undefined,
    scannedCount: postIndex,
    updatedAt: Date.now(),
  }

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

  const flushBatch = async (isDone = false, force = false): Promise<void> => {
    currentSyncState = {
      key: syncStateKey,
      url,
      byteOffset: lastCommittedByteOffset,
      etag: responseEtag,
      lastModified: responseLastModified,
      status: isDone ? 'completed' : 'syncing',
      completed: isDone,
      meta: meta ?? (isPartial ? syncState?.meta : undefined),
      scannedCount: postIndex,
      updatedAt: Date.now(),
    }

    if (batchCommit) {
      if (batchPut.length > 0 || batchDelete.length > 0 || isDone || force) {
        await batchCommit({
          toPut: [...batchPut],
          toDelete: [...batchDelete],
          syncState: currentSyncState,
        })
        batchPut.length = 0
        batchDelete.length = 0
        lastBatchTime = now()
      }
    }
  }

  // 206 Partial Content：从历史 syncState 恢复 meta 头并计算断流点
  if (isPartial && syncState?.meta) {
    meta = syncState.meta
    currentSyncState.meta = meta
    handlers.onMeta?.(meta)

    const hasValidAllM = Array.isArray(meta.allM) && meta.allM.length === meta.allIds.length
    lastDivergentIndex = -1
    if (hasValidAllM) {
      for (let i = 0; i < meta.allIds.length; i++) {
        const id = meta.allIds[i]
        const m = meta.allM![i]
        const cached = localMap.get(id)
        if (!cached || cached.m !== m) {
          lastDivergentIndex = i
        }
      }
    } else {
      for (let i = 0; i < meta.allIds.length; i++) {
        if (!localMap.has(meta.allIds[i])) {
          lastDivergentIndex = i
        }
      }
    }

    if (syncState.scannedCount !== undefined) {
      postIndex = syncState.scannedCount
    } else {
      let count = 0
      for (const id of meta.allIds) {
        if (localMap.has(id)) count++
        else break
      }
      postIndex = count
    }
    reportProgress(true)
  }

  outer: while (true) {
    const { done, value } = await reader.read()
    if (done) break

    if (value) {
      const chunkStartOffset = currentStreamOffset
      currentStreamOffset += value.byteLength

      // 扫描原始 Uint8Array 中 0x0A ('\n') 字符的精确全局字节位置
      for (let i = 0; i < value.length; i++) {
        if (value[i] === 10) {
          lineOffsets.push(chunkStartOffset + i + 1)
        }
      }

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const rawLine of lines) {
        const lineEndByteOffset = lineOffsets.shift()!
        const data = parseJsonlLine(rawLine)
        if (!data) continue

        // --- 元数据行 (仅 200 全量流首行出现) ---
        if (isMetaRecord(data)) {
          meta = data
          lastCommittedByteOffset = lineEndByteOffset
          currentSyncState.meta = meta
          currentSyncState.byteOffset = lastCommittedByteOffset
          const validIds = new Set(meta.allIds)

          // 1. 清除本地缓存中已在服务端删除的文章
          for (const cachedId of [...localMap.keys()]) {
            if (!validIds.has(cachedId)) {
              toDelete.push(cachedId)
              batchDelete.push(cachedId)
              localMap.delete(cachedId)
              handlers.onDocumentRemoved?.(cachedId)
            }
          }

          // 2. 精确计算最后一个不一致的位置（缺失或 m 已变更）
          const hasValidAllM = Array.isArray(meta.allM) && meta.allM.length === meta.allIds.length
          lastDivergentIndex = -1
          if (hasValidAllM) {
            for (let i = 0; i < meta.allIds.length; i++) {
              const id = meta.allIds[i]
              const m = meta.allM![i]
              const cached = localMap.get(id)
              if (!cached || cached.m !== m) {
                lastDivergentIndex = i
              }
            }
          } else {
            // 降级兼容：仅根据缺失 ID 计算
            for (let i = 0; i < meta.allIds.length; i++) {
              if (!localMap.has(meta.allIds[i])) {
                lastDivergentIndex = i
              }
            }
          }

          handlers.onMeta?.(meta)

          // 若全站文章均已在本地且修改时间戳完全一致，首行零字节断流
          if (hasValidAllM && lastDivergentIndex === -1) {
            canceledEarly = true
            try {
              await reader.cancel('All posts up to date according to meta, stopping stream.')
            } catch {
              // 忽略取消流产生的非致命错误
            }
            for (const id of meta.allIds) {
              const doc = localMap.get(id)
              if (doc) {
                handlers.onDocument(doc, 'cached')
              }
            }
            postIndex = meta.total
            reportProgress(true)
            await flushBatch(true)
            break outer
          }

          postIndex = 0
          reportProgress(true)
          await flushBatch(false, true)
          continue
        }

        // --- 文章数据行 ---
        const post = data as SearchPostRecord
        const currentIndex = postIndex++
        const cached = localMap.get(post.id)
        lastCommittedByteOffset = lineEndByteOffset

        // 命中缓存且修改时间戳完全一致
        if (cached && cached.m === post.m) {
          handlers.onDocument(cached, 'cached')

          // 当前位置已越过所有缺失或发生变更的文章，安全断流
          if (meta && currentIndex > lastDivergentIndex) {
            canceledEarly = true
            try {
              await reader.cancel('Hit up-to-date cached post, stopping stream.')
            } catch {
              // 忽略取消流产生的非致命错误
            }
            postIndex = meta ? meta.total : localMap.size
            reportProgress(true)
            await flushBatch(true)
            break outer
          }

          if (
            batchPut.length >= batchSize ||
            (now() - lastBatchTime >= batchIntervalMs && batchPut.length > 0)
          ) {
            await flushBatch(false)
          }

          reportProgress(false)
          continue
        }

        // 新增或内容更新：分词并加入同步队列与当前倒排索引
        const processed = processPost(post)
        localMap.set(processed.id, processed)
        toPut.push(processed)
        batchPut.push(processed)
        handlers.onDocument(processed, 'new')

        if (
          batchPut.length >= batchSize ||
          (now() - lastBatchTime >= batchIntervalMs && batchPut.length > 0)
        ) {
          await flushBatch(false)
        }

        reportProgress(false)
      }
    }
  }

  // 流自然结束时，处理 buffer 残留行
  if (!canceledEarly && buffer) {
    buffer += decoder.decode()
    const remaining = buffer.split('\n')
    for (const rawLine of remaining) {
      const lineEndByteOffset = lineOffsets.shift() ?? currentStreamOffset
      const data = parseJsonlLine(rawLine)
      if (!data || isMetaRecord(data)) continue

      const post = data as SearchPostRecord
      postIndex++
      lastCommittedByteOffset = lineEndByteOffset
      const cached = localMap.get(post.id)
      if (!cached || cached.m !== post.m) {
        const processed = processPost(post)
        localMap.set(processed.id, processed)
        toPut.push(processed)
        batchPut.push(processed)
        handlers.onDocument(processed, 'new')
      } else {
        handlers.onDocument(cached, 'cached')
      }
    }
  }

  // 仅在全部文章已扫描或安全提前断流时判定为完成；意外截断时保持 syncing 状态以便后续 Range 续传
  const isCompleted = Boolean(
    canceledEarly ||
    (meta ? postIndex >= meta.total : postIndex > 0)
  )

  if (isCompleted && !canceledEarly && meta && meta.total > 0) {
    postIndex = meta.total
  }
  reportProgress(true)

  // 终态持久化：完成时 status='completed'，截断时保留 status='syncing'（force=true 确保状态写入 IDB）
  await flushBatch(isCompleted, true)

  return {
    toPut,
    toDelete,
    canceledEarly,
    scannedCount: postIndex,
    totalCount: meta ? meta.total : localMap.size,
    resumed: isPartial,
    finalSyncState: currentSyncState,
  }
}
