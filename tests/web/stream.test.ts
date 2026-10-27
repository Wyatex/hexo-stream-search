import { describe, expect, it, vi } from 'vitest'
import { processPost } from '../../src/web/core/index-store'
import { syncJsonlStream } from '../../src/web/core/stream'
import type { IndexedDoc, SearchProgress } from '../../src/shared/types'

interface FetchOptions {
  status?: number
  onCancel?: () => void
  /** 保持连接不关闭（用于验证提前断流） */
  keepOpen?: boolean
}

function createFetch(chunks: string[], options: FetchOptions = {}): typeof fetch {
  const encoder = new TextEncoder()
  let index = 0

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        // 保持连接打开，等待调用方主动 cancel
        if (!options.keepOpen) controller.close()
        return
      }
      controller.enqueue(encoder.encode(chunks[index++]))
    },
    cancel() {
      options.onCancel?.()
    },
  })

  return (async () =>
    new Response(stream, { status: options.status ?? 200 })) as unknown as typeof fetch
}

function meta(total: number, allIds: string[]): string {
  return `${JSON.stringify({ _type: 'meta', total, allIds })}\n`
}

function article(id: string, m: number, content = 'content'): string {
  return `${JSON.stringify({ id, t: id, u: `/${id}`, m, g: [], k: [], c: content })}\n`
}

describe('syncJsonlStream', () => {
  it('解析元数据与文章数据行', async () => {
    const localMap = new Map<string, IndexedDoc>()
    const progress: SearchProgress[] = []
    const documents: IndexedDoc[] = []

    const result = await syncJsonlStream({
      url: '/search.jsonl',
      localMap,
      handlers: {
        onProgress: (payload) => progress.push(payload),
        onDocument: (doc) => documents.push(doc),
      },
      processPost,
      fetchImpl: createFetch([meta(2, ['b/', 'a/']), article('b/', 2, 'beta'), article('a/', 1, 'alpha')]),
    })

    expect(result.toPut).toHaveLength(2)
    expect(result.toDelete).toHaveLength(0)
    expect(result.canceledEarly).toBe(false)
    expect(result.scannedCount).toBe(2)
    expect(result.totalCount).toBe(2)
    expect(documents).toHaveLength(2)
    expect(localMap.has('a/')).toBe(true)
    expect(progress.at(-1)).toMatchObject({ loaded: 2, total: 2, percent: 100 })
  })

  it('跨数据块的半行会被正确拼接', async () => {
    const localMap = new Map<string, IndexedDoc>()
    const first = JSON.stringify({ id: 'a/', t: 'A', u: '/a/', m: 1, g: [], k: [], c: 'alpha' })

    const result = await syncJsonlStream({
      url: '/search.jsonl',
      localMap,
      handlers: { onDocument: () => {} },
      processPost,
      fetchImpl: createFetch([meta(1, ['a/']), `${first.slice(0, 30)}`, `${first.slice(30)}\n`]),
    })

    expect(result.toPut).toHaveLength(1)
    expect(result.toPut[0].id).toBe('a/')
  })

  it('命中未变更缓存时提前断开连接', async () => {
    const onCancel = vi.fn()
    const cached = processPost({ id: 'a/', t: 'A', u: '/a/', m: 1, g: [], k: [], c: 'alpha' })
    const localMap = new Map<string, IndexedDoc>([['a/', cached]])

    const result = await syncJsonlStream({
      url: '/search.jsonl',
      localMap,
      handlers: { onDocument: () => {} },
      processPost,
      fetchImpl: createFetch([meta(1, ['a/']), article('a/', 1, 'alpha')], { onCancel, keepOpen: true }),
    })

    expect(onCancel).toHaveBeenCalled()
    expect(result.canceledEarly).toBe(true)
    expect(result.toPut).toHaveLength(0)
    expect(result.scannedCount).toBe(1)
  })

  it('服务端已删除的文章进入待删除列表', async () => {
    const cached = processPost({ id: 'gone/', t: 'G', u: '/gone/', m: 1, g: [], k: [], c: 'x' })
    const localMap = new Map<string, IndexedDoc>([['gone/', cached]])
    const removed: string[] = []

    const result = await syncJsonlStream({
      url: '/search.jsonl',
      localMap,
      handlers: {
        onDocument: () => {},
        onDocumentRemoved: (id) => removed.push(id),
      },
      processPost,
      fetchImpl: createFetch([meta(1, ['a/']), article('a/', 1, 'alpha')]),
    })

    expect(result.toDelete).toEqual(['gone/'])
    expect(removed).toEqual(['gone/'])
    expect(localMap.has('gone/')).toBe(false)
  })

  it('内容变更的文章会重新处理', async () => {
    const cached = processPost({ id: 'a/', t: 'A', u: '/a/', m: 1, g: [], k: [], c: 'old' })
    const localMap = new Map<string, IndexedDoc>([['a/', cached]])

    const result = await syncJsonlStream({
      url: '/search.jsonl',
      localMap,
      handlers: { onDocument: () => {} },
      processPost,
      fetchImpl: createFetch([meta(1, ['a/']), article('a/', 2, 'new')]),
    })

    expect(result.toPut).toHaveLength(1)
    expect(result.toPut[0].m).toBe(2)
  })

  it('本地缺失文章时不会提前断流', async () => {
    const onCancel = vi.fn()
    const cached = processPost({ id: 'a/', t: 'A', u: '/a/', m: 1, g: [], k: [], c: 'alpha' })
    const localMap = new Map<string, IndexedDoc>([['a/', cached]])

    const result = await syncJsonlStream({
      url: '/search.jsonl',
      localMap,
      handlers: { onDocument: () => {} },
      processPost,
      fetchImpl: createFetch(
        [meta(2, ['a/', 'b/']), article('a/', 1, 'alpha'), article('b/', 2, 'beta')],
        { onCancel },
      ),
    })

    expect(onCancel).not.toHaveBeenCalled()
    expect(result.canceledEarly).toBe(false)
    expect(result.toPut).toHaveLength(1)
    expect(result.toPut[0].id).toBe('b/')
  })

  it('HTTP 失败时抛出错误', async () => {
    await expect(
      syncJsonlStream({
        url: '/search.jsonl',
        localMap: new Map<string, IndexedDoc>(),
        handlers: { onDocument: () => {} },
        processPost,
        fetchImpl: createFetch([], { status: 404 }),
      }),
    ).rejects.toThrow(/HTTP 404/)
  })
})
