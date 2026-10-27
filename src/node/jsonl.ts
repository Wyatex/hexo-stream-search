import { cleanText } from './clean'
import type { PostLike } from './hexo-types'
import type { SearchJsonlRecord, SearchMetaRecord, SearchPostRecord } from '../shared/types'

export interface BuildJsonlOptions {
  /** 站点根路径，默认 `/` */
  root?: string
}

/** 把 moment.js 对象 / 时间戳统一转换为毫秒时间戳 */
export function toTimestamp(value?: number | { valueOf(): number } | null): number {
  if (value === null || value === undefined) return 0
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  const result = value.valueOf()
  return typeof result === 'number' && Number.isFinite(result) ? result : 0
}

function postTimestamp(post: PostLike): number {
  return toTimestamp(post.updated ?? post.date)
}

/** 规范化文章链接：以 `/` 开头则原样，否则拼接站点根路径，并折叠重复斜杠 */
export function normalizePostUrl(postPath: string, root = '/'): string {
  const safeRoot = root || '/'
  const url = postPath.startsWith('/') ? postPath : `${safeRoot}${postPath}`
  return url.replace(/\/+/g, '/')
}

/**
 * 构建 JSONL 记录列表
 *
 * 第 1 条为全局元数据（Meta Header），其余为文章数据行，按更新时间降序排列。
 */
export function buildJsonlRecords(posts: PostLike[], options: BuildJsonlOptions = {}): SearchJsonlRecord[] {
  const root = options.root || '/'

  const list = (posts ?? [])
    .filter((post) => post && post.indexing !== false && post.published !== false)
    .slice()
    .sort((a, b) => postTimestamp(b) - postTimestamp(a))

  const meta: SearchMetaRecord = {
    _type: 'meta',
    total: list.length,
    allIds: list.map((post) => post.path),
  }

  const records: SearchJsonlRecord[] = [meta]

  for (const post of list) {
    const record: SearchPostRecord = {
      id: post.path,
      t: cleanText(post.title) || 'Untitled',
      u: normalizePostUrl(post.path, root),
      m: postTimestamp(post),
      g: (post.tags ?? []).map((tag) => tag?.name).filter((name): name is string => !!name),
      k: (post.categories ?? []).map((cat) => cat?.name).filter((name): name is string => !!name),
      c: cleanText(post.content),
    }
    records.push(record)
  }

  return records
}

/**
 * 构建 `search.jsonl` 文本内容
 *
 * 每行一个 JSON 记录，第 1 行是元数据，其余是文章数据。
 */
export function buildJsonl(posts: PostLike[], options: BuildJsonlOptions = {}): string {
  return buildJsonlRecords(posts, options)
    .map((record) => JSON.stringify(record))
    .join('\n')
}
