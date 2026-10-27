import { describe, expect, it } from 'vitest'
import { createEngine } from '../../src/web/core/engine'
import { isMetaRecord, parseJsonlLine } from '../../src/web/core/protocol'
import type { WorkerOutboundMessage } from '../../src/shared/types'

function jsonlFetch(lines: string[]): typeof fetch {
  const encoder = new TextEncoder()
  let index = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= lines.length) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(lines[index++]))
    },
  })
  return (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch
}

const SAMPLE = [
  `${JSON.stringify({ _type: 'meta', total: 2, allIds: ['a/', 'b/'] })}\n`,
  `${JSON.stringify({ id: 'a/', t: 'Alpha 文章', u: '/a/', m: 1, g: ['tag'], k: [], c: 'alpha 内容' })}\n`,
  `${JSON.stringify({ id: 'b/', t: 'Beta', u: '/b/', m: 2, g: [], k: [], c: 'beta 内容' })}\n`,
]

describe('protocol', () => {
  it('识别元数据行', () => {
    expect(isMetaRecord({ _type: 'meta', total: 1, allIds: [] })).toBe(true)
    expect(isMetaRecord({ id: 'a/' })).toBe(false)
    expect(isMetaRecord(null)).toBe(false)
  })

  it('解析合法 JSONL 行', () => {
    expect(parseJsonlLine('{"id":"a/"}')).toEqual({ id: 'a/' })
  })

  it('忽略空行与残缺行', () => {
    expect(parseJsonlLine('')).toBeUndefined()
    expect(parseJsonlLine('   ')).toBeUndefined()
    expect(parseJsonlLine('{"id":')).toBeUndefined()
  })
})

describe('engine', () => {
  it('INIT 完成后发出 sync_complete', async () => {
    const messages: WorkerOutboundMessage[] = []
    const engine = createEngine({
      postMessage: (message) => messages.push(message),
      fetchImpl: jsonlFetch(SAMPLE),
    })

    await engine.handleMessage({ type: 'INIT', payload: { url: '/search.jsonl' } })

    const types = messages.map((message) => message.type)
    expect(types).toContain('progress')
    expect(types).toContain('sync_complete')

    const sync = messages.find((message) => message.type === 'sync_complete')!
    expect(sync.payload.totalDocs).toBe(2)
    expect(sync.payload.updatedCount).toBe(2)
    expect(sync.payload.deletedCount).toBe(0)
    expect(sync.payload.canceledEarly).toBe(false)
  })

  it('SEARCH 返回 BM25 结果并回传 requestId', async () => {
    const messages: WorkerOutboundMessage[] = []
    const engine = createEngine({
      postMessage: (message) => messages.push(message),
      fetchImpl: jsonlFetch(SAMPLE),
    })

    await engine.handleMessage({ type: 'INIT', payload: { url: '/search.jsonl' } })
    await engine.handleMessage({ type: 'SEARCH', payload: { query: 'alpha', requestId: 7 } })

    const results = messages.find((message) => message.type === 'search_results')!
    expect(results.payload.requestId).toBe(7)
    expect(results.payload.query).toBe('alpha')
    expect(results.payload.results[0].id).toBe('a/')
    expect(typeof results.payload.elapsedMs).toBe('number')
  })

  it('CLEAR 清空索引并发出 cleared', async () => {
    const messages: WorkerOutboundMessage[] = []
    const engine = createEngine({
      postMessage: (message) => messages.push(message),
      fetchImpl: jsonlFetch(SAMPLE),
    })

    await engine.handleMessage({ type: 'INIT', payload: { url: '/search.jsonl' } })
    expect(engine.index.size).toBe(2)

    await engine.handleMessage({ type: 'CLEAR' })

    expect(messages.at(-1)).toEqual({ type: 'cleared', payload: true })
    expect(engine.index.size).toBe(0)
  })

  it('拉取失败时发出 error', async () => {
    const messages: WorkerOutboundMessage[] = []
    const engine = createEngine({
      postMessage: (message) => messages.push(message),
      fetchImpl: (async () => new Response('', { status: 500 })) as unknown as typeof fetch,
    })

    await engine.handleMessage({ type: 'INIT', payload: { url: '/search.jsonl' } })

    expect(messages.at(-1)?.type).toBe('error')
    expect(String((messages.at(-1) as { payload: string }).payload)).toContain('HTTP 500')
  })

  it('忽略未知消息', async () => {
    const messages: WorkerOutboundMessage[] = []
    const engine = createEngine({ postMessage: (message) => messages.push(message) })

    await engine.handleMessage({ type: 'UNKNOWN' } as never)
    expect(messages).toHaveLength(0)
  })
})
