/**
 * JSONL 第 1 行：全局元数据（Meta Header）
 *
 * 作用：告诉前端当前全站有哪些合法文章，用于清理本地缓存中已被删除的文章，
 * 以及判断本地缓存是否完整（缺失文章的位置决定增量拉取的起点）。
 */
export interface SearchMetaRecord {
  _type: 'meta'
  /** 全站文章总数 */
  total: number
  /** 所有有效文章的 ID 集合（顺序与数据行一致，按更新时间降序） */
  allIds: string[]
}

/**
 * JSONL 文章数据行（字段名压缩以减小体积）
 *
 * id 唯一主键（post.path）/ t 标题 / u 链接 / m 修改时间戳 / g 标签 / k 分类 / c 纯文本正文
 */
export interface SearchPostRecord {
  id: string
  t: string
  u: string
  m: number
  g: string[]
  k: string[]
  c: string
}

export type SearchJsonlRecord = SearchMetaRecord | SearchPostRecord

/** 倒排索引中的文档：在 JSONL 记录基础上附加加权词频与有效长度 */
export interface IndexedDoc extends SearchPostRecord {
  /** 有效文档长度（各字段 token 数 × 权重之和） */
  dl: number
  /** 加权词频表 */
  tf: Record<string, number>
}

/** 单条搜索结果 */
export interface SearchResult {
  id: string
  title: string
  url: string
  updated: number
  tags: string[]
  categories: string[]
  score: number
  snippet: string
}

/** 流式同步进度 */
export interface SearchProgress {
  /** 已扫描到的文章数（从 0 开始真实计数） */
  loaded: number
  /** 全站文章总数 */
  total: number
  /** 百分比（0 - 100） */
  percent: number
  /** 本次发生变更的文章数 */
  updated: number
  /** 本次扫描的文章数 */
  scanned: number
}

/** 本地缓存就绪 */
export interface CacheReadyPayload {
  count: number
  totalTerms: number
}

/** 同步完成 */
export interface SyncCompletePayload {
  totalDocs: number
  totalTerms: number
  updatedCount: number
  deletedCount: number
  scannedLines: number
  canceledEarly: boolean
  elapsedMs: number
}

/** 检索结果 */
export interface SearchResultsPayload {
  query: string
  requestId: number
  results: SearchResult[]
  elapsedMs: number
}

/** 主线程 → Worker 的指令 */
export type WorkerInboundMessage =
  | { type: 'INIT'; payload?: { url?: string } }
  | { type: 'SEARCH'; payload: { query: string; limit?: number; requestId: number } }
  | { type: 'CLEAR' }

/** Worker → 主线程的事件 */
export type WorkerOutboundMessage =
  | { type: 'cache_ready'; payload: CacheReadyPayload }
  | { type: 'progress'; payload: SearchProgress }
  | { type: 'sync_complete'; payload: SyncCompletePayload }
  | { type: 'search_results'; payload: SearchResultsPayload }
  | { type: 'cleared'; payload: boolean }
  | { type: 'error'; payload: string }
