import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import { createPostStore } from '../../src/web/core/idb'
import { processPost } from '../../src/web/core/index-store'

function doc(id: string, m = 1) {
  return processPost({ id, t: id, u: `/${id}`, m, g: [], k: [], c: `content ${id}` })
}

describe('createPostStore', () => {
  it('IndexedDB 可用时使用持久化存储', async () => {
    const store = await createPostStore({
      indexedDB: new IDBFactory(),
      dbName: 'hexo-stream-search-test-1',
      version: 1,
    })

    expect(store.persistent).toBe(true)
    expect((await store.getAll()).size).toBe(0)

    await store.apply([doc('a'), doc('b')], [])
    const map = await store.getAll()
    expect([...map.keys()].sort()).toEqual(['a', 'b'])

    await store.apply([doc('c')], ['a'])
    expect([...(await store.getAll()).keys()].sort()).toEqual(['b', 'c'])

    await store.clear()
    expect((await store.getAll()).size).toBe(0)
  })

  it('保存的文档保留索引字段', async () => {
    const store = await createPostStore({
      indexedDB: new IDBFactory(),
      dbName: 'hexo-stream-search-test-2',
      version: 1,
    })

    await store.apply([doc('a', 7)], [])
    const cached = (await store.getAll()).get('a')!
    expect(cached.id).toBe('a')
    expect(cached.m).toBe(7)
    expect(cached.dl).toBeGreaterThan(0)
    expect(Object.keys(cached.tf).length).toBeGreaterThan(0)
  })

  it('IndexedDB 不可用时降级为内存模式', async () => {
    const store = await createPostStore({ indexedDB: undefined })

    expect(store.persistent).toBe(false)
    await store.apply([doc('a')], [])
    expect((await store.getAll()).size).toBe(1)

    // 内存模式下支持 getSyncState 与 applyBatch
    expect(await store.getSyncState('/search.jsonl')).toBeNull()
    await store.applyBatch(
      [doc('b')],
      [],
      {
        key: 'sync_state:/search.jsonl',
        url: '/search.jsonl',
        byteOffset: 120,
        status: 'syncing',
        updatedAt: Date.now(),
      },
    )
    const memSyncState = await store.getSyncState('/search.jsonl')
    expect(memSyncState).not.toBeNull()
    expect(memSyncState?.byteOffset).toBe(120)
    expect(memSyncState?.status).toBe('syncing')
    expect(memSyncState?.completed).toBe(false)
    expect((await store.getAll()).size).toBe(2)

    await store.clear()
    expect((await store.getAll()).size).toBe(0)
    expect(await store.getSyncState('/search.jsonl')).toBeNull()
  })

  it('支持在 meta 仓库中存储与读取 syncState (持久化模式)', async () => {
    const factory = new IDBFactory()
    const store = await createPostStore({
      indexedDB: factory,
      dbName: 'hexo-stream-search-test-syncstate',
      version: 1,
    })

    expect(await store.getSyncState('/search.jsonl')).toBeNull()

    const state = {
      key: 'sync_state:/search.jsonl',
      url: '/search.jsonl',
      byteOffset: 45210,
      etag: '"test-etag-123"',
      lastModified: 'Wed, 28 Oct 2026 09:00:00 GMT',
      status: 'syncing' as const,
      meta: {
        _type: 'meta' as const,
        total: 50,
        allIds: ['a/', 'b/'],
        allM: [200, 100],
      },
      updatedAt: 1730000000000,
    }

    await store.setSyncState?.(state)

    // 支持通过完整 key 或 url 查询
    const byKey = await store.getSyncState('sync_state:/search.jsonl')
    const byUrl = await store.getSyncState('/search.jsonl')

    expect(byKey).toEqual({
      ...state,
      completed: false,
    })
    expect(byUrl).toEqual({
      ...state,
      completed: false,
    })
  })

  it('applyBatch 支持原子批量提交文章与 syncState', async () => {
    const factory = new IDBFactory()
    const store = await createPostStore({
      indexedDB: factory,
      dbName: 'hexo-stream-search-test-batch',
      version: 1,
    })

    await store.applyBatch(
      [doc('x', 1), doc('y', 2)],
      [],
      {
        key: 'sync_state:/search.jsonl',
        url: '/search.jsonl',
        byteOffset: 800,
        status: 'syncing',
        updatedAt: Date.now(),
      },
    )

    const map = await store.getAll()
    expect(map.size).toBe(2)
    expect(map.get('x')?.m).toBe(1)
    expect(map.get('y')?.m).toBe(2)

    const state = await store.getSyncState('/search.jsonl')
    expect(state?.byteOffset).toBe(800)
    expect(state?.status).toBe('syncing')

    // 下一批更新：删除 x，添加 z，更新 syncState 为 completed
    await store.applyBatch(
      [doc('z', 3)],
      ['x'],
      {
        key: 'sync_state:/search.jsonl',
        url: '/search.jsonl',
        byteOffset: 1600,
        status: 'completed',
        updatedAt: Date.now(),
      },
    )

    const updatedMap = await store.getAll()
    expect([...updatedMap.keys()].sort()).toEqual(['y', 'z'])
    const updatedState = await store.getSyncState('/search.jsonl')
    expect(updatedState?.byteOffset).toBe(1600)
    expect(updatedState?.status).toBe('completed')
    expect(updatedState?.completed).toBe(true)
  })
})
