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
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createSearchClient', () => {
  it('init 发送 INIT 指令', () => {
    const worker = new FakeWorker()
    const client = createSearchClient({
      workerUrl: '/search-worker.js',
      jsonlUrl: '/search.jsonl',
      workerFactory: () => worker,
    })

    client.init()
    expect(worker.posted[0]).toEqual({ type: 'INIT', payload: { url: '/search.jsonl' } })
  })

  it('重复 init 不会重复创建 Worker', () => {
    const worker = new FakeWorker()
    const factory = vi.fn(() => worker)
    const client = createSearchClient({ workerUrl: '/search-worker.js', workerFactory: factory })

    client.init()
    client.init()
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('search 带防抖', () => {
    const worker = new FakeWorker()
    const client = createSearchClient({
      workerUrl: '/search-worker.js',
      debounceMs: 90,
      workerFactory: () => worker,
    })

    client.init()
    client.search('  typescript  ')
    expect(worker.posted).toHaveLength(1)

    vi.advanceTimersByTime(90)
    const search = worker.posted.at(-1)!
    expect(search.type).toBe('SEARCH')
    const payload = (search as { type: 'SEARCH'; payload: { query: string; limit: number } }).payload
    expect(payload).toMatchObject({ query: 'typescript', limit: 20 })
  })

  it('空查询不发起检索', () => {
    const worker = new FakeWorker()
    const client = createSearchClient({ workerUrl: '/search-worker.js', workerFactory: () => worker })

    client.init()
    client.search('   ')
    vi.advanceTimersByTime(200)
    expect(worker.posted.filter((message) => message.type === 'SEARCH')).toHaveLength(0)
  })

  it('丢弃过期请求的结果', () => {
    const worker = new FakeWorker()
    const onResults = vi.fn()
    const client = createSearchClient({
      workerUrl: '/search-worker.js',
      debounceMs: 0,
      workerFactory: () => worker,
      onResults,
    })

    client.init()
    client.search('first')
    vi.advanceTimersByTime(0)
    client.search('second')
    vi.advanceTimersByTime(0)

    const requests = worker.posted.filter((message) => message.type === 'SEARCH')
    const firstId = (requests[0].payload as { requestId: number }).requestId
    const secondId = (requests[1].payload as { requestId: number }).requestId
    expect(secondId).toBeGreaterThan(firstId)

    worker.emit({
      type: 'search_results',
      payload: { query: 'first', requestId: firstId, results: [], elapsedMs: 1 },
    })
    expect(onResults).not.toHaveBeenCalled()

    worker.emit({
      type: 'search_results',
      payload: { query: 'second', requestId: secondId, results: [], elapsedMs: 1 },
    })
    expect(onResults).toHaveBeenCalledTimes(1)
  })

  it('同步期间自动重搜当前关键词', () => {
    const worker = new FakeWorker()
    const client = createSearchClient({
      workerUrl: '/search-worker.js',
      debounceMs: 0,
      autoRefreshDebounceMs: 180,
      workerFactory: () => worker,
    })

    client.init()
    client.search('typescript')
    vi.advanceTimersByTime(0)

    const before = worker.posted.filter((message) => message.type === 'SEARCH').length
    worker.emit({ type: 'progress', payload: { loaded: 1, total: 10, percent: 10, updated: 0, scanned: 1 } })
    vi.advanceTimersByTime(180)

    const after = worker.posted.filter((message) => message.type === 'SEARCH').length
    expect(after).toBe(before + 1)
  })

  it('同步完成后做一次最终检索', () => {
    const worker = new FakeWorker()
    const client = createSearchClient({
      workerUrl: '/search-worker.js',
      debounceMs: 0,
      workerFactory: () => worker,
    })

    client.init()
    client.search('typescript')
    vi.advanceTimersByTime(0)

    const before = worker.posted.filter((message) => message.type === 'SEARCH').length
    worker.emit({
      type: 'sync_complete',
      payload: {
        totalDocs: 10,
        totalTerms: 100,
        updatedCount: 1,
        deletedCount: 0,
        scannedLines: 10,
        canceledEarly: false,
        elapsedMs: 12,
      },
    })

    const after = worker.posted.filter((message) => message.type === 'SEARCH').length
    expect(after).toBe(before + 1)
    expect(client.state.syncing).toBe(false)
    expect(client.state.total).toBe(10)
  })

  it('clearCache 在收到 cleared 后 resolve', async () => {
    const worker = new FakeWorker()
    const client = createSearchClient({ workerUrl: '/search-worker.js', workerFactory: () => worker })

    client.init()
    const promise = client.clearCache()
    expect(worker.posted.at(-1)).toEqual({ type: 'CLEAR' })

    worker.emit({ type: 'cleared', payload: true })
    await expect(promise).resolves.toBeUndefined()
  })

  it('destroy 终止 Worker', () => {
    const worker = new FakeWorker()
    const client = createSearchClient({ workerUrl: '/search-worker.js', workerFactory: () => worker })

    client.init()
    client.destroy()
    expect(worker.terminated).toBe(true)
  })

  it('错误信息透传给调用方', () => {
    const worker = new FakeWorker()
    const onError = vi.fn()
    const client = createSearchClient({
      workerUrl: '/search-worker.js',
      workerFactory: () => worker,
      onError,
    })

    client.init()
    worker.emit({ type: 'error', payload: '拉取索引失败' })
    expect(onError).toHaveBeenCalledWith('拉取索引失败')
  })
})
