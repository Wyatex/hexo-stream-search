import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  autoRegisterGenerators,
  extractPosts,
  registerGenerators,
  resolveSearchPath,
  resolveWorkerPath,
} from '../../src/node/plugin'
import type { HexoLike } from '../../src/node/hexo-types'

type Generator = (...args: never[]) => unknown

function createFakeHexo(search?: { path?: string; worker?: string }): {
  hexo: HexoLike
  generators: Map<string, Generator>
  warn: ReturnType<typeof vi.fn>
} {
  const generators = new Map<string, Generator>()
  const warn = vi.fn()
  const hexo = {
    base_dir: 'E:/site',
    config: { root: '/', search },
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

const tempFiles: string[] = []

afterEach(() => {
  while (tempFiles.length) {
    const file = tempFiles.pop()
    if (file) fs.rmSync(file, { force: true })
  }
})

describe('路径解析', () => {
  it('使用默认路径', () => {
    const { hexo } = createFakeHexo()
    expect(resolveSearchPath(hexo)).toBe('search.jsonl')
    expect(resolveWorkerPath(hexo)).toBe('search-worker.js')
  })

  it('支持站点配置覆盖并去掉前导斜杠', () => {
    const { hexo } = createFakeHexo({ path: '/assets/search.jsonl', worker: '/assets/sw.js' })
    expect(resolveSearchPath(hexo)).toBe('assets/search.jsonl')
    expect(resolveWorkerPath(hexo)).toBe('assets/sw.js')
  })
})

describe('extractPosts', () => {
  it('支持普通数组', () => {
    expect(extractPosts({ posts: [{ path: 'a/' }] })).toHaveLength(1)
  })

  it('支持 Warehouse Query（toArray）', () => {
    const posts = extractPosts({ posts: { toArray: () => [{ path: 'a/' }, { path: 'b/' }] } })
    expect(posts).toHaveLength(2)
  })

  it('支持 data 属性', () => {
    expect(extractPosts({ posts: { data: [{ path: 'a/' }] } })).toHaveLength(1)
  })

  it('支持 Warehouse Query（filter 返回 Query）', () => {
    const posts = extractPosts({
      posts: { filter: (fn: (post: { path: string }) => boolean) => ({ data: [{ path: 'a/' }].filter(fn) }) },
    })
    expect(posts).toHaveLength(1)
  })

  it('缺少 posts 时返回空数组', () => {
    expect(extractPosts({})).toEqual([])
    expect(extractPosts(undefined)).toEqual([])
  })
})

describe('autoRegisterGenerators', () => {
  it('非 Hexo 环境（无 hexo 实例）不注册', () => {
    expect(autoRegisterGenerators(undefined)).toBe(false)
  })

  it('存在 hexo 实例时完成注册', () => {
    const { hexo, generators } = createFakeHexo()
    expect(autoRegisterGenerators(hexo)).toBe(true)
    expect([...generators.keys()]).toEqual(['search_jsonl', 'search_worker'])
  })
})

describe('registerGenerators', () => {
  it('注册 search_jsonl 与 search_worker 两个生成器', () => {
    const { hexo, generators } = createFakeHexo()
    registerGenerators(hexo, { workerBundlePath: 'E:/missing/search-worker.js' })

    expect([...generators.keys()]).toEqual(['search_jsonl', 'search_worker'])
  })

  it('search_jsonl 生成索引文件内容', () => {
    const { hexo, generators } = createFakeHexo()
    registerGenerators(hexo, { workerBundlePath: 'E:/missing/search-worker.js' })

    const generator = generators.get('search_jsonl')!
    const result = generator({ posts: [{ path: 'a/', title: 'A', content: 'x', updated: 1 }] } as never) as {
      path: string
      data: string
    }

    expect(result.path).toBe('search.jsonl')
    expect(JSON.parse(result.data.split('\n')[0])).toMatchObject({ _type: 'meta', total: 1 })
  })

  it('search_worker 在产物缺失时跳过并给出警告', () => {
    const { hexo, generators, warn } = createFakeHexo()
    registerGenerators(hexo, { workerBundlePath: 'E:/missing/search-worker.js' })

    const generator = generators.get('search_worker')!
    expect(generator() as unknown).toBeUndefined()
    expect(warn).toHaveBeenCalled()
  })

  it('search_worker 在产物存在时返回可读流', async () => {
    const file = path.join(os.tmpdir(), `hexo-stream-search-${Date.now()}.js`)
    fs.writeFileSync(file, '// worker')
    tempFiles.push(file)

    const { hexo, generators } = createFakeHexo()
    registerGenerators(hexo, { workerBundlePath: file })

    const generator = generators.get('search_worker')!
    const result = generator() as { path: string; data: () => NodeJS.ReadableStream }
    expect(result.path).toBe('search-worker.js')

    const chunks: Buffer[] = []
    for await (const chunk of result.data()) {
      chunks.push(chunk as Buffer)
    }
    expect(Buffer.concat(chunks).toString()).toBe('// worker')
  })
})
