/**
 * hexo-stream-search —— Node 端入口
 *
 * 作为 Hexo 插件被自动加载（包名以 `hexo-` 开头），在模块顶层完成生成器注册；
 * 同时导出纯函数，便于脚本化调用与单元测试。
 */
import { autoRegisterGenerators } from './plugin'
import type { HexoLike } from './hexo-types'

export { registerGenerators, autoRegisterGenerators } from './plugin'
export {
  extractPosts,
  findPackageRoot,
  resolveSearchPath,
  resolveWorkerBundlePath,
  resolveWorkerPath,
  workerBundleCandidates,
} from './plugin'
export { buildJsonl, buildJsonlRecords, normalizePostUrl, toTimestamp } from './jsonl'
export { cleanText, stripHtml, unescapeHtml } from './clean'
export type { BuildJsonlOptions } from './jsonl'
export type { RegisterGeneratorsOptions } from './plugin'
export type { HexoLike, HexoSearchConfig, PostLike } from './hexo-types'
export type {
  SearchJsonlRecord,
  SearchMetaRecord,
  SearchPostRecord,
  SearchResult,
} from '../shared/types'

/**
 * Hexo 以 CommonJS 方式执行插件脚本，`hexo` 是脚本作用域内的自由标识符
 * （并非 globalThis.hexo），因此这里只能用自由标识符方式探测。
 */
declare const hexo: HexoLike | undefined

autoRegisterGenerators(typeof hexo !== 'undefined' ? hexo : undefined)
