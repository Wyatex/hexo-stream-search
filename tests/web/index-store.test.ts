/**
 * 倒排索引与 BM25 检索引擎：字段加权词频、倒排表维护与多维相关性打分
 */
import { describe, expect, it } from 'vitest'
import {
  CATEGORY_WEIGHT,
  CONTENT_WEIGHT,
  TAG_WEIGHT,
  TITLE_WEIGHT,
} from '../../src/shared/constants'
import { IndexStore, processPost } from '../../src/web/core/index-store'
import type { SearchPostRecord } from '../../src/shared/types'

function post(overrides: Partial<SearchPostRecord> & { id: string }): SearchPostRecord {
  return {
    t: '',
    u: `/${overrides.id}`,
    m: 1,
    g: [],
    k: [],
    c: '',
    ...overrides,
  }
}

describe('processPost', () => {
  it('按标题 / 标签 / 分类 / 正文权重累加词频并计算有效文档长度 dl', () => {
    const doc = processPost(
      post({
        id: 'a/',
        t: 'typescript',
        g: ['typescript'],
        k: ['typescript'],
        c: 'typescript',
      }),
    )
    const expected = TITLE_WEIGHT + TAG_WEIGHT + CATEGORY_WEIGHT + CONTENT_WEIGHT
    expect(doc.tf.typescript).toBeCloseTo(expected)
    expect(doc.dl).toBeCloseTo(expected)
  })

  it('缺失可选字段时使用安全默认值，且词频表基于无原型对象防止原型链污染', () => {
    const doc = processPost({
      id: 'proto/',
      t: 'constructor toString valueOf',
      u: '',
      m: 0,
      g: undefined as never,
      k: undefined as never,
      c: '',
    })

    expect(doc.u).toBe('proto/')
    expect(doc.g).toEqual([])
    expect(doc.k).toEqual([])
    expect(Object.getPrototypeOf(doc.tf)).toBeNull()
    expect(doc.tf.constructor).toBe(TITLE_WEIGHT)
    expect(doc.tf.tostring).toBe(TITLE_WEIGHT)
  })
})

describe('IndexStore', () => {
  describe('文档与倒排表增删改', () => {
    it('维护文档字典与词项计数，移除或清空时释放无引用的倒排链表', () => {
      const store = new IndexStore()
      store.addPost(processPost(post({ id: 'a/', t: 'alpha shared' })))
      store.addPost(processPost(post({ id: 'b/', t: 'beta shared' })))

      expect(store.size).toBe(2)
      expect(store.termCount).toBe(3)
      expect(store.has('a/')).toBe(true)
      expect(store.getDoc('a/')?.id).toBe('a/')

      store.removePost('a/')
      expect(store.size).toBe(1)
      expect(store.has('a/')).toBe(false)
      // 'alpha' 倒排表为空被移除，仅剩 'beta' 与 'shared'
      expect(store.termCount).toBe(2)

      // 移除不存在的 ID 或写入空对象安全无副作用
      store.removePost('non-existent/')
      store.addPost({ id: '' } as never)
      expect(store.size).toBe(1)

      store.clear()
      expect(store.size).toBe(0)
      expect(store.termCount).toBe(0)
    })

    it('覆盖更新同一 ID 文档时先清除旧词项，避免残留脏命中', () => {
      const store = new IndexStore()
      store.addPost(processPost(post({ id: 'a/', t: 'legacyword', c: 'old body' })))
      store.addPost(processPost(post({ id: 'a/', t: 'modernword', c: 'new body' })))

      expect(store.size).toBe(1)
      expect(store.search('legacyword')).toEqual([])
      expect(store.search('modernword')[0]?.id).toBe('a/')
    })

    it('buildFrom 重建全量索引并清空此前数据', () => {
      const store = new IndexStore()
      store.addPost(processPost(post({ id: 'stale/', t: 'stale' })))

      store.buildFrom([
        processPost(post({ id: 'p1/', t: 'rust' })),
        processPost(post({ id: 'p2/', t: 'golang' })),
      ])

      expect(store.size).toBe(2)
      expect(store.has('stale/')).toBe(false)
      expect(store.search('rust')[0]?.id).toBe('p1/')
    })
  })

  describe('BM25 相关性排序与结构化加成', () => {
    it('按字段权重排序：标题命中 > 标签命中 > 分类命中 > 正文命中', () => {
      const store = new IndexStore()
      store.buildFrom([
        processPost(post({ id: 'body/', t: '无关标题', c: '这里提到了算法复杂度' })),
        processPost(post({ id: 'category/', t: '无关标题', k: ['算法'], c: '普通正文' })),
        processPost(post({ id: 'tag/', t: '无关标题', g: ['算法'], c: '普通正文' })),
        processPost(post({ id: 'title/', t: '算法指南', c: '普通正文' })),
      ])

      const ids = store.search('算法').map((r) => r.id)
      expect(ids).toEqual(['title/', 'tag/', 'category/', 'body/'])
    })

    it('标题前缀匹配得分高于标题中间包含匹配', () => {
      const store = new IndexStore()
      store.buildFrom([
        processPost(post({ id: 'middle/', t: '深入理解 Hexo 插件机制' })),
        processPost(post({ id: 'prefix/', t: 'Hexo 插件机制深入理解' })),
      ])

      const results = store.search('hexo')
      expect(results[0].id).toBe('prefix/')
      expect(results[0].score).toBeGreaterThan(results[1].score)
    })

    it('正文包含完整检索短语的文档高于词项分散出现的文档', () => {
      const store = new IndexStore()
      store.buildFrom([
        processPost(post({ id: 'scattered/', t: 'Note A', c: 'stream processing and later full search index' })),
        processPost(post({ id: 'phrase/', t: 'Note B', c: 'building a fast stream search engine in browser' })),
      ])

      const results = store.search('stream search')
      expect(results[0].id).toBe('phrase/')
    })

    it('多词查询赋予全词覆盖协同加成，且自动剔除泛停用词', () => {
      const store = new IndexStore()
      store.buildFrom([
        processPost(post({ id: 'partial/', t: 'stream', c: 'stream only' })),
        processPost(post({ id: 'both/', t: 'stream worker', c: 'stream worker' })),
      ])

      expect(store.search('stream worker')[0].id).toBe('both/')
      // 含停用词 "的" 时不应因缺失 "的" 而拉低全实词命中的文档排名
      expect(store.search('stream 的 worker')[0].id).toBe('both/')
    })

    it('英文技术词支持 2 字符以上前缀回退匹配，单字符不触发误匹配', () => {
      const store = new IndexStore()
      store.addPost(processPost(post({ id: 'ts/', t: 'typescript compiler' })))

      expect(store.search('types').map((r) => r.id)).toEqual(['ts/'])
      expect(store.search('t')).toEqual([])
    })

    it('输出规范化 URL、两位小数得分、高亮标题与摘要，并遵守 limit 上限', () => {
      const store = new IndexStore()
      for (let i = 0; i < 5; i++) {
        store.addPost(
          processPost(
            post({
              id: `p${i}`,
              t: `TypeScript 第 ${i} 篇`,
              u: `posts/p${i}/`, // 故意不带前导斜杠
              m: 100 + i,
              g: ['ts'],
              k: ['前端'],
              c: 'typescript 类型体操与编译器原理',
            }),
          ),
        )
      }

      const hits = store.search('typescript', 2)
      expect(hits).toHaveLength(2)
      expect(hits[0]).toMatchObject({
        url: expect.stringMatching(/^\/posts\/p\d\/$/),
        tags: ['ts'],
        categories: ['前端'],
      })
      expect(Number.isInteger(Math.round(hits[0].score * 100))).toBe(true)
      expect(hits[0].title).toContain('<mark class="search-keyword">TypeScript</mark>')
      expect(hits[0].snippet).toContain('<mark class="search-keyword">typescript</mark>')
    })

    it('空查询、纯标点查询或空索引返回空数组', () => {
      const empty = new IndexStore()
      expect(empty.search('hexo')).toEqual([])

      empty.addPost(processPost(post({ id: 'a/', t: 'hexo' })))
      expect(empty.search('')).toEqual([])
      expect(empty.search('   ')).toEqual([])
      expect(empty.search('... !!!')).toEqual([])
    })
  })
})
