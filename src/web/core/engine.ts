import type { WorkerInboundMessage, WorkerOutboundMessage } from '../../shared/types'
import { createPostStore, type PostStore } from './idb'
import { IndexStore, processPost } from './index-store'
import { syncJsonlStream } from './stream'

export interface EngineOptions {
  /** 向主线程投递消息 */
  postMessage(message: WorkerOutboundMessage): void
  /** 自定义 fetch 实现 */
  fetchImpl?: typeof fetch
  /** 自定义 IndexedDB 实例 */
  indexedDB?: IDBFactory
  /** 数据库名 */
  dbName?: string
  /** 数据库版本 */
  dbVersion?: number
  /** objectStore 名 */
  storeName?: string
  /** 计时函数 */
  now?: () => number
}

export interface SearchEngine {
  /** 处理来自主线程的消息 */
  handleMessage(message: WorkerInboundMessage): Promise<void>
  /** 当前倒排索引 */
  readonly index: IndexStore
}

function defaultNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/**
 * 搜索引擎
 *
 * 组合「IndexedDB 缓存 + 倒排索引 + BM25 检索 + JSONL 流式同步」，
 * 与 Worker 之间只通过消息协议交互，便于单测直接驱动。
 */
export function createEngine(options: EngineOptions): SearchEngine {
  const index = new IndexStore()
  const now = options.now ?? defaultNow
  let store: PostStore | undefined

  const post = (message: WorkerOutboundMessage): void => {
    options.postMessage(message)
  }

  const handleInit = async (url?: string): Promise<void> => {
    const startTime = now()

    try {
      store = await createPostStore({
        indexedDB: options.indexedDB,
        dbName: options.dbName,
        version: options.dbVersion,
        storeName: options.storeName,
      })

      const localMap = await store.getAll()

      // 本地有缓存，立即构建索引实现首屏秒搜
      if (localMap.size > 0) {
        index.buildFrom(localMap.values())
        post({
          type: 'cache_ready',
          payload: {
            count: localMap.size,
            totalTerms: index.termCount,
          },
        })
      }

      // 后台流式拉取增量更新
      const stats = await syncJsonlStream({
        url: url || '/search.jsonl',
        localMap,
        handlers: {
          onDocument(doc, kind) {
            if (kind === 'new') {
              index.addPost(doc)
              return
            }
            if (!index.has(doc.id)) index.addPost(doc)
          },
          onDocumentRemoved(docId) {
            index.removePost(docId)
          },
          onProgress(progress) {
            post({ type: 'progress', payload: progress })
          },
        },
        processPost,
        fetchImpl: options.fetchImpl,
        now,
      })

      // 持久化变更数据到 IndexedDB
      await store.apply(stats.toPut, stats.toDelete)

      // 若有改动或首次加载，重新构建倒排索引
      if (stats.toPut.length > 0 || stats.toDelete.length > 0 || index.size === 0) {
        index.buildFrom(localMap.values())
      }

      post({
        type: 'sync_complete',
        payload: {
          totalDocs: index.size,
          totalTerms: index.termCount,
          updatedCount: stats.toPut.length,
          deletedCount: stats.toDelete.length,
          scannedLines: stats.scannedCount,
          canceledEarly: stats.canceledEarly,
          elapsedMs: Math.round(now() - startTime),
        },
      })
    } catch (error) {
      post({
        type: 'error',
        payload: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const handleSearch = (payload: { query: string; limit?: number; requestId: number }): void => {
    const startTime = now()
    const results = index.search(payload.query, payload.limit || 20)
    const elapsedMs = Number((now() - startTime).toFixed(2))

    post({
      type: 'search_results',
      payload: {
        query: payload.query,
        requestId: payload.requestId,
        results,
        elapsedMs,
      },
    })
  }

  const handleClear = async (): Promise<void> => {
    try {
      if (store) await store.clear()
      index.clear()
      post({ type: 'cleared', payload: true })
    } catch (error) {
      post({
        type: 'error',
        payload: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return {
    index,
    async handleMessage(message: WorkerInboundMessage): Promise<void> {
      if (!message || typeof message !== 'object') return

      switch (message.type) {
        case 'INIT':
          await handleInit(message.payload?.url)
          break
        case 'SEARCH':
          handleSearch(message.payload)
          break
        case 'CLEAR':
          await handleClear()
          break
        default:
          break
      }
    },
  }
}
