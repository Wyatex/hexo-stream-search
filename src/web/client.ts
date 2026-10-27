import type {
  CacheReadyPayload,
  SearchProgress,
  SearchResultsPayload,
  SyncCompletePayload,
  WorkerInboundMessage,
  WorkerOutboundMessage,
} from '../shared/types'

/** Worker 的最小结构描述（便于注入自定义实现与单元测试） */
export interface SearchWorkerLike {
  postMessage(message: WorkerInboundMessage): void
  terminate(): void
  onmessage: ((event: { data: WorkerOutboundMessage }) => void) | null
  onerror?: ((event: unknown) => void) | null
}

export interface SearchClientOptions {
  /** Worker 脚本地址，例如 `/search-worker.js` */
  workerUrl: string
  /** 索引文件地址，默认 `/search.jsonl` */
  jsonlUrl?: string
  /** 单次返回结果数量，默认 20 */
  limit?: number
  /** 输入防抖间隔（毫秒），默认 90 */
  debounceMs?: number
  /** 同步期间是否自动重搜当前关键词，默认 true */
  autoRefreshWhileSyncing?: boolean
  /** 同步期间自动重搜的防抖间隔（毫秒），默认 180 */
  autoRefreshDebounceMs?: number
  /** 自定义 Worker 工厂 */
  workerFactory?: (url: string) => SearchWorkerLike
  /** 本地缓存就绪 */
  onCacheReady?: (payload: CacheReadyPayload) => void
  /** 流式同步进度 */
  onProgress?: (payload: SearchProgress) => void
  /** 同步完成 */
  onSyncComplete?: (payload: SyncCompletePayload) => void
  /** 检索结果 */
  onResults?: (payload: SearchResultsPayload) => void
  /** 错误 */
  onError?: (message: string) => void
}

export interface SearchClientState {
  /** 是否已有可检索的文章 */
  ready: boolean
  /** 是否仍在同步中 */
  syncing: boolean
  /** 已加载文章数 */
  loaded: number
  /** 全站文章总数 */
  total: number
}

export interface SearchClient {
  /** 创建 Worker 并开始同步 */
  init(): void
  /** 触发一次检索（带防抖） */
  search(query: string): void
  /** 清空 IndexedDB 缓存 */
  clearCache(): Promise<void>
  /** 销毁 Worker */
  destroy(): void
  /** 当前状态 */
  readonly state: SearchClientState
}

function defaultWorkerFactory(url: string): SearchWorkerLike {
  return new Worker(url) as unknown as SearchWorkerLike
}

/**
 * 主线程搜索客户端（与 DOM 无关）
 *
 * 负责 Worker 生命周期、输入防抖、请求竞态（requestId）以及同步期间的自动重搜，
 * 具体渲染逻辑交由调用方实现。
 */
export function createSearchClient(options: SearchClientOptions): SearchClient {
  const limit = options.limit ?? 20
  const debounceMs = options.debounceMs ?? 90
  const autoRefreshWhileSyncing = options.autoRefreshWhileSyncing ?? true
  const autoRefreshDebounceMs = options.autoRefreshDebounceMs ?? 180
  const workerFactory = options.workerFactory ?? defaultWorkerFactory

  let worker: SearchWorkerLike | undefined
  let requestId = 0
  let lastQuery = ''
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  let clearResolver: (() => void) | undefined

  const state: SearchClientState = {
    ready: false,
    syncing: false,
    loaded: 0,
    total: 0,
  }

  const post = (message: WorkerInboundMessage): void => {
    worker?.postMessage(message)
  }

  const doSearch = (query: string): void => {
    if (!query) return
    requestId += 1
    post({
      type: 'SEARCH',
      payload: { query, limit, requestId },
    })
  }

  const scheduleAutoRefresh = (query: string): void => {
    // 仅在同步尚未完成时自动重搜，避免与最终检索重复
    if (!autoRefreshWhileSyncing || !state.syncing || !query) return
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      if (lastQuery === query && state.syncing) doSearch(query)
    }, autoRefreshDebounceMs)
  }

  const handleMessage = (message: WorkerOutboundMessage): void => {
    if (!message || typeof message !== 'object') return

    switch (message.type) {
      case 'cache_ready': {
        state.ready = true
        state.syncing = true
        if (!state.total) state.total = message.payload.count
        options.onCacheReady?.(message.payload)
        break
      }

      case 'progress': {
        if (message.payload.loaded > 0) state.ready = true
        state.syncing = true
        state.loaded = message.payload.loaded
        state.total = message.payload.total
        options.onProgress?.(message.payload)
        scheduleAutoRefresh(lastQuery)
        break
      }

      case 'sync_complete': {
        state.ready = true
        state.syncing = false
        state.loaded = message.payload.totalDocs || state.loaded
        state.total = message.payload.totalDocs || state.total
        options.onSyncComplete?.(message.payload)
        // 全站同步完成后做一次最终检索，确保结果完整
        if (lastQuery) doSearch(lastQuery)
        break
      }

      case 'search_results': {
        // 仅渲染最新一次请求的结果，避免竞态覆盖
        if (message.payload.requestId === requestId) {
          options.onResults?.(message.payload)
        }
        break
      }

      case 'cleared': {
        state.ready = false
        state.loaded = 0
        clearResolver?.()
        clearResolver = undefined
        break
      }

      case 'error': {
        options.onError?.(message.payload)
        break
      }

      default:
        break
    }
  }

  const init = (): void => {
    if (worker) return
    worker = workerFactory(options.workerUrl)
    worker.onmessage = (event: { data: WorkerOutboundMessage }) => handleMessage(event.data)
    worker.onerror = (event: unknown) => {
      options.onError?.(event instanceof Error ? event.message : 'Worker 发生错误')
    }
    state.syncing = true
    post({
      type: 'INIT',
      payload: { url: options.jsonlUrl ?? '/search.jsonl' },
    })
  }

  const search = (query: string): void => {
    const trimmed = (query || '').trim()
    if (searchTimer) clearTimeout(searchTimer)

    if (!trimmed) {
      lastQuery = ''
      return
    }

    lastQuery = trimmed
    searchTimer = setTimeout(() => doSearch(trimmed), debounceMs)
  }

  const clearCache = (): Promise<void> => {
    if (!worker) return Promise.resolve()
    return new Promise<void>((resolve) => {
      clearResolver = resolve
      post({ type: 'CLEAR' })
    })
  }

  const destroy = (): void => {
    if (searchTimer) clearTimeout(searchTimer)
    if (refreshTimer) clearTimeout(refreshTimer)
    searchTimer = undefined
    refreshTimer = undefined
    worker?.terminate()
    worker = undefined
    requestId = 0
    lastQuery = ''
  }

  return {
    init,
    search,
    clearCache,
    destroy,
    get state(): SearchClientState {
      return { ...state }
    },
  }
}
