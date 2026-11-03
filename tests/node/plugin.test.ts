/**
 * Node 端 Hexo 插件：路径解析、产物定位、Warehouse 数据提取、生成器注册与入口导出
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as nodeEntry from '../../src/node/index'
import {
  autoRegisterGenerators,
  extractPosts,
  findPackageRoot,
  registerGenerators,
  resolveSearchPath,
  resolveWorkerBundlePath,
  resolveWorkerPath,
  workerBundleCandidates,
} from '../../src/node/plugin'
import type { HexoLike } from '../../src/node/hexo-types'

type Generator = (...args: never[]) => unknown

function createFakeHexo(
  search?: { path?: string; worker?: string },
  root = '/',
): {
  hexo: HexoLike
  generators: Map<string, Generator>
  warn: ReturnType<typeof vi.fn>
} {
  const generators = new Map<string, Generator>()
  const warn = vi.fn()
  const hexo = {
    base_dir: 'E:/site',
    config: { root, search },
    extend: {
      generator: {
        register(name: string, generator: Generator) {
          generators.set(name, generator)
        },
      },
    },
    log: { warn },
  } as unknown as HexoLike

  return { hexo, generators, warn }
}

const tempPaths: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hexo-stream-search-plugin-'))
  tempPaths.push(dir)
  return dir
}

afterEach(() => {
  while (tempPaths.length) {
    const target = tempPaths.pop()
    if (target) fs.rmSync(target, { recursive: true, force: true })
  }
})

describe('配置路径与包内产物定位', () => {
  it('未配置或配置为空白字符串时使用默认输出路径', () => {
    expect(resolveSearchPath(createFakeHexo().hexo)).toBe('search.jsonl')
    expect(resolveWorkerPath(createFakeHexo().hexo)).toBe('search-worker.js')
    expect(resolveSearchPath(createFakeHexo({ path: '   ' }).hexo)).toBe('search.jsonl')
    expect(resolveWorkerPath(createFakeHexo({ worker: '   ' }).hexo)).toBe('search-worker.js')
  })

  it('支持自定义路径并剥离全部前导斜杠', () => {
    const { hexo } = createFakeHexo({ path: '///assets/search.jsonl', worker: '/assets/sw.js' })
    expect(resolveSearchPath(hexo)).toBe('assets/search.jsonl')
    expect(resolveWorkerPath(hexo)).toBe('assets/sw.js')
  })

  it('findPackageRoot 向上查找包含 package.json 的包根目录，超深未命中时原样回退', () => {
    const root = makeTempDir()
    fs.writeFileSync(path.join(root, 'package.json'), '{}')
    const nested = path.join(root, 'dist', 'node')
    fs.mkdirSync(nested, { recursive: true })

    expect(findPackageRoot(nested)).toBe(root)

    // 构造超过 6 层且无 package.json 的深层目录
    const deep = path.join(makeTempDir(), '1', '2', '3', '4', '5', '6', '7')
    fs.mkdirSync(deep, { recursive: true })
    expect(findPackageRoot(deep)).toBe(deep)
  })

  it('resolveWorkerBundlePath 优先返回磁盘上实际存在的候选产物路径', () => {
    const root = makeTempDir()
    fs.writeFileSync(path.join(root, 'package.json'), '{}')
    const nodeDir = path.join(root, 'sub', 'node')
    const siblingWeb = path.join(root, 'sub', 'web')
    fs.mkdirSync(nodeDir, { recursive: true })
    fs.mkdirSync(siblingWeb, { recursive: true })

    const candidates = workerBundleCandidates(nodeDir)
    expect(candidates).toEqual([
      path.resolve(root, 'dist', 'web', 'search-worker.js'),
      path.resolve(nodeDir, '..', 'web', 'search-worker.js'),
    ])

    // 均不存在时回退为第 1 个标准候选路径
    expect(resolveWorkerBundlePath(nodeDir)).toBe(candidates[0])

    // 第 2 个候选存在时返回第 2 个
    fs.writeFileSync(candidates[1], '// sibling worker')
    expect(resolveWorkerBundlePath(nodeDir)).toBe(candidates[1])

    // 第 1 个标准候选也存在时优先返回第 1 个
    fs.mkdirSync(path.dirname(candidates[0]), { recursive: true })
    fs.writeFileSync(candidates[0], '// dist worker')
    expect(resolveWorkerBundlePath(nodeDir)).toBe(candidates[0])
  })
})

describe('extractPosts', () => {
  it('兼容普通数组、toArray()、data 数组以及 Warehouse Query.filter() 返回值', () => {
    expect(extractPosts({ posts: [{ path: 'a/' }] })).toHaveLength(1)
    expect(extractPosts({ posts: { toArray: () => [{ path: 'a/' }, { path: 'b/' }] } })).toHaveLength(2)
    expect(extractPosts({ posts: { data: [{ path: 'a/' }] } })).toHaveLength(1)
    expect(
      extractPosts({
        posts: { filter: (fn: (p: { path: string }) => boolean) => ({ toArray: () => [{ path: 'a/' }].filter(fn) }) },
      }),
    ).toHaveLength(1)
    expect(
      extractPosts({
        posts: { filter: (fn: (p: { path: string }) => boolean) => ({ data: [{ path: 'a/' }].filter(fn) }) },
      }),
    ).toHaveLength(1)
  })

  it('缺少 posts 或无法识别的容器对象返回空数组', () => {
    expect(extractPosts({})).toEqual([])
    expect(extractPosts(undefined)).toEqual([])
    expect(extractPosts({ posts: {} })).toEqual([])
  })
})

describe('生成器注册与 Node 入口导出', () => {
  it('autoRegisterGenerators 在非 Hexo 环境下安全跳过，在合法实例上自动注册', () => {
    expect(autoRegisterGenerators(undefined)).toBe(false)
    expect(autoRegisterGenerators({ config: {}, extend: { generator: {} } } as never)).toBe(false)

    const { hexo, generators } = createFakeHexo()
    expect(autoRegisterGenerators(hexo)).toBe(true)
    expect([...generators.keys()]).toEqual(['search_jsonl', 'search_worker'])
  })

  it('Node 入口模块在无全局 hexo 环境下可安全加载并导出完整公共 API', () => {
    expect(typeof nodeEntry.registerGenerators).toBe('function')
    expect(typeof nodeEntry.autoRegisterGenerators).toBe('function')
    expect(typeof nodeEntry.buildJsonl).toBe('function')
    expect(typeof nodeEntry.cleanText).toBe('function')
  })

  it('search_jsonl 生成器结合站点 root 配置输出 JSONL 内容', () => {
    const { hexo, generators } = createFakeHexo({ path: '/custom.jsonl' }, '/sub/')
    registerGenerators(hexo, { workerBundlePath: 'E:/missing/search-worker.js' })

    const result = generators.get('search_jsonl')!(
      { posts: [{ path: 'hello/', title: 'Hello', content: '<p>body</p>', updated: 1 }] } as never,
    ) as { path: string; data: string }

    expect(result.path).toBe('custom.jsonl')
    const lines = result.data.split('\n')
    expect(JSON.parse(lines[0])).toEqual({ _type: 'meta', total: 1, allIds: ['hello/'], allM: [1] })
    expect(JSON.parse(lines[1])).toMatchObject({ id: 'hello/', u: '/sub/hello/', c: 'body' })
  })

  it('search_worker 生成器在产物缺失时打印警告并跳过（即使无 log 实例也不抛错）', () => {
    const { hexo, generators, warn } = createFakeHexo()
    registerGenerators(hexo, { workerBundlePath: 'E:/missing/search-worker.js' })

    expect(generators.get('search_worker')!()).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)

    // 无 log 属性的最小实例同样安全跳过
    const minimalHexo = { ...hexo, log: undefined }
    registerGenerators(minimalHexo, { workerBundlePath: 'E:/missing/search-worker.js' })
    expect(generators.get('search_worker')!()).toBeUndefined()
  })

  it('search_worker 生成器在产物存在时返回按需打开的文件可读流', async () => {
    const dir = makeTempDir()
    const bundle = path.join(dir, 'worker.js')
    fs.writeFileSync(bundle, '// built worker bundle')

    const { hexo, generators } = createFakeHexo({ worker: '/js/worker.js' })
    registerGenerators(hexo, { workerBundlePath: bundle })

    const result = generators.get('search_worker')!() as {
      path: string
      data: () => NodeJS.ReadableStream
    }
    expect(result.path).toBe('js/worker.js')

    const chunks: Buffer[] = []
    for await (const chunk of result.data()) {
      chunks.push(Buffer.from(chunk))
    }
    expect(Buffer.concat(chunks).toString('utf8')).toBe('// built worker bundle')
  })
})
