/**
 * PostStore 存储层：IndexedDB 持久化（posts + meta 双仓库原子事务）与异常内存降级
 */
import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import { createPostStore } from '../../src/web/core/idb'
import { cachedDoc, syncStateOf } from '../helpers/jsonl'

describe('createPostStore', () => {
  describe('IndexedDB 持久化模式', () => {
    it('支持文章写入、删除、清空以及清空后重新打开写入', async () => {
      const store = await createPostStore({
        indexedDB: new IDBFactory(),
        dbName: 'idb-crud-test',
      })

      expect(store.persistent).toBe(true)
      expect((await store.getAll()).size).toBe(0)

      await store.apply([cachedDoc('a/', 1), cachedDoc('b/', 2)], [])
      expect([...(await store.getAll()).keys()].sort()).toEqual(['a/', 'b/'])

      await store.apply([cachedDoc('c/', 3)], ['a/'])
      expect([...(await store.getAll()).keys()].sort()).toEqual(['b/', 'c/'])

      await store.clear()
      expect((await store.getAll()).size).toBe(0)

      // 清空删除数据库后再次写入应自动重新建库
      await store.apply([cachedDoc('reopened/', 9)], [])
      expect((await store.getAll()).has('reopened/')).toBe(true)
    })

    it('完整保留 IndexedDoc 的加权词频与文档长度字段', async () => {
      const store = await createPostStore({
        indexedDB: new IDBFactory(),
        dbName: 'idb-fields-test',
      })

      await store.apply([cachedDoc('a/', 7, { t: 'TypeScript', c: 'stream search' })], [])
      const saved = (await store.getAll()).get('a/')!

      expect(saved.id).toBe('a/')
      expect(saved.m).toBe(7)
      expect(saved.dl).toBeGreaterThan(0)
      expect(saved.tf.typescript).toBeGreaterThan(0)
    })

    it('meta 仓库支持带前缀与不带前缀的双向兼容查询 syncState', async () => {
      const store = await createPostStore({
        indexedDB: new IDBFactory(),
        dbName: 'idb-syncstate-test',
      })

      expect(await store.getSyncState('/search.jsonl')).toBeNull()

      const state = syncStateOf({
        key: 'sync_state:/search.jsonl',
        url: '/search.jsonl',
        byteOffset: 45_210,
        etag: '"etag-123"',
        lastModified: 'Wed, 28 Oct 2026 09:00:00 GMT',
        status: 'syncing',
        meta: { _type: 'meta', total: 2, allIds: ['a/', 'b/'], allM: [200, 100] },
        updatedAt: 1_730_000_000_000,
      })

      await store.setSyncState?.(state)

      const expected = { ...state, completed: false }
      expect(await store.getSyncState('sync_state:/search.jsonl')).toEqual(expected)
      expect(await store.getSyncState('/search.jsonl')).toEqual(expected)

      // 若存储时使用不带前缀的 key，通过带前缀的 key 也能查出
      await store.setSyncState?.(syncStateOf({ key: '/custom.jsonl', url: '/custom.jsonl', status: 'completed' }))
      expect((await store.getSyncState('sync_state:/custom.jsonl'))?.completed).toBe(true)
    })

    it('applyBatch 在单事务内原子提交文章增删与 syncState 更新（空批次直接跳过）', async () => {
      const store = await createPostStore({
        indexedDB: new IDBFactory(),
        dbName: 'idb-batch-test',
      })

      // 空操作不抛错
      await store.applyBatch([], [])
      expect((await store.getAll()).size).toBe(0)

      await store.applyBatch(
        [cachedDoc('x/', 1), cachedDoc('y/', 2)],
        [],
        syncStateOf({ byteOffset: 800, status: 'syncing' }),
      )
      expect((await store.getAll()).size).toBe(2)
      expect((await store.getSyncState('/search.jsonl'))?.byteOffset).toBe(800)

      await store.applyBatch(
        [cachedDoc('z/', 3)],
        ['x/'],
        syncStateOf({ byteOffset: 1600, status: 'completed' }),
      )

      expect([...(await store.getAll()).keys()].sort()).toEqual(['y/', 'z/'])
      expect(await store.getSyncState('/search.jsonl')).toMatchObject({
        byteOffset: 1600,
        status: 'completed',
        completed: true,
      })
    })
  })

  describe('异常环境自动降级为内存模式（MemoryStore）', () => {
    it('indexedDB 未定义时降级为内存模式且保持完整接口一致', async () => {
      const store = await createPostStore({ indexedDB: undefined })
      expect(store.persistent).toBe(false)

      await store.apply([cachedDoc('a/', 1)], [])
      // getAll 返回防御性副本，外部修改不影响内部存储
      const copy = await store.getAll()
      copy.clear()
      expect((await store.getAll()).size).toBe(1)

      expect(await store.getSyncState('/search.jsonl')).toBeNull()
      await store.applyBatch([cachedDoc('b/', 2)], ['a/'], syncStateOf({ byteOffset: 120, status: 'syncing' }))

      expect([...(await store.getAll()).keys()]).toEqual(['b/'])
      expect(await store.getSyncState('/search.jsonl')).toMatchObject({
        byteOffset: 120,
        status: 'syncing',
        completed: false,
      })

      await store.setSyncState?.(syncStateOf({ byteOffset: 240, status: 'completed' }))
      expect((await store.getSyncState('sync_state:/search.jsonl'))?.completed).toBe(true)

      await store.clear()
      expect((await store.getAll()).size).toBe(0)
      expect(await store.getSyncState('/search.jsonl')).toBeNull()
    })

    it('indexedDB.open 同步抛出 SecurityError（严格隐私模式）时优雅降级', async () => {
      const rejectingFactory = {
        open() {
          throw new DOMException('Access to IndexedDB is denied.', 'SecurityError')
        },
      } as unknown as IDBFactory

      const store = await createPostStore({ indexedDB: rejectingFactory })
      expect(store.persistent).toBe(false)

      await store.applyBatch([cachedDoc('p/', 1)], [], syncStateOf({ byteOffset: 64 }))
      expect((await store.getAll()).has('p/')).toBe(true)
      expect((await store.getSyncState('/search.jsonl'))?.byteOffset).toBe(64)
    })

    it('indexedDB.open 异步触发 onerror（配额超限或磁盘故障）时优雅降级', async () => {
      const errorFactory = {
        open() {
          const req: Record<string, unknown> = {
            onerror: null,
            onsuccess: null,
            error: new DOMException('Quota exceeded', 'QuotaExceededError'),
          }
          setTimeout(() => {
            if (typeof req.onerror === 'function') req.onerror({ target: req })
          }, 0)
          return req
        },
      } as unknown as IDBFactory

      const store = await createPostStore({ indexedDB: errorFactory })
      expect(store.persistent).toBe(false)
      expect((await store.getAll()).size).toBe(0)
    })

    it('indexedDB.open 触发 onblocked（升级被阻塞）时优雅降级', async () => {
      const blockedFactory = {
        open() {
          const req: Record<string, unknown> = { onblocked: null, onsuccess: null, onerror: null }
          setTimeout(() => {
            if (typeof req.onblocked === 'function') req.onblocked({})
          }, 0)
          return req
        },
      } as unknown as IDBFactory

      const store = await createPostStore({ indexedDB: blockedFactory })
      expect(store.persistent).toBe(false)
    })

    it('数据库打开成功但首次事务读取损坏抛错时优雅降级', async () => {
      const realFactory = new IDBFactory()
      const brokenTxFactory = {
        open(...args: Parameters<typeof realFactory.open>) {
          const req = realFactory.open(...args)
          return new Proxy(req, {
            get(target, prop, receiver) {
              if (prop === 'result') {
                const db = Reflect.get(target, prop, receiver)
                if (!db) return db
                return new Proxy(db, {
                  get(dbTarget, dbProp, dbReceiver) {
                    if (dbProp === 'transaction') {
                      return () => {
                        throw new DOMException('Corrupted store', 'UnknownError')
                      }
                    }
                    return Reflect.get(dbTarget, dbProp, dbReceiver)
                  },
                })
              }
              return Reflect.get(target, prop, receiver)
            },
          })
        },
      } as unknown as IDBFactory

      const store = await createPostStore({ indexedDB: brokenTxFactory, dbName: 'corrupted-db' })
      expect(store.persistent).toBe(false)
      await store.apply([cachedDoc('ok/', 1)], [])
      expect((await store.getAll()).size).toBe(1)
    })
  })
})
