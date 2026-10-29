import { describe, expect, it } from 'vitest'
import { buildJsonl, buildJsonlRecords, normalizePostUrl, toTimestamp } from '../../src/node/jsonl'
import type { PostLike } from '../../src/node/hexo-types'

const posts: PostLike[] = [
  {
    path: 'a/',
    title: 'A 文章',
    content: '<p>alpha 内容</p>',
    updated: 100,
    tags: [{ name: 'tag-a' }],
    categories: [{ name: 'cat-a' }],
  },
  {
    path: 'b/',
    title: 'B 文章',
    content: 'beta',
    updated: 200,
  },
  {
    path: 'c/',
    title: 'C 文章',
    content: 'gamma',
    date: 50,
    indexing: false,
  },
  {
    path: 'd/',
    title: 'D 文章',
    content: 'delta',
    published: false,
  },
]

describe('toTimestamp', () => {
  it('支持数字与 moment 风格对象', () => {
    expect(toTimestamp(123)).toBe(123)
    expect(toTimestamp({ valueOf: () => 456 })).toBe(456)
    expect(toTimestamp(undefined)).toBe(0)
  })
})

describe('normalizePostUrl', () => {
  it('拼接站点根路径并折叠重复斜杠', () => {
    expect(normalizePostUrl('a/', '/')).toBe('/a/')
    expect(normalizePostUrl('/a/', '/')).toBe('/a/')
    expect(normalizePostUrl('a/', '/blog/')).toBe('/blog/a/')
  })
})

describe('buildJsonlRecords', () => {
  it('第一行为元数据且按更新时间降序并包含 allM', () => {
    const records = buildJsonlRecords(posts)
    expect(records[0]).toEqual({
      _type: 'meta',
      total: 2,
      allIds: ['b/', 'a/'],
      allM: [200, 100],
    })
  })

  it('时间戳相同时使用 path 作为次级排序键保证确定性排序', () => {
    const sameTimePosts: PostLike[] = [
      { path: 'zeta/', title: 'Z', updated: 500 },
      { path: 'alpha/', title: 'A', updated: 500 },
      { path: 'beta/', title: 'B', updated: 500 },
      { path: 'newer/', title: 'N', updated: 600 },
    ]
    const records = buildJsonlRecords(sameTimePosts)
    const meta = records[0] as { allIds: string[]; allM: number[] }
    expect(meta.allIds).toEqual(['newer/', 'alpha/', 'beta/', 'zeta/'])
    expect(meta.allM).toEqual([600, 500, 500, 500])
  })

  it('过滤 indexing=false 与 published=false 的文章', () => {
    const records = buildJsonlRecords(posts)
    const ids = records.slice(1).map((record) => (record as { id: string }).id)
    expect(ids).toEqual(['b/', 'a/'])
  })

  it('文章字段映射正确', () => {
    const records = buildJsonlRecords(posts)
    const article = records[2] as {
      id: string
      t: string
      u: string
      m: number
      g: string[]
      k: string[]
      c: string
    }
    expect(article.id).toBe('a/')
    expect(article.t).toBe('A 文章')
    expect(article.u).toBe('/a/')
    expect(article.m).toBe(100)
    expect(article.g).toEqual(['tag-a'])
    expect(article.k).toEqual(['cat-a'])
    expect(article.c).toBe('alpha 内容')
  })

  it('缺少标题时使用 Untitled', () => {
    const records = buildJsonlRecords([{ path: 'x/', content: 'c' }])
    expect((records[1] as { t: string }).t).toBe('Untitled')
  })

  it('空文章集合只输出元数据', () => {
    const records = buildJsonlRecords([])
    expect(records).toEqual([{ _type: 'meta', total: 0, allIds: [], allM: [] }])
  })
})

describe('buildJsonl', () => {
  it('每行一个 JSON 记录', () => {
    const content = buildJsonl(posts)
    const lines = content.split('\n')
    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[0])).toMatchObject({ _type: 'meta', total: 2 })
    expect(JSON.parse(lines[1])).toMatchObject({ id: 'b/' })
  })

  it('站点根路径参与链接拼接', () => {
    const content = buildJsonl(posts, { root: '/blog/' })
    const lines = content.split('\n')
    expect(JSON.parse(lines[2]).u).toBe('/blog/a/')
  })
})
