import { describe, expect, it } from 'vitest'
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
  it('按字段权重统计加权词频', () => {
    const doc = processPost(post({ id: 'a', t: 'typescript', c: 'typescript' }))
    // 标题 4.0 + 正文 1.0
    expect(doc.tf.typescript).toBeCloseTo(5)
    expect(doc.dl).toBeCloseTo(5)
  })

  it('标签与分类拥有独立权重', () => {
    const doc = processPost(post({ id: 'a', g: ['ts'], k: ['前端'] }))
    expect(doc.tf.ts).toBeCloseTo(3)
    expect(doc.tf.前端).toBeCloseTo(2.5)
  })
})

describe('IndexStore', () => {
  it('维护文档数与词项数', () => {
    const store = new IndexStore()
    store.addPost(processPost(post({ id: 'a', t: 'alpha' })))
    store.addPost(processPost(post({ id: 'b', t: 'beta' })))
    expect(store.size).toBe(2)
    expect(store.termCount).toBe(2)
  })

  it('移除文档时同步清理倒排索引', () => {
    const store = new IndexStore()
    store.addPost(processPost(post({ id: 'a', t: 'alpha' })))
    store.removePost('a')
    expect(store.size).toBe(0)
    expect(store.termCount).toBe(0)
  })

  it('重复加入同一文档不会重复计数', () => {
    const store = new IndexStore()
    store.addPost(processPost(post({ id: 'a', t: 'alpha' })))
    store.addPost(processPost(post({ id: 'a', t: 'alpha' })))
    expect(store.size).toBe(1)
  })

  it('标题命中排在正文命中之前', () => {
    const store = new IndexStore()
    store.addPost(
      processPost(post({ id: 'title-hit', t: 'typescript', c: '无关内容' })),
    )
    store.addPost(
      processPost(post({ id: 'content-hit', t: '其他文章', c: '这里提到 typescript 一次' })),
    )

    const results = store.search('typescript')
    expect(results[0].id).toBe('title-hit')
  })

  it('标签命中也能检索到文章', () => {
    const store = new IndexStore()
    store.addPost(processPost(post({ id: 'tagged', g: ['typescript'] })))
    const results = store.search('typescript')
    expect(results.map((item) => item.id)).toContain('tagged')
  })

  it('支持英文短词前缀回退命中', () => {
    const store = new IndexStore()
    store.addPost(processPost(post({ id: 'a', t: 'typescript' })))
    const results = store.search('types')
    expect(results.map((item) => item.id)).toContain('a')
  })

  it('返回结果字段完整且分数保留两位小数', () => {
    const store = new IndexStore()
    store.addPost(
      processPost(post({ id: 'a', t: 'TypeScript 入门', u: 'a/', g: ['ts'], k: ['前端'], c: 'typescript 基础' })),
    )

    const [result] = store.search('typescript')
    expect(result).toBeDefined()
    expect(result.id).toBe('a')
    expect(result.url).toBe('/a/')
    expect(result.tags).toEqual(['ts'])
    expect(result.categories).toEqual(['前端'])
    expect(result.updated).toBe(1)
    expect(Number.isInteger(result.score * 100)).toBe(true)
    expect(result.title).toContain('<mark class="search-keyword">')
    expect(result.snippet).toContain('typescript')
  })

  it('空查询返回空结果', () => {
    const store = new IndexStore()
    store.addPost(processPost(post({ id: 'a', t: 'alpha' })))
    expect(store.search('')).toEqual([])
    expect(store.search('   ')).toEqual([])
  })

  it('空索引时返回空结果', () => {
    expect(new IndexStore().search('anything')).toEqual([])
  })

  it('命中全部查询词的文档获得更高权重', () => {
    const store = new IndexStore()
    store.addPost(processPost(post({ id: 'both', t: 'stream worker', c: 'stream worker' })))
    store.addPost(processPost(post({ id: 'partial', t: 'stream', c: 'stream' })))

    const results = store.search('stream worker')
    expect(results[0].id).toBe('both')
  })

  it('限制返回数量', () => {
    const store = new IndexStore()
    for (let i = 0; i < 5; i++) {
      store.addPost(processPost(post({ id: `p${i}`, t: 'typescript' })))
    }
    expect(store.search('typescript', 2)).toHaveLength(2)
  })
})
