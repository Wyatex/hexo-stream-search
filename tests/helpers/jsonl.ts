/**
 * JSONL 索引测试夹具：构造 meta 行 / 文章行 / 本地缓存文档 / 同步状态
 */
import { processPost } from '../../src/web/core/index-store'
import type {
  IndexedDoc,
  IndexSyncState,
  SearchMetaRecord,
  SearchPostRecord,
} from '../../src/shared/types'

export const DEFAULT_URL = '/search.jsonl'
export const DEFAULT_SYNC_KEY = `sync_state:${DEFAULT_URL}`

const encoder = new TextEncoder()

export function encode(text: string): Uint8Array {
  return encoder.encode(text)
}

export function byteLength(text: string): number {
  return encoder.encode(text).byteLength
}

/** 返回每个 `\n` 之后的字节偏移（即每一行的结束位置） */
export function lineEndOffsets(bytes: Uint8Array): number[] {
  const offsets: number[] = []
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 10) offsets.push(i + 1)
  }
  return offsets
}

export function metaRecord(allIds: string[], allM?: number[]): SearchMetaRecord {
  return { _type: 'meta', total: allIds.length, allIds, ...(allM ? { allM } : {}) }
}

/** JSONL 第 1 行（total 默认等于 allIds.length） */
export function metaLine(allIds: string[], allM?: number[], eol = '\n'): string {
  return `${JSON.stringify(metaRecord(allIds, allM))}${eol}`
}

export function postRecord(id: string, m: number, overrides: Partial<SearchPostRecord> = {}): SearchPostRecord {
  return { id, t: `Title ${id}`, u: `/${id}`, m, g: [], k: [], c: `content ${id}`, ...overrides }
}

export function postLine(
  id: string,
  m: number,
  overrides: Partial<SearchPostRecord> = {},
  eol = '\n',
): string {
  return `${JSON.stringify(postRecord(id, m, overrides))}${eol}`
}

/** 已写入本地缓存的索引文档 */
export function cachedDoc(id: string, m: number, overrides: Partial<SearchPostRecord> = {}): IndexedDoc {
  return processPost(postRecord(id, m, overrides))
}

export function cacheOf(docs: IndexedDoc[]): Map<string, IndexedDoc> {
  return new Map(docs.map((doc) => [doc.id, doc]))
}

export function syncStateOf(overrides: Partial<IndexSyncState> = {}): IndexSyncState {
  return {
    key: DEFAULT_SYNC_KEY,
    url: DEFAULT_URL,
    byteOffset: 0,
    status: 'syncing',
    updatedAt: 0,
    ...overrides,
  }
}

export interface SiteOptions {
  /** 文章 ID 前缀，默认 `post-` */
  prefix?: string
  /** 第 i 篇文章的修改时间戳，默认 `1000 + i` */
  m?: (i: number) => number
  /** 第 i 篇文章的额外字段 */
  post?: (i: number) => Partial<SearchPostRecord>
  /** 行尾，默认 `\n` */
  eol?: string
}

export interface Site {
  ids: string[]
  ms: number[]
  /** lines[0] 为 meta，lines[i + 1] 为第 i 篇文章 */
  lines: string[]
  text: string
  bytes: Uint8Array
  /** lineEnds[n] = meta + 前 n 篇文章的字节长度（n = 0 表示仅 meta 行） */
  lineEnds: number[]
}

/** 构造一个完整站点的 JSONL 索引 */
export function buildSite(count: number, options: SiteOptions = {}): Site {
  const prefix = options.prefix ?? 'post-'
  const eol = options.eol ?? '\n'
  const ids = Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(3, '0')}/`)
  const ms = ids.map((_, i) => (options.m ? options.m(i) : 1000 + i))
  const lines = [
    metaLine(ids, ms, eol),
    ...ids.map((id, i) => postLine(id, ms[i], options.post?.(i) ?? {}, eol)),
  ]
  const text = lines.join('')
  const bytes = encode(text)
  return { ids, ms, lines, text, bytes, lineEnds: lineEndOffsets(bytes) }
}
