/** BM25 词频饱和度（1.2 ~ 2.0） */
export const BM25_K1 = 1.5

/** BM25 文档长度归一化因子（0 ~ 1） */
export const BM25_B = 0.75

/** 标题词频权重倍率 */
export const TITLE_WEIGHT = 4.0

/** 标签词频权重 */
export const TAG_WEIGHT = 3.0

/** 分类词频权重 */
export const CATEGORY_WEIGHT = 2.5

/** 正文词频权重 */
export const CONTENT_WEIGHT = 1.0

/** 标题包含完整检索词加成 */
export const EXACT_TITLE_BOOST = 8.0

/** 正文包含完整检索词加成 */
export const EXACT_PHRASE_BOOST = 4.0

/** 命中全部查询分词时的倍率加成 */
export const ALL_TERMS_MATCH_BOOST = 1.6

/** 摘要窗口大小（字符） */
export const SNIPPET_WINDOW = 130

/** 进度上报节流间隔（毫秒） */
export const PROGRESS_THROTTLE_MS = 40

/**
 * 高频停用词表（仅在多词查询时过滤，避免单字泛滥影响排序与高亮）
 */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '一个',
  '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好',
  '自己', '这', '那', '与', '及', '等', '或', '之', '为', '以', '所', '对',
  'a', 'an', 'the', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'is',
])

/** IndexedDB 数据库名（与旧版 search-worker.js 保持一致，可复用既有缓存） */
export const DB_NAME = 'HexoBlogSearchDB'

/** IndexedDB 版本 */
export const DB_VERSION = 1

/** IndexedDB 文章 objectStore 名 */
export const STORE_NAME = 'posts'

/** IndexedDB 元数据与断点状态 objectStore 名 */
export const META_STORE_NAME = 'meta'

/** 分批持久化默认文档批次大小 */
export const DEFAULT_BATCH_SIZE = 50

/** 分批持久化默认刷新最大时间间隔（毫秒） */
export const DEFAULT_BATCH_INTERVAL_MS = 500

/** 默认的索引文件路径 */
export const DEFAULT_SEARCH_PATH = 'search.jsonl'

/** 默认的 Worker 文件路径 */
export const DEFAULT_WORKER_PATH = 'search-worker.js'
