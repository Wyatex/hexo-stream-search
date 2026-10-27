import fs from 'node:fs'
import path from 'node:path'
import { buildJsonl } from './jsonl'
import { DEFAULT_SEARCH_PATH, DEFAULT_WORKER_PATH } from '../shared/constants'
import type { HexoLike, PostLike } from './hexo-types'

export interface RegisterGeneratorsOptions {
  /** Worker 产物在磁盘上的位置，默认取包内 `dist/web/search-worker.js` */
  workerBundlePath?: string
}

/** 当前模块所在目录（CJS 产物中可用；ESM 环境回退到进程工作目录） */
function currentDir(): string {
  if (typeof __dirname !== 'undefined') return __dirname
  return process.cwd()
}

/** 站点配置的索引文件路径（相对站点根目录） */
export function resolveSearchPath(hexo: HexoLike): string {
  const configured = hexo.config?.search?.path
  const value = (configured && String(configured).trim()) || DEFAULT_SEARCH_PATH
  return value.replace(/^\/+/, '')
}

/** 站点配置的 Worker 文件路径（相对站点根目录） */
export function resolveWorkerPath(hexo: HexoLike): string {
  const configured = hexo.config?.search?.worker
  const value = (configured && String(configured).trim()) || DEFAULT_WORKER_PATH
  return value.replace(/^\/+/, '')
}

/** 向上查找包根目录（含 package.json 的目录） */
export function findPackageRoot(start: string): string {
  let dir = start
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return start
}

/**
 * Worker 产物的候选路径
 *
 * 1. `<包根>/dist/web/search-worker.js`：构建后的标准位置
 * 2. `<模块目录>/../web/search-worker.js`：dist/node → dist/web
 */
export function workerBundleCandidates(baseDir: string = currentDir()): string[] {
  const packageRoot = findPackageRoot(baseDir)
  return [
    path.resolve(packageRoot, 'dist', 'web', DEFAULT_WORKER_PATH),
    path.resolve(baseDir, '..', 'web', DEFAULT_WORKER_PATH),
  ]
}

/** 包内 Worker 产物路径（优先返回已存在的那个） */
export function resolveWorkerBundlePath(baseDir?: string): string {
  const candidates = workerBundleCandidates(baseDir)
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return candidates[0]
}

/** 从 hexo locals 中取出文章数组（兼容 Warehouse Query 与普通数组） */
export function extractPosts(locals: unknown): PostLike[] {
  const posts = (locals as { posts?: unknown } | undefined)?.posts
  if (!posts) return []
  if (Array.isArray(posts)) return posts as PostLike[]

  const source = posts as {
    toArray?: () => unknown
    data?: unknown
    filter?: (predicate: () => boolean) => unknown
  }

  if (typeof source.toArray === 'function') return (source.toArray() as PostLike[]) ?? []
  if (Array.isArray(source.data)) return source.data as PostLike[]

  // Warehouse Query：filter() 返回的仍是 Query，取其 data / toArray()
  if (typeof source.filter === 'function') {
    const filtered = source.filter(() => true) as {
      toArray?: () => unknown
      data?: unknown
    }
    if (filtered && typeof filtered.toArray === 'function') {
      return (filtered.toArray() as PostLike[]) ?? []
    }
    if (filtered && Array.isArray(filtered.data)) return filtered.data as PostLike[]
  }

  return []
}

/**
 * 自动注册（供插件入口调用）
 *
 * Hexo 以 CommonJS 方式执行插件脚本，`hexo` 是脚本作用域内的自由标识符，
 * 因此在非 Hexo 环境下需要显式传入 undefined（此时不做任何事）。
 *
 * @returns 是否完成注册
 */
export function autoRegisterGenerators(hexo?: HexoLike): boolean {
  if (!hexo || typeof hexo.extend?.generator?.register !== 'function') return false
  registerGenerators(hexo)
  return true
}

/**
 * 注册 Hexo 生成器
 *
 * - `search_jsonl`：生成索引文件（默认 `search.jsonl`）
 * - `search_worker`：把包内构建好的 Worker 产物复制到站点根目录（默认 `search-worker.js`）
 */
export function registerGenerators(hexo: HexoLike, options: RegisterGeneratorsOptions = {}): void {
  const searchPath = resolveSearchPath(hexo)
  const workerPath = resolveWorkerPath(hexo)
  const workerBundlePath = options.workerBundlePath ?? resolveWorkerBundlePath()

  hexo.extend.generator.register('search_jsonl', ((locals: unknown) => {
    const posts = extractPosts(locals)
    const data = buildJsonl(posts, { root: hexo.config?.root || '/' })
    return { path: searchPath, data }
  }) as (...args: never[]) => unknown)

  hexo.extend.generator.register('search_worker', (() => {
    if (!fs.existsSync(workerBundlePath)) {
      hexo.log?.warn?.(
        `[hexo-stream-search] 未找到 Worker 产物，跳过生成：${workerBundlePath}（请先执行 pnpm build）`,
      )
      return undefined
    }
    return {
      path: workerPath,
      data: () => fs.createReadStream(workerBundlePath),
    }
  }) as (...args: never[]) => unknown)
}
