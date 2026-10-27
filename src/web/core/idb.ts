import { DB_NAME, DB_VERSION, STORE_NAME } from '../../shared/constants'
import type { IndexedDoc } from '../../shared/types'

export interface PostStore {
  /** 是否为持久化存储（false 表示降级为内存模式） */
  readonly persistent: boolean
  /** 读取全部缓存文章 */
  getAll(): Promise<Map<string, IndexedDoc>>
  /** 写入变更并删除失效文章 */
  apply(toPut: IndexedDoc[], toDelete: string[]): Promise<void>
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
  /** objectStore 名 */
  storeName?: string
}

function openDatabase(
  factory: IDBFactory,
  dbName: string,
  version: number,
  storeName: string,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(dbName, version)
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains(storeName)) {
        db.createObjectStore(storeName, { keyPath: 'id' })
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
): PostStore {
  let dbPromise: Promise<IDBDatabase> | undefined

  const ensureDb = (): Promise<IDBDatabase> => {
    if (!dbPromise) {
      dbPromise = openDatabase(factory, dbName, version, storeName).catch((error) => {
        dbPromise = undefined
        throw error
      })
    }
    return dbPromise
  }

  return {
    persistent: true,

    async getAll(): Promise<Map<string, IndexedDoc>> {
      const db = await ensureDb()
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, 'readonly')
        const store = transaction.objectStore(storeName)
        const request = store.getAll()
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

    async apply(toPut: IndexedDoc[], toDelete: string[]): Promise<void> {
      if (toPut.length === 0 && toDelete.length === 0) return
      const db = await ensureDb()
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(storeName, 'readwrite')
        const store = transaction.objectStore(storeName)
        for (const id of toDelete) store.delete(id)
        for (const item of toPut) store.put(item)
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error ?? new Error('写入 IndexedDB 失败'))
        transaction.onabort = () => reject(transaction.error ?? new Error('写入 IndexedDB 被中止'))
      })
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
}

/** 内存降级实现：IndexedDB 不可用时（隐私模式等）使用 */
function createMemoryStore(): PostStore {
  const cache = new Map<string, IndexedDoc>()
  return {
    persistent: false,
    async getAll() {
      return new Map(cache)
    },
    async apply(toPut, toDelete) {
      for (const id of toDelete) cache.delete(id)
      for (const item of toPut) cache.set(item.id, item)
    },
    async clear() {
      cache.clear()
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

  const factory =
    options.indexedDB ?? (typeof indexedDB !== 'undefined' ? indexedDB : undefined)

  if (!factory) return createMemoryStore()

  try {
    const store = createPersistentStore(factory, dbName, version, storeName)
    // 提前打开一次，尽早暴露不可用的情况并降级
    await store.getAll()
    return store
  } catch {
    return createMemoryStore()
  }
}
