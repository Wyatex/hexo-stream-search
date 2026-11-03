/**
 * 浏览器 Worker 入口接线：验证全局作用域 onmessage / postMessage 与搜索引擎的双向桥接
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkerOutboundMessage } from '../../src/shared/types'
import { jsonlFetch } from '../helpers/http'
import { metaLine, postLine } from '../helpers/jsonl'

describe('search-worker 入口接线', () => {
  const originalFetch = globalThis.fetch
  const scope = globalThis as unknown as {
    onmessage?: ((event: { data: unknown }) => Promise<void>) | null
    postMessage?: (message: unknown) => void
  }
  const originalOnMessage = scope.onmessage
  const originalPostMessage = scope.postMessage

  afterEach(() => {
    globalThis.fetch = originalFetch
    scope.onmessage = originalOnMessage
    scope.postMessage = originalPostMessage
    vi.resetModules()
  })

  it('通过 globalThis.onmessage 接收主线程指令并经由 globalThis.postMessage 回传事件', async () => {
    const outbound: WorkerOutboundMessage[] = []
    scope.postMessage = (msg) => outbound.push(msg as WorkerOutboundMessage)
    globalThis.fetch = jsonlFetch([
      metaLine(['hello/'], [100]),
      postLine('hello/', 100, { t: 'Worker Entry', c: 'wired message bridge' }),
    ]).fetch

    await import('../../src/web/worker')
    expect(typeof scope.onmessage).toBe('function')

    await scope.onmessage!({ data: { type: 'INIT', payload: { url: '/search.jsonl' } } })
    await scope.onmessage!({ data: { type: 'SEARCH', payload: { query: 'bridge', requestId: 1 } } })
    await scope.onmessage!({ data: { type: 'CLEAR' } })

    const types = outbound.map((m) => m.type)
    expect(types).toContain('sync_complete')
    expect(types).toContain('search_results')
    expect(types.at(-1)).toBe('cleared')

    const searchRes = outbound.find((m) => m.type === 'search_results')!
    expect(searchRes.payload.results[0].id).toBe('hello/')
  })
})
