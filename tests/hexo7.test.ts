import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import Hexo7 from 'hexo-7'
import { registerGenerators } from '../src/node/plugin'
import type { HexoLike } from '../src/node/hexo-types'

const baseDir = mkdtempSync(path.join(os.tmpdir(), 'hexo-stream-search-hexo7-'))

afterAll(() => {
  rmSync(baseDir, { recursive: true, force: true })
})

async function createHexo(): Promise<Hexo7> {
  const hexo = new Hexo7(baseDir, { silent: true })
  await hexo.init()
  hexo.config.root = '/'
  hexo.config.search = { path: 'search.jsonl', worker: 'search-worker.js' }
  registerGenerators(hexo as unknown as HexoLike)
  return hexo
}

describe('Hexo 7 集成', () => {
  it('注册 search_jsonl 与 search_worker 生成器', async () => {
    const hexo = await createHexo()
    const names = Object.keys(hexo.extend.generator.list())
    expect(names).toContain('search_jsonl')
    expect(names).toContain('search_worker')
  })

  it('生成 search.jsonl 索引（首行 meta + 文章数据）', async () => {
    const hexo = await createHexo()
    const Post = hexo.model('Post')

    const post = await Post.insert({
      source: 'stream-search.md',
      slug: 'stream-search',
      title: 'Hexo 流式搜索',
      content: '<p>本文介绍 JSONL 流式搜索与 <strong>BM25</strong> 排序。</p>',
      published: true,
    })
    await post.setTags(['搜索', 'Hexo'])
    await post.setCategories(['技术'])

    // 未发布文章不进入索引
    await Post.insert({
      source: 'draft.md',
      slug: 'draft',
      title: '草稿',
      content: '草稿内容',
      published: false,
    })

    hexo.locals.set('posts', Post.find({}))
    const locals = hexo.locals.toObject() as never

    const generator = hexo.extend.generator.get('search_jsonl')
    const result = (await generator(locals)) as { path: string; data: string }

    expect(result.path).toBe('search.jsonl')

    const lines = result.data.split('\n')
    const meta = JSON.parse(lines[0])
    expect(meta._type).toBe('meta')
    expect(meta.total).toBe(1)
    expect(meta.allIds).toEqual([post.path])

    const article = JSON.parse(lines[1])
    expect(article.id).toBe(post.path)
    expect(article.t).toBe('Hexo 流式搜索')
    expect(article.u).toBe(`/${post.path.replace(/^\//, '')}`)
    expect(article.g).toEqual(['搜索', 'Hexo'])
    expect(article.k).toEqual(['技术'])
    expect(article.c).toBe('本文介绍 JSONL 流式搜索与 BM25 排序。')
    expect(typeof article.m).toBe('number')
    expect(article.m).toBeGreaterThan(0)
  })

  it('站点配置可覆盖索引与 Worker 路径', async () => {
    const hexo = new Hexo7(baseDir, { silent: true })
    await hexo.init()
    hexo.config.root = '/'
    hexo.config.search = { path: '/assets/index.jsonl', worker: '/assets/worker.js' }
    registerGenerators(hexo as unknown as HexoLike)

    const generator = hexo.extend.generator.get('search_jsonl')
    const result = (await generator(hexo.locals.toObject() as never)) as { path: string; data: string }
    expect(result.path).toBe('assets/index.jsonl')
    expect(JSON.parse(result.data.split('\n')[0])).toMatchObject({ _type: 'meta', total: 0 })
  })

  it('search_worker 生成器输出 Worker 产物', async () => {
    const workerFile = path.join(baseDir, 'worker.js')
    writeFileSync(workerFile, '// worker')

    const hexo = new Hexo7(baseDir, { silent: true })
    await hexo.init()
    hexo.config.root = '/'
    hexo.config.search = { worker: 'search-worker.js' }
    registerGenerators(hexo as unknown as HexoLike, { workerBundlePath: workerFile })

    const generator = hexo.extend.generator.get('search_worker')
    const result = (await generator(hexo.locals.toObject() as never)) as {
      path: string
      data: () => NodeJS.ReadableStream
    }

    expect(result.path).toBe('search-worker.js')

    const chunks: Buffer[] = []
    for await (const chunk of result.data()) {
      chunks.push(chunk as Buffer)
    }
    expect(Buffer.concat(chunks).toString()).toBe('// worker')
  })

  it('search_worker 产物缺失时跳过生成且不阻塞构建', async () => {
    const hexo = new Hexo7(baseDir, { silent: true })
    await hexo.init()
    registerGenerators(hexo as unknown as HexoLike, {
      workerBundlePath: path.join(baseDir, 'not-exists.js'),
    })

    const generator = hexo.extend.generator.get('search_worker')
    await expect(generator(hexo.locals.toObject() as never)).resolves.toBeUndefined()
  })
})
