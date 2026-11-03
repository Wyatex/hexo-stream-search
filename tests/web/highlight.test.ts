/**
 * 高亮与智能摘要：HTML 防注入转义、长词优先高亮与上下文窗口截取
 */
import { describe, expect, it } from 'vitest'
import { buildSnippet, escapeHtml, escapeRegExp, highlightText } from '../../src/web/core/highlight'

describe('escapeHtml', () => {
  it('转义全部 5 类 HTML 特殊字符', () => {
    expect(escapeHtml('<a href="x">&\'</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;')
  })

  it('空值返回空字符串', () => {
    expect(escapeHtml('')).toBe('')
    expect(escapeHtml(null)).toBe('')
    expect(escapeHtml(undefined)).toBe('')
  })
})

describe('escapeRegExp', () => {
  it('转义全部正则元字符，使其可安全拼接进 RegExp', () => {
    const raw = 'a.b*c+d?e^f$g{1}(2)|[3]\\4'
    const pattern = new RegExp(escapeRegExp(raw))
    expect(pattern.test(raw)).toBe(true)
  })
})

describe('highlightText', () => {
  it('先做 HTML 转义再包裹高亮标签，杜绝 XSS 注入', () => {
    const result = highlightText('<img src=x onerror=alert(1)> typescript', ['typescript'], 'typescript')
    expect(result).toBe('&lt;img src=x onerror=alert(1)&gt; <mark class="search-keyword">typescript</mark>')
  })

  it('查询词自身包含 HTML 特殊字符时也能精确高亮转义后的文本', () => {
    const result = highlightText('使用 <template> 标签', ['template'], '<template>')
    expect(result).toBe('使用 <mark class="search-keyword">&lt;template&gt;</mark> 标签')
  })

  it('长词优先于前缀短词匹配，且保留原文大小写', () => {
    const result = highlightText('TypeScript and type', ['type', 'typescript'], 'TypeScript')
    expect(result).toBe(
      '<mark class="search-keyword">TypeScript</mark> and <mark class="search-keyword">type</mark>',
    )
  })

  it('过滤单字停用词，但允许高亮非停用词单字', () => {
    expect(highlightText('我的红黑树实现', ['的', '树'], '')).toBe(
      '我的红黑<mark class="search-keyword">树</mark>实现',
    )
  })

  it('空文本返回空串，无有效候选词时仅返回安全转义文本', () => {
    expect(highlightText('', ['ts'], 'ts')).toBe('')
    expect(highlightText('a < b', [], '')).toBe('a &lt; b')
    expect(highlightText('我的文章', ['的'], '的')).toBe('我的文章')
  })
})

describe('buildSnippet', () => {
  it('围绕命中位置截取窗口并在首尾补省略号', () => {
    const content = `${'前缀填充'.repeat(30)}核心关键词${'后缀填充'.repeat(50)}`
    const snippet = buildSnippet(content, ['核心关键词'], '核心关键词')

    expect(snippet.startsWith('...')).toBe(true)
    expect(snippet.endsWith('...')).toBe(true)
    expect(snippet).toContain('<mark class="search-keyword">核心关键词</mark>')
  })

  it('优先定位完整原始查询短语，其次回退定位最长检索词', () => {
    // 单个词 "stream" 出现在最前面，但完整短语 "stream search" 出现在后段
    const content = `stream ${'无关正文内容 '.repeat(25)}完整的 stream search 引擎介绍`
    const phraseSnippet = buildSnippet(content, ['stream', 'search'], 'stream search', 60)
    expect(phraseSnippet).toContain('<mark class="search-keyword">stream search</mark>')

    // 完整短语不存在于正文时，回退定位最长有效词 "architecture"
    const splitContent = `go ${'填充文本 '.repeat(25)}streaming architecture 详解`
    const fallbackSnippet = buildSnippet(splitContent, ['go', 'architecture'], 'go architecture', 60)
    expect(fallbackSnippet).toContain('<mark class="search-keyword">architecture</mark>')
  })

  it('正文中无任何词命中（如仅标题或标签命中）时从开头截取', () => {
    const content = 'A'.repeat(200)
    const snippet = buildSnippet(content, ['unmatched'], 'unmatched', 50)
    expect(snippet.startsWith('...')).toBe(false)
    expect(snippet.endsWith('...')).toBe(true)
  })

  it('短内容不添加多余省略号，空内容返回空字符串', () => {
    expect(buildSnippet('短内容 关键词', ['关键词'], '关键词')).toBe(
      '短内容 <mark class="search-keyword">关键词</mark>',
    )
    expect(buildSnippet('', ['x'], 'x')).toBe('')
  })
})
