/** Hexo 站点配置中与搜索相关的部分 */
export interface HexoSearchConfig {
  /** 索引文件路径（相对站点根目录），默认 `search.jsonl` */
  path?: string
  /** Worker 文件路径（相对站点根目录），默认 `search-worker.js` */
  worker?: string
  /** 是否启用，默认启用 */
  enable?: boolean
  /** 索引字段（兼容 hexo-generator-searchdb 的配置项） */
  field?: string
}

/** Hexo 实例的最小结构描述（只声明本包用到的部分） */
export interface HexoLike {
  base_dir?: string
  config: {
    root?: string
    search?: HexoSearchConfig
    [key: string]: unknown
  }
  extend: {
    generator: {
      register(name: string, generator: (...args: never[]) => unknown): void
    }
  }
  log?: {
    warn?: (message: string) => void
    error?: (message: string) => void
  }
}

/** 文章对象的最小结构描述（兼容 Hexo 的 Post 模型） */
export interface PostLike {
  /** 唯一路径，同时作为搜索索引的主键 */
  path: string
  title?: string
  content?: string
  date?: number | { valueOf(): number }
  updated?: number | { valueOf(): number }
  tags?: Array<{ name?: string }>
  categories?: Array<{ name?: string }>
  /** 显式关闭索引 */
  indexing?: boolean
  /** 未发布 */
  published?: boolean
}
