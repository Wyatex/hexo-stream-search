/**
 * 主线程搜索客户端：Worker 生命周期、防抖与竞态控制、同步期间自动重搜及状态快照
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSearchClient, type SearchWorkerLike } from '../../src/web/client'
import type { WorkerInboundMessage, WorkerOutboundMessage } from '../../src/shared/types'

class FakeWorker implements SearchWorkerLike {
  onmessage: ((event: { data: WorkerOutboundMessage }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  posted: WorkerInboundMessage[] = []
  terminated = false

  postMessage(message: WorkerInboundMessage): void {
    this.posted.push(message)
  }

  terminate(): void {
    this.terminated = true
  }

  emit(data: WorkerOutboundMessage): void {
    this.onmessage?.({ data })
  }

  fail(error: unknown): void {
    this.onerror?.(error)
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createSearchClient', () => {
  describe('初始化与生命周期', () => {
    it('init 创建 Worker 并发送 INIT 指令（默认 jsonlUrl 为 /search.jsonl）', () => {
      const worker = new FakeWorker()
      const client = createSearchClient({
        workerUrl: '/search-worker.js',
        workerFactory: () => worker,
      })

      expect(client.state).toEqual({ ready: false, syncing: false, loaded: 0, total: 0 })
      client.init()

      expect(worker.posted).toEqual([{ type: 'INIT', payload: { url: '/search.jsonl' } }])
      expect(client.state.syncing).toBe(true)
    })

    it('活跃状态下重复调用 init 幂等，destroy 后允许重新 init', () => {
      const workers: FakeWorker[] = []
      const factory = vi.fn(() => {
        const w = new FakeWorker()
        workers.push(w)
        return w
      })
      const client = createSearchClient({
        workerUrl: '/search-worker.js',
        jsonlUrl: '/assets/index.jsonl',
        workerFactory: factory,
      })

      client.init()
      client.init()
      expect(factory).toHaveBeenCalledTimes(1)
      expect(workers[0].posted[0]).toEqual({ type: 'INIT', payload: { url: '/assets/index.jsonl' } })

      client.destroy()
      expect(workers[0].terminated).toBe(true)

      client.init()
      expect(factory).toHaveBeenCalledTimes(2)
    })

    it('state 属性返回防御性浅拷贝，外部篡改不影响内部状态', () => {
      const worker = new FakeWorker()
      const client = createSearchClient({ workerUrl: '/sw.js', workerFactory: () => worker })

      const snap = client.state
      snap.ready = true
      snap.total = 999
      expect(client.state).toEqual({ ready: false, syncing: false, loaded: 0, total: 0 })
    })

    it('destroy 清理待执行的防抖与自动重搜定时器，不会向已终止的 Worker 发消息', () => {
      const worker = new FakeWorker()
      const client = createSearchClient({
        workerUrl: '/sw.js',
        debounceMs: 100,
        autoRefreshDebounceMs: 200,
        workerFactory: () => worker,
      })

      client.init()
      client.search('hexo')
      worker.emit({ type: 'progress', payload: { loaded: 5, total: 10, percent: 50, updated: 5, scanned: 5 } })
      client.destroy()

      vi.advanceTimersByTime(500)
      expect(worker.posted.filter((m) => m.type === 'SEARCH')).toEqual([])
    })
  })

  describe('输入防抖与请求竞态（requestId）', () => {
    it('连续快速输入合并为最后一次检索，并传入配置的 limit', () => {
      const worker = new FakeWorker()
      const client = createSearchClient({
        workerUrl: '/sw.js',
        limit: 10,
        debounceMs: 90,
        workerFactory: () => worker,
      })

      client.init()
      client.search('ty')
      vi.advanceTimersByTime(50)
      client.search('  typescript  ')
      vi.advanceTimersByTime(50)
      expect(worker.posted.filter((m) => m.type === 'SEARCH')).toHaveLength(0)

      vi.advanceTimersByTime(40)
      const searches = worker.posted.filter((m) => m.type === 'SEARCH')
      expect(searches).toHaveLength(1)
      expect(searches[0].payload).toEqual({ query: 'typescript', limit: 10, requestId: 1 })
    })

    it('清空输入框会取消尚未触发的防抖检索，且后续同步完成不再触发旧词检索', () => {
      const worker = new FakeWorker()
      const client = createSearchClient({
        workerUrl: '/sw.js',
        debounceMs: 100,
        workerFactory: () => worker,
      })

      client.init()
      client.search('obsolete')
      vi.advanceTimersByTime(50)
      client.search('   ')
      vi.advanceTimersByTime(200)

      worker.emit({
        type: 'sync_complete',
        payload: {
          totalDocs: 5,
          totalTerms: 20,
          updatedCount: 5,
          deletedCount: 0,
          scannedLines: 5,
          canceledEarly: false,
          elapsedMs: 10,
        },
      })

      expect(worker.posted.filter((m) => m.type === 'SEARCH')).toEqual([])
    })

    it('按 requestId 丢弃乱序返回的旧请求结果，仅透传最新请求结果', () => {
      const worker = new FakeWorker()
      const onResults = vi.fn()
      const client = createSearchClient({
        workerUrl: '/sw.js',
        debounceMs: 0,
        workerFactory: () => worker,
        onResults,
      })

      client.init()
      client.search('first')
      vi.advanceTimersByTime(0)
      client.search('second')
      vi.advanceTimersByTime(0)

      const [firstReq, secondReq] = worker.posted.filter((m) => m.type === 'SEARCH')
      worker.emit({
        type: 'search_results',
        payload: { query: 'first', requestId: firstReq.payload.requestId, results: [], elapsedMs: 5 },
      })
      expect(onResults).not.toHaveBeenCalled()

      worker.emit({
        type: 'search_results',
        payload: { query: 'second', requestId: secondReq.payload.requestId, results: [], elapsedMs: 2 },
      })
      expect(onResults).toHaveBeenCalledTimes(1)
      expect(onResults).toHaveBeenCalledWith(expect.objectContaining({ query: 'second' }))
    })
  })

  describe('同步状态流转与自动重搜', () => {
    it('cache_ready、progress 与 sync_complete 驱动状态转换并触发对应回调', () => {
      const worker = new FakeWorker()
      const onCacheReady = vi.fn()
      const onProgress = vi.fn()
      const onSyncComplete = vi.fn()

      const client = createSearchClient({
        workerUrl: '/sw.js',
        workerFactory: () => worker,
        onCacheReady,
        onProgress,
        onSyncComplete,
      })

      client.init()
      worker.emit({ type: 'cache_ready', payload: { count: 10, totalTerms: 80 } })
      expect(client.state).toEqual({ ready: true, syncing: true, loaded: 0, total: 10 })
      expect(onCacheReady).toHaveBeenCalledWith({ count: 10, totalTerms: 80 })

      worker.emit({ type: 'progress', payload: { loaded: 15, total: 20, percent: 75, updated: 5, scanned: 15 } })
      expect(client.state).toEqual({ ready: true, syncing: true, loaded: 15, total: 20 })
      expect(onProgress).toHaveBeenCalledTimes(1)

      worker.emit({
        type: 'sync_complete',
        payload: {
          totalDocs: 20,
          totalTerms: 150,
          updatedCount: 10,
          deletedCount: 0,
          scannedLines: 20,
          canceledEarly: false,
          elapsedMs: 30,
        },
      })
      expect(client.state).toEqual({ ready: true, syncing: false, loaded: 20, total: 20 })
      expect(onSyncComplete).toHaveBeenCalledTimes(1)
    })

    it('同步期间收到 progress 自动防抖重搜；若期间已 sync_complete 则不重复触发定时器检索', () => {
      const worker = new FakeWorker()
      const client = createSearchClient({
        workerUrl: '/sw.js',
        debounceMs: 0,
        autoRefreshDebounceMs: 180,
        workerFactory: () => worker,
      })

      client.init()
      client.search('stream')
      vi.advanceTimersByTime(0)
      expect(worker.posted.filter((m) => m.type === 'SEARCH')).toHaveLength(1)

      // 第一次 progress 触发自动重搜
      worker.emit({ type: 'progress', payload: { loaded: 3, total: 10, percent: 30, updated: 3, scanned: 3 } })
      vi.advanceTimersByTime(180)
      expect(worker.posted.filter((m) => m.type === 'SEARCH')).toHaveLength(2)

      // 第二次 progress 后立即收到 sync_complete：sync_complete 做一次最终检索，之前挂起的 refreshTimer 到期不再重复发
      worker.emit({ type: 'progress', payload: { loaded: 8, total: 10, percent: 80, updated: 8, scanned: 8 } })
      worker.emit({
        type: 'sync_complete',
        payload: {
          totalDocs: 10,
          totalTerms: 50,
          updatedCount: 10,
          deletedCount: 0,
          scannedLines: 10,
          canceledEarly: false,
          elapsedMs: 25,
        },
      })
      expect(worker.posted.filter((m) => m.type === 'SEARCH')).toHaveLength(3)

      vi.advanceTimersByTime(300)
      expect(worker.posted.filter((m) => m.type === 'SEARCH')).toHaveLength(3)
    })

    it('autoRefreshWhileSyncing 设为 false 时同步进度不触发自动重搜，仅在完成时检索', () => {
      const worker = new FakeWorker()
      const client = createSearchClient({
        workerUrl: '/sw.js',
        debounceMs: 0,
        autoRefreshWhileSyncing: false,
        workerFactory: () => worker,
      })

      client.init()
      client.search('bm25')
      vi.advanceTimersByTime(0)
      expect(worker.posted.filter((m) => m.type === 'SEARCH')).toHaveLength(1)

      worker.emit({ type: 'progress', payload: { loaded: 5, total: 10, percent: 50, updated: 5, scanned: 5 } })
      vi.advanceTimersByTime(500)
      expect(worker.posted.filter((m) => m.type === 'SEARCH')).toHaveLength(1)

      worker.emit({
        type: 'sync_complete',
        payload: {
          totalDocs: 10,
          totalTerms: 40,
          updatedCount: 10,
          deletedCount: 0,
          scannedLines: 10,
          canceledEarly: false,
          elapsedMs: 15,
        },
      })
      expect(worker.posted.filter((m) => m.type === 'SEARCH')).toHaveLength(2)
    })
  })

  describe('缓存清理与错误处理', () => {
    it('未初始化时 clearCache 立即 resolve；初始化后等待 cleared 事件再 resolve 并重置就绪态', async () => {
      const worker = new FakeWorker()
      const client = createSearchClient({ workerUrl: '/sw.js', workerFactory: () => worker })

      await expect(client.clearCache()).resolves.toBeUndefined()

      client.init()
      worker.emit({ type: 'cache_ready', payload: { count: 5, totalTerms: 20 } })
      expect(client.state.ready).toBe(true)

      const clearing = client.clearCache()
      expect(worker.posted.at(-1)).toEqual({ type: 'CLEAR' })

      worker.emit({ type: 'cleared', payload: true })
      await expect(clearing).resolves.toBeUndefined()
      expect(client.state).toMatchObject({ ready: false, loaded: 0 })
    })

    it('透传 Worker error 消息与底层 onerror 异常，忽略非法消息结构', () => {
      const worker = new FakeWorker()
      const onError = vi.fn()
      const client = createSearchClient({
        workerUrl: '/sw.js',
        workerFactory: () => worker,
        onError,
      })

      client.init()
      worker.emit(null as never)
      worker.emit({ type: 'UNKNOWN' } as never)
      expect(onError).not.toHaveBeenCalled()

      worker.emit({ type: 'error', payload: '拉取索引失败: HTTP 500' })
      worker.fail(new Error('Script load failed'))
      worker.fail({ type: 'error' })

      expect(onError.mock.calls).toEqual([
        ['拉取索引失败: HTTP 500'],
        ['Script load failed'],
        ['Worker 发生错误'],
      ])
    })
  })
})
