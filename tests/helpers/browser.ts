/**
 * 浏览器会话模拟：多个 Engine 实例共享同一个 IndexedDB，模拟页面刷新 / 重新打开
 */
import { IDBFactory } from 'fake-indexeddb'
import { createEngine, type SearchEngine } from '../../src/web/core/engine'
import { createPostStore } from '../../src/web/core/idb'
import type { IndexedDoc, IndexSyncState, WorkerOutboundMessage } from '../../src/shared/types'
import { DEFAULT_URL } from './jsonl'

export interface Browser {
  indexedDB: IDBFactory
  dbName: string
}

let browserSeq = 0

/** 一个拥有独立 IndexedDB 的“浏览器” */
export function createBrowser(): Browser {
  browserSeq += 1
  return { indexedDB: new IDBFactory(), dbName: `hexo-stream-search-test-${browserSeq}` }
}

type MessageOf<T extends WorkerOutboundMessage['type']> = Extract<WorkerOutboundMessage, { type: T }>

export interface Session {
  engine: SearchEngine
  messages: WorkerOutboundMessage[]
  /** 取第一条指定类型消息的 payload */
  payload<T extends WorkerOutboundMessage['type']>(type: T): MessageOf<T>['payload'] | undefined
}

export function createSession(browser: Browser | undefined, fetchImpl?: typeof fetch): Session {
  const messages: WorkerOutboundMessage[] = []
  const engine = createEngine({
    indexedDB: browser?.indexedDB,
    dbName: browser?.dbName,
    postMessage: (message) => messages.push(message),
    fetchImpl,
  })
  return {
    engine,
    messages,
    payload(type) {
      const found = messages.find((message) => message.type === type)
      return found?.payload as never
    },
  }
}

/** 打开一次页面：创建 Engine 并完成 INIT */
export async function openPage(browser: Browser | undefined, fetchImpl: typeof fetch, url = DEFAULT_URL): Promise<Session> {
  const session = createSession(browser, fetchImpl)
  await session.engine.handleMessage({ type: 'INIT', payload: { url } })
  return session
}

export interface StorageSnapshot {
  docs: Map<string, IndexedDoc>
  state: IndexSyncState | null
}

/** 读取当前 IndexedDB 中持久化的文章与同步状态 */
export async function readStorage(browser: Browser, url = DEFAULT_URL): Promise<StorageSnapshot> {
  const store = await createPostStore({ indexedDB: browser.indexedDB, dbName: browser.dbName })
  return { docs: await store.getAll(), state: await store.getSyncState(url) }
}

/** 预先向 IndexedDB 写入文章与同步状态 */
export async function seedStorage(browser: Browser, docs: IndexedDoc[], state?: IndexSyncState): Promise<void> {
  const store = await createPostStore({ indexedDB: browser.indexedDB, dbName: browser.dbName })
  await store.applyBatch(docs, [], state)
}
