import { describe, expect, it } from 'vitest'
import { buildSnippet, escapeHtml, escapeRegExp, highlightText } from '../../src/web/core/highlight'

describe('escapeHtml', () => {
  it('转义 HTML 特殊字符', () => {
    expect(escapeHtml('<a href="x">&\'</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;')
  })

  it('空值返回空字符串', () => {
    expect(escapeHtml('')).toBe('')
    expect(escapeHtml(undefined)).toBe('')
  })
})

describe('escapeRegExp', () => {
  it('转义正则元字符', () => {
    expect(escapeRegExp('a.b*c')).toBe('a\\.b\\*c')
  })
})

describe('highlightText', () => {
  it('先转义再高亮，避免 XSS', () => {
    const result = highlightText('<script>alert(1)</script> typescript', ['typescript'], 'typescript')
    expect(result).toContain('&lt;script&gt;')
    expect(result).toContain('<mark class="search-keyword">typescript</mark>')
  })

  it('长词优先匹配', () => {
    const result = highlightText('typescript type', ['typescript', 'type'], 'typescript')
    expect(result).toBe(
      '<mark class="search-keyword">typescript</mark> <mark class="search-keyword">type</mark>',
    )
  })

  it('无候选词时仅返回转义文本', () => {
    expect(highlightText('plain', [], '')).toBe('plain')
  })
})

describe('buildSnippet', () => {
  it('围绕命中位置截取并补省略号', () => {
    const content = `${'前缀内容'.repeat(60)}关键词${'后缀内容'.repeat(60)}`
    const snippet = buildSnippet(content, ['关键词'], '关键词')
    expect(snippet.startsWith('...')).toBe(true)
    expect(snippet.endsWith('...')).toBe(true)
    expect(snippet).toContain('<mark class="search-keyword">关键词</mark>')
  })

  it('内容较短时不做居中截取', () => {
    const snippet = buildSnippet('短内容 关键词', ['关键词'], '关键词')
    expect(snippet).not.toContain('...')
  })

  it('空内容返回空字符串', () => {
    expect(buildSnippet('', ['x'], 'x')).toBe('')
  })
})
