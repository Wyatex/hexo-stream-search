import { describe, expect, it } from 'vitest'
import { fallbackTokenize, filterStopWords, isStopWord, normalizeTechTerms, tokenize } from '../../src/web/core/tokenize'

describe('normalizeTechTerms', () => {
  it('规范化 C++ 与 C#', () => {
    expect(normalizeTechTerms('C++ 教程')).toBe('cpp 教程')
    expect(normalizeTechTerms('C# 教程')).toBe('csharp 教程')
  })
})

describe('tokenize', () => {
  it('英文按词切分并转小写', () => {
    expect(tokenize('Hello World')).toEqual(['hello', 'world'])
  })

  it('技术词汇被规范化', () => {
    const tokens = tokenize('C++ 与 C#')
    expect(tokens).toContain('cpp')
    expect(tokens).toContain('csharp')
  })

  it('中文可以切分出词', () => {
    const tokens = tokenize('流式搜索')
    expect(tokens.length).toBeGreaterThan(0)
    expect(tokens.some((token) => token.startsWith('流'))).toBe(true)
  })

  it('空输入返回空数组', () => {
    expect(tokenize('')).toEqual([])
    expect(tokenize(null)).toEqual([])
    expect(tokenize(undefined)).toEqual([])
  })
})

describe('fallbackTokenize', () => {
  it('英文按单词、中文按二元组切分', () => {
    expect(fallbackTokenize('Hello 中文abc')).toEqual(['hello', '中文', '文', 'abc'])
  })

  it('同样规范化技术词汇', () => {
    expect(fallbackTokenize('C++')).toEqual(['cpp'])
  })
})

describe('停用词', () => {
  it('识别停用词', () => {
    expect(isStopWord('的')).toBe(true)
    expect(isStopWord('typescript')).toBe(false)
  })

  it('多词查询时剔除停用词', () => {
    expect(filterStopWords(['的', '搜索'])).toEqual(['搜索'])
  })

  it('单词查询保留原词', () => {
    expect(filterStopWords(['的'])).toEqual(['的'])
  })

  it('剔除后为空时保留原词', () => {
    expect(filterStopWords(['的', '了'])).toEqual(['的', '了'])
  })
})
