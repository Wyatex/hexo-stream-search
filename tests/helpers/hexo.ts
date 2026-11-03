/**
 * Hexo 真实实例集成测试套件工厂：供 Hexo 7 与 Hexo 8 共享同一套完整契约验证
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { registerGenerators } from '../../src/node/plugin'
import type { HexoLike, HexoSearchConfig } from '../../src/node/hexo-types'
import { createBrowser, openPage } from './browser'
import { jsonlFetch } from './http'

interface HexoModelPost {
  path: string
  setTags(tags: string[]): Promise<void>
  setCategories(categories: string[]): Promise<void>
}

interface HexoInstance {
  config: {
    root: string
    search?: HexoSearchConfig
    [key: string]: unknown
  }
  locals: {
    set(name: string, value: unknown): void
    toObject(): unknown
  }
  extend: {
    generator: {
      list(): Record<string, unknown>
      get(name: string): (locals: never) => Promise<unknown> | unknown
    }
  }
  init(): Promise<void>
  model(name: 'Post'): {
    insert(data: Record<string, unknown>): Promise<HexoModelPost>
    find(query: Record<string, unknown>): unknown
  }
}

type HexoConstructor = new (base: string, args?: { silent?: boolean }) => HexoInstance

export function defineHexoIntegrationSuite(suiteName: string, HexoCtor: HexoConstructor): void {
  const baseDir = mkdtempSync(path.join(os.tmpdir(), 'hexo-stream-search-it-'))

  afterAll(() => {
    rmSync(baseDir, { recursive: true, force: true })
  })

  async function createSite(
    options: { root?: string; search?: HexoSearchConfig; workerBundlePath?: string } = {},
  ): Promise<HexoInstance> {
    const hexo = new HexoCtor(baseDir, { silent: true })
    await hexo.init()
    hexo.config.root = options.root ?? '/'
    hexo.config.search = options.search ?? { path: 'search.jsonl', worker: 'search-worker.js' }
    registerGenerators(
      hexo as unknown as HexoLike,
      options.workerBundlePath ? { workerBundlePath: options.workerBundlePath } : undefined,
    )
    return hexo
  }

  describe(suiteName, () => {
    it('注册 search_jsonl 与 search_worker 两个生成器', async () => {
      const hexo = await createSite()
      const names = Object.keys(hexo.extend.generator.list())
      expect(names).toContain('search_jsonl')
      expect(names).toContain('search_worker')
    })

    it('生成完整 JSONL 索引（排除草稿与 indexing=false 文章）并可被前端引擎直接检索', async () => {
      const hexo = await createSite({ root: '/blog/' })
      const Post = hexo.model('Post')

      const published = await Post.insert({
        source: 'stream-search.md',
        slug: 'stream-search',
        title: 'Hexo 流式搜索',
        content: '<p>本文介绍 JSONL 流式搜索与 <strong>BM25</strong> 排序。</p>',
        published: true,
      })
      await published.setTags(['搜索', 'Hexo'])
      await published.setCategories(['技术'])

      await Post.insert({
        source: 'draft.md',
        slug: 'draft',
        title: '草稿文章',
        content: '草稿内容不应被索引',
        published: false,
      })

      await Post.insert({
        source: 'hidden.md',
        slug: 'hidden',
        title: '隐藏文章',
        content: '显式关闭索引的文章',
        published: true,
        indexing: false,
      })

      hexo.locals.set('posts', Post.find({}))
      const generator = hexo.extend.generator.get('search_jsonl')
      const result = (await generator(hexo.locals.toObject() as never)) as { path: string; data: string }

      expect(result.path).toBe('search.jsonl')
      const lines = result.data.split('\n')
      expect(lines).toHaveLength(2)

      const meta = JSON.parse(lines[0])
      expect(meta).toMatchObject({
        _type: 'meta',
        total: 1,
        allIds: [published.path],
      })
      expect(meta.allM).toHaveLength(1)

      const article = JSON.parse(lines[1])
      expect(article).toMatchObject({
        id: published.path,
        t: 'Hexo 流式搜索',
        u: `/blog/${published.path.replace(/^\/+/, '')}`,
        g: ['搜索', 'Hexo'],
        k: ['技术'],
        c: '本文介绍 JSONL 流式搜索与 BM25 排序。',
      })
      expect(article.m).toBe(meta.allM[0])

      // 端到端闭环：将真实 Hexo 生成的索引直接喂给 Web 检索引擎
      const session = await openPage(createBrowser(), jsonlFetch([result.data]).fetch)
      const hits = session.engine.index.search('BM25 流式', 5)
      expect(hits).toHaveLength(1)
      expect(hits[0].id).toBe(published.path)
      expect(hits[0].url).toBe(article.u)
    })

    it('多篇文章按更新时间降序输出且 allIds 与数据行顺序严格一致', async () => {
      const hexo = await createSite()
      const Post = hexo.model('Post')

      const older = await Post.insert({
        source: 'older.md',
        slug: 'older',
        title: '旧文章',
        content: '旧内容',
        published: true,
        date: '2020-01-01 00:00:00',
        updated: '2020-01-01 00:00:00',
      })
      const newer = await Post.insert({
        source: 'newer.md',
        slug: 'newer',
        title: '新文章',
        content: '新内容',
        published: true,
        date: '2024-01-01 00:00:00',
        updated: '2024-01-01 00:00:00',
      })

      hexo.locals.set('posts', Post.find({}))
      const generator = hexo.extend.generator.get('search_jsonl')
      const result = (await generator(hexo.locals.toObject() as never)) as { data: string }

      const lines = result.data.split('\n')
      const meta = JSON.parse(lines[0])
      expect(meta.total).toBe(2)
      expect(meta.allIds).toEqual([newer.path, older.path])
      expect(meta.allM[0]).toBeGreaterThan(meta.allM[1])
    })

    it('站点配置可自定义索引与 Worker 输出路径', async () => {
      const workerFile = path.join(baseDir, 'custom-worker.js')
      writeFileSync(workerFile, '// worker bundle')

      const hexo = await createSite({
        search: { path: '/assets/index.jsonl', worker: '/assets/worker.js' },
        workerBundlePath: workerFile,
      })

      const jsonlGen = hexo.extend.generator.get('search_jsonl')
      const jsonlRes = (await jsonlGen(hexo.locals.toObject() as never)) as { path: string; data: string }
      expect(jsonlRes.path).toBe('assets/index.jsonl')
      expect(JSON.parse(jsonlRes.data.split('\n')[0])).toMatchObject({ _type: 'meta', total: 0 })

      const workerGen = hexo.extend.generator.get('search_worker')
      const workerRes = (await workerGen(hexo.locals.toObject() as never)) as {
        path: string
        data: () => NodeJS.ReadableStream
      }
      expect(workerRes.path).toBe('assets/worker.js')

      const chunks: Buffer[] = []
      for await (const chunk of workerRes.data()) {
        chunks.push(Buffer.from(chunk))
      }
      expect(Buffer.concat(chunks).toString('utf8')).toBe('// worker bundle')
    })

    it('Worker 产物缺失时安全跳过生成且不阻塞 Hexo 构建', async () => {
      const hexo = await createSite({
        workerBundlePath: path.join(baseDir, 'not-exists.js'),
      })

      const generator = hexo.extend.generator.get('search_worker')
      await expect(generator(hexo.locals.toObject() as never)).resolves.toBeUndefined()
    })
  })
}
