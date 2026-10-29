import { DB_NAME, DB_VERSION, META_STORE_NAME, STORE_NAME } from '../../shared/constants'
import type { IndexedDoc, IndexSyncState } from '../../shared/types'

export interface PostStore {
  /** 是否为持久化存储（false 表示降级为内存模式） */
  readonly persistent: boolean
  /** 读取全部缓存文章 */
  getAll(): Promise<Map<string, IndexedDoc>>
  /** 写入变更并删除失效文章 */
  apply(toPut: IndexedDoc[], toDelete: string[]): Promise<void>
  /** 读取同步持久化状态 */
  getSyncState(key: string): Promise<IndexSyncState | null>
  /** 写入同步持久化状态 */
  setSyncState?(state: IndexSyncState): Promise<void>
  /** 原子批量提交文章与同步状态（同一 IDB 事务跨 stores） */
  applyBatch(toPut: IndexedDoc[], toDelete: string[], syncState?: IndexSyncState): Promise<void>
  /** 清空缓存 */
  clear(): Promise<void>
}

export interface PostStoreOptions {
  /** IndexedDB 实例，默认取全局 indexedDB */
  indexedDB?: IDBFactory
  /** 数据库名 */
  dbName?: string
  /** 数据库版本 */
  version?: number
  /** 文章 objectStore 名 */
  storeName?: string
  /** 元数据与断点状态 objectStore 名 */
  metaStoreName?: string
}

function openDatabase(
  factory: IDBFactory,
  dbName: string,
  version: number,
  storeName: string,
  metaStoreName: string = META_STORE_NAME,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(dbName, version)
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains(storeName)) {
        db.createObjectStore(storeName, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(metaStoreName)) {
        db.createObjectStore(metaStoreName, { keyPath: 'key' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('打开 IndexedDB 失败'))
    request.onblocked = () => reject(new Error('IndexedDB 升级被其他连接阻塞'))
  })
}

function createPersistentStore(
  factory: IDBFactory,
  dbName: string,
  version: number,
  storeName: string,
  metaStoreName: string = META_STORE_NAME,
): PostStore {
  let dbPromise: Promise<IDBDatabase> | undefined

  const ensureDb = (): Promise<IDBDatabase> => {
    if (!dbPromise) {
      dbPromise = openDatabase(factory, dbName, version, storeName, metaStoreName).catch((error) => {
        dbPromise = undefined
        throw error
      })
    }
    return dbPromise
  }

  const store: PostStore = {
    persistent: true,

    async getAll(): Promise<Map<string, IndexedDoc>> {
      const db = await ensureDb()
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, 'readonly')
        const objStore = transaction.objectStore(storeName)
        const request = objStore.getAll()
        request.onsuccess = () => {
          const map = new Map<string, IndexedDoc>()
          for (const item of request.result as IndexedDoc[]) {
            map.set(item.id, item)
          }
          resolve(map)
        }
        request.onerror = () => reject(request.error ?? new Error('读取 IndexedDB 失败'))
      })
    },

    async getSyncState(key: string): Promise<IndexSyncState | null> {
      const db = await ensureDb()
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(metaStoreName, 'readonly')
        const objStore = transaction.objectStore(metaStoreName)
        const request = objStore.get(key)
        request.onsuccess = () => {
          if (request.result) {
            resolve(request.result as IndexSyncState)
            return
          }
          // 尝试兼容无前缀或带前缀的 key
          const altKey = key.startsWith('sync_state:')
            ? key.slice('sync_state:'.length)
            : `sync_state:${key}`
          const req2 = objStore.get(altKey)
          req2.onsuccess = () => {
            resolve((req2.result as IndexSyncState) ?? null)
          }
          req2.onerror = () => reject(req2.error ?? new Error('读取 SyncState 失败'))
        }
        request.onerror = () => reject(request.error ?? new Error('读取 SyncState 失败'))
      })
    },

    async applyBatch(toPut: IndexedDoc[], toDelete: string[], syncState?: IndexSyncState): Promise<void> {
      if (toPut.length === 0 && toDelete.length === 0 && !syncState) return
      const db = await ensureDb()
      return new Promise<void>((resolve, reject) => {
        const stores = [storeName, metaStoreName]
        const tx = db.transaction(stores, 'readwrite')
        const postStore = tx.objectStore(storeName)
        const metaStore = tx.objectStore(metaStoreName)

        for (const id of toDelete) postStore.delete(id)
        for (const item of toPut) postStore.put(item)
        if (syncState) {
          metaStore.put({
            ...syncState,
            completed: syncState.status === 'completed',
          })
        }

        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error ?? new Error('写入 IndexedDB 失败'))
        tx.onabort = () => reject(tx.error ?? new Error('写入 IndexedDB 被中止'))
      })
    },

    async apply(toPut: IndexedDoc[], toDelete: string[]): Promise<void> {
      return store.applyBatch(toPut, toDelete)
    },

    async setSyncState(state: IndexSyncState): Promise<void> {
      return store.applyBatch([], [], state)
    },

    async clear(): Promise<void> {
      // 先关闭已有连接，否则删除请求会被阻塞
      const db = await dbPromise?.catch(() => undefined)
      db?.close()
      dbPromise = undefined

      await new Promise<void>((resolve, reject) => {
        const request = factory.deleteDatabase(dbName)
        request.onsuccess = () => resolve()
        request.onerror = () => reject(request.error ?? new Error('删除 IndexedDB 失败'))
        request.onblocked = () => resolve()
      })
    },
  }

  return store
}

/** 内存降级实现：IndexedDB 不可用时（隐私模式等）使用 */
function createMemoryStore(): PostStore {
  const cache = new Map<string, IndexedDoc>()
  const metaCache = new Map<string, IndexSyncState>()
  return {
    persistent: false,
    async getAll() {
      return new Map(cache)
    },
    async apply(toPut, toDelete) {
      for (const id of toDelete) cache.delete(id)
      for (const item of toPut) cache.set(item.id, item)
    },
    async getSyncState(key: string) {
      if (metaCache.has(key)) return metaCache.get(key)!
      const altKey = key.startsWith('sync_state:')
        ? key.slice('sync_state:'.length)
        : `sync_state:${key}`
      return metaCache.get(altKey) ?? null
    },
    async setSyncState(state: IndexSyncState) {
      metaCache.set(state.key, { ...state, completed: state.status === 'completed' })
    },
    async applyBatch(toPut, toDelete, syncState) {
      for (const id of toDelete) cache.delete(id)
      for (const item of toPut) cache.set(item.id, item)
      if (syncState) {
        metaCache.set(syncState.key, { ...syncState, completed: syncState.status === 'completed' })
      }
    },
    async clear() {
      cache.clear()
      metaCache.clear()
    },
  }
}

/**
 * 创建文章缓存存储
 *
 * IndexedDB 可用时使用持久化存储；不可用（隐私模式 / 环境不支持）时自动降级为内存模式，
 * 接口与行为保持一致，仅不跨会话持久化。
 */
export async function createPostStore(options: PostStoreOptions = {}): Promise<PostStore> {
  const dbName = options.dbName ?? DB_NAME
  const version = options.version ?? DB_VERSION
  const storeName = options.storeName ?? STORE_NAME
  const metaStoreName = options.metaStoreName ?? META_STORE_NAME

  const factory =
    options.indexedDB ?? (typeof indexedDB !== 'undefined' ? indexedDB : undefined)

  if (!factory) return createMemoryStore()

  try {
    const store = createPersistentStore(factory, dbName, version, storeName, metaStoreName)
    // 提前打开一次，尽早暴露不可用的情况并降级
    await store.getAll()
    return store
  } catch {
    return createMemoryStore()
  }
}
