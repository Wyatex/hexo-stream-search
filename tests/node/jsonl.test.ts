/**
 * Node 端 JSONL 索引构建：时间戳转换、链接规范化、确定性排序与元数据对齐
 */
import { describe, expect, it } from 'vitest'
import { buildJsonl, buildJsonlRecords, normalizePostUrl, toTimestamp } from '../../src/node/jsonl'
import type { PostLike } from '../../src/node/hexo-types'
import type { SearchMetaRecord, SearchPostRecord } from '../../src/shared/types'

function shuffle<T>(items: readonly T[], seed = 42): T[] {
  const copy = [...items]
  let state = seed
  for (let i = copy.length - 1; i > 0; i--) {
    state = (state * 1664525 + 1013904223) >>> 0
    const j = state % (i + 1)
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

const SAMPLE_POSTS: PostLike[] = [
  {
    path: 'a/',
    title: 'A <strong>文章</strong>',
    content: '<p>alpha &amp; 内容</p>',
    updated: 100,
    tags: [{ name: 'tag-a' }, { name: '' }],
    categories: [{ name: 'cat-a' }, {}],
  },
  {
    path: 'b/',
    title: 'B 文章',
    content: 'beta',
    updated: 200,
  },
  {
    path: 'c/',
    title: 'C 不索引',
    content: 'gamma',
    date: 500,
    indexing: false,
  },
  {
    path: 'd/',
    title: 'D 草稿',
    content: 'delta',
    updated: 900,
    published: false,
  },
]

describe('toTimestamp', () => {
  it('支持有限数值（含 0 与 1970 年以前的负时间戳）', () => {
    expect(toTimestamp(0)).toBe(0)
    expect(toTimestamp(1_700_000_000_000)).toBe(1_700_000_000_000)
    expect(toTimestamp(-100)).toBe(-100)
  })

  it('支持 Date 与 Moment 风格对象（含非法日期兜底为 0）', () => {
    const valid = new Date('2024-01-01T00:00:00Z')
    const pre1970 = new Date('1969-07-20T20:17:00Z')
    expect(toTimestamp(valid)).toBe(valid.getTime())
    expect(toTimestamp(pre1970)).toBe(pre1970.getTime())
    expect(toTimestamp(new Date('invalid-date'))).toBe(0)
    expect(toTimestamp({ valueOf: () => 456 })).toBe(456)
  })

  it('空值、非有限数或 valueOf 返回非有限数时统一归零', () => {
    expect(toTimestamp(null)).toBe(0)
    expect(toTimestamp(undefined)).toBe(0)
    expect(toTimestamp(Number.NaN)).toBe(0)
    expect(toTimestamp(Number.POSITIVE_INFINITY)).toBe(0)
    expect(toTimestamp(Number.NEGATIVE_INFINITY)).toBe(0)
    expect(toTimestamp({ valueOf: () => Number.NaN })).toBe(0)
    expect(toTimestamp({ valueOf: () => Number.POSITIVE_INFINITY })).toBe(0)
    expect(toTimestamp({ valueOf: () => 'not-a-number' as unknown as number })).toBe(0)
  })
})

describe('normalizePostUrl', () => {
  it('拼接站点根路径并折叠重复斜杠', () => {
    expect(normalizePostUrl('a/', '/')).toBe('/a/')
    expect(normalizePostUrl('/a/', '/')).toBe('/a/')
    expect(normalizePostUrl('a/', '/blog/')).toBe('/blog/a/')
    expect(normalizePostUrl('foo/bar', '/blog///')).toBe('/blog/foo/bar')
    expect(normalizePostUrl('//foo///bar//', '/')).toBe('/foo/bar/')
  })

  it('以斜杠开头的路径保持原样，空路径或空根路径回退为 /', () => {
    expect(normalizePostUrl('/foo/bar', '/blog/')).toBe('/foo/bar')
    expect(normalizePostUrl('', '/')).toBe('/')
    expect(normalizePostUrl('', '')).toBe('/')
  })

  it('保留 Unicode 路径、查询参数与锚点', () => {
    expect(normalizePostUrl('中文/🚀-post/?q=1#top', '/blog/')).toBe('/blog/中文/🚀-post/?q=1#top')
  })
})

describe('buildJsonlRecords', () => {
  it('首条为 meta 记录，过滤未发布与禁索引文章，并按更新时间降序输出', () => {
    const records = buildJsonlRecords(SAMPLE_POSTS)
    expect(records[0]).toEqual({
      _type: 'meta',
      total: 2,
      allIds: ['b/', 'a/'],
      allM: [200, 100],
    })
    expect(records.slice(1).map((r) => (r as SearchPostRecord).id)).toEqual(['b/', 'a/'])
  })

  it('准确映射并清洗文章标题、正文、链接、标签与分类字段', () => {
    const records = buildJsonlRecords(SAMPLE_POSTS)
    expect(records[2]).toEqual({
      id: 'a/',
      t: 'A 文章',
      u: '/a/',
      m: 100,
      g: ['tag-a'],
      k: ['cat-a'],
      c: 'alpha & 内容',
    })
  })

  it('缺少标题或标题剥离标签后为空时回退为 Untitled，缺少 updated 时回退使用 date', () => {
    const records = buildJsonlRecords([
      { path: 'no-title/', date: 88, content: 'x' },
      { path: 'empty-html-title/', title: '<span>   </span>', updated: 99, content: 'y' },
    ])
    expect(records[1]).toMatchObject({ id: 'empty-html-title/', t: 'Untitled', m: 99 })
    expect(records[2]).toMatchObject({ id: 'no-title/', t: 'Untitled', m: 88 })
  })

  it('空文章数组或 undefined 安全输出空 meta 头', () => {
    expect(buildJsonlRecords([])).toEqual([{ _type: 'meta', total: 0, allIds: [], allM: [] }])
    expect(buildJsonlRecords(undefined as unknown as PostLike[])).toEqual([
      { _type: 'meta', total: 0, allIds: [], allM: [] },
    ])
  })

  describe('确定性排序与 allIds / allM 严格对齐', () => {
    it('相同时间戳以 path 字典序作为次级键：千篇文章任意打乱顺序结果 100% 一致', () => {
      const posts: PostLike[] = []
      for (const ts of [3000, 2000, 1000]) {
        for (let i = 0; i < 300; i++) {
          posts.push({
            path: `ts_${ts}/item_${String(i).padStart(3, '0')}/`,
            title: `Post ${i}`,
            updated: ts,
          })
        }
      }

      const baseline = buildJsonlRecords(posts)[0] as SearchMetaRecord
      expect(baseline.total).toBe(900)
      expect(baseline.allIds[0]).toBe('ts_3000/item_000/')
      expect(baseline.allIds[300]).toBe('ts_2000/item_000/')
      expect(baseline.allIds[600]).toBe('ts_1000/item_000/')

      for (const seed of [1, 7, 99]) {
        const meta = buildJsonlRecords(shuffle(posts, seed))[0] as SearchMetaRecord
        expect(meta.allIds).toEqual(baseline.allIds)
        expect(meta.allM).toEqual(baseline.allM)
      }
    })

    it('包含多语种 Unicode / Emoji / 特殊符号路径时排序结果确定一致', () => {
      const unicodePosts: PostLike[] = [
        { path: '中文/文章二/', updated: 500 },
        { path: '中文/文章一/', updated: 500 },
        { path: '日本語/テスト/', updated: 500 },
        { path: 'emoji/🚀-launch/', updated: 500 },
        { path: 'emoji/🎉-party/', updated: 500 },
        { path: 'latin/café/', updated: 500 },
        { path: '', updated: 500 },
      ]

      const meta1 = buildJsonlRecords(shuffle(unicodePosts, 11))[0] as SearchMetaRecord
      const meta2 = buildJsonlRecords(shuffle(unicodePosts, 29))[0] as SearchMetaRecord
      expect(meta1.allIds).toEqual(meta2.allIds)
      expect(meta1.allM).toEqual(meta2.allM)
    })

    it('混合异常时间戳与过滤标记时，meta.allIds、meta.allM 与后续文章记录保持严格 1:1 下标对应', () => {
      const mixed: PostLike[] = [
        { path: 'p1/', updated: 500, date: 100 },
        { path: 'p2/', date: 300 },
        { path: 'p3/', updated: undefined, date: 400 },
        { path: 'p4/', updated: 0 },
        { path: 'p5/', updated: -50 },
        { path: 'p6/', updated: Number.NaN, date: 200 },
        { path: 'p7/', updated: Number.POSITIVE_INFINITY },
        { path: 'draft/', published: false, updated: 999 },
        { path: 'noindex/', indexing: false, updated: 888 },
      ]

      const records = buildJsonlRecords(mixed)
      const meta = records[0] as SearchMetaRecord

      expect(meta.total).toBe(7)
      expect(meta.allIds).toHaveLength(7)
      expect(meta.allM).toHaveLength(7)
      expect(records.length - 1).toBe(7)

      for (let i = 0; i < meta.total; i++) {
        const post = records[i + 1] as SearchPostRecord
        expect(post.id).toBe(meta.allIds[i])
        expect(post.m).toBe(meta.allM![i])
        expect(Number.isFinite(post.m)).toBe(true)
      }
    })
  })
})

describe('buildJsonl', () => {
  it('输出以换行符分隔的单行 JSON，且根路径参与 URL 拼接', () => {
    const jsonl = buildJsonl(SAMPLE_POSTS, { root: '/blog/' })
    const lines = jsonl.split('\n')

    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[0])).toMatchObject({ _type: 'meta', total: 2 })
    expect(JSON.parse(lines[1])).toMatchObject({ id: 'b/', u: '/blog/b/' })
    expect(JSON.parse(lines[2])).toMatchObject({ id: 'a/', u: '/blog/a/' })
  })

  it('路径与正文中包含换行、制表符、引号或反斜杠时不会破坏单行 JSONL 结构', () => {
    const tricky: PostLike[] = [
      { path: 'path\nwith\nnewlines/', title: 'Line "A"', content: 'a\nb', updated: 100 },
      { path: 'path\\with\\slashes\tand\ttabs/', title: 'Back\\slash', content: 'c\td', updated: 200 },
    ]

    const lines = buildJsonl(tricky).split('\n')
    expect(lines).toHaveLength(3)
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
  })
})
