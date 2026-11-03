/**
 * 分词器：技术词规范化、Intl.Segmenter 中英文切分、正则二元兜底与停用词过滤
 */
import { describe, expect, it } from 'vitest'
import {
  fallbackTokenize,
  filterStopWords,
  getSegmenter,
  isStopWord,
  normalizeTechTerms,
  tokenize,
} from '../../src/web/core/tokenize'

describe('normalizeTechTerms', () => {
  it('不区分大小写地将 C++ 与 C# 规范化为可检索词', () => {
    expect(normalizeTechTerms('C++ 与 c++ 教程')).toBe('cpp 与 cpp 教程')
    expect(normalizeTechTerms('C# 和 c# 实战')).toBe('csharp 和 csharp 实战')
  })
})

describe('tokenize', () => {
  it('Node 运行时可获取 Intl.Segmenter 实例并复用缓存', () => {
    const seg1 = getSegmenter()
    const seg2 = getSegmenter()
    expect(seg1).toBeDefined()
    expect(seg1).toBe(seg2)
  })

  it('英文按词切分、转小写并忽略标点空白', () => {
    expect(tokenize('  Hello, World! 2026  ')).toEqual(['hello', 'world', '2026'])
  })

  it('中英文、数字与特殊技术词混合文本正确切分', () => {
    const tokens = tokenize('Vue3 与 C++ / C# 性能优化')
    expect(tokens).toContain('vue3')
    expect(tokens).toContain('cpp')
    expect(tokens).toContain('csharp')
    expect(tokens.some((t) => t.includes('性能') || t.startsWith('性'))).toBe(true)
  })

  it('空值、纯空白或纯标点返回空数组', () => {
    expect(tokenize('')).toEqual([])
    expect(tokenize('   ')).toEqual([])
    expect(tokenize('... --- !!!')).toEqual([])
    expect(tokenize(null)).toEqual([])
    expect(tokenize(undefined)).toEqual([])
  })
})

describe('fallbackTokenize', () => {
  it('英文按连续词切分，中文按滑动二元组切分', () => {
    expect(fallbackTokenize('Hello 中文abc')).toEqual(['hello', '中文', '文', 'abc'])
    expect(fallbackTokenize('流式搜索')).toEqual(['流式', '式搜', '搜索', '索'])
  })

  it('保留英文技术符号并对 C++ / C# 做规范化', () => {
    expect(fallbackTokenize('C++ node_modules v1.2-beta')).toEqual(['cpp', 'node_modules', 'v1.2-beta'])
  })

  it('空输入返回空数组', () => {
    expect(fallbackTokenize('')).toEqual([])
    expect(fallbackTokenize(null)).toEqual([])
    expect(fallbackTokenize(undefined)).toEqual([])
  })
})

describe('停用词识别与过滤', () => {
  it('识别中英文高频停用词', () => {
    expect(isStopWord('的')).toBe(true)
    expect(isStopWord('the')).toBe(true)
    expect(isStopWord('typescript')).toBe(false)
    expect(isStopWord('搜索')).toBe(false)
  })

  it('多词查询剔除停用词，保留有效实词', () => {
    expect(filterStopWords(['在', 'hexo', '的', '搜索'])).toEqual(['hexo', '搜索'])
    expect(filterStopWords(['search', 'in', 'the', 'worker'])).toEqual(['search', 'worker'])
  })

  it('空数组或单词查询原样返回（避免单字搜索失效）', () => {
    expect(filterStopWords([])).toEqual([])
    expect(filterStopWords(['的'])).toEqual(['的'])
    expect(filterStopWords(['the'])).toEqual(['the'])
  })

  it('所有分词均为停用词时保留原词兜底', () => {
    expect(filterStopWords(['的', '了'])).toEqual(['的', '了'])
    expect(filterStopWords(['to', 'the', 'in'])).toEqual(['to', 'the', 'in'])
  })
})
