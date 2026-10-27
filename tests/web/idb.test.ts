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

    await store.clear()
    expect((await store.getAll()).size).toBe(0)
  })
})
