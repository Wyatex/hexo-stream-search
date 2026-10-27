import { describe, expect, it } from 'vitest'
import { cleanText, stripHtml, unescapeHtml } from '../../src/node/clean'

describe('stripHtml', () => {
  it('剥离标签并保留标签外文本', () => {
    expect(stripHtml('<p>Hello <strong>World</strong></p>')).toBe('Hello World')
  })

  it('剥离注释', () => {
    expect(stripHtml('a<!-- note -->b')).toBe('ab')
  })

  it('保留不构成标签的尖括号文本', () => {
    expect(stripHtml('a < b')).toBe('a < b')
  })

  it('处理空输入', () => {
    expect(stripHtml('')).toBe('')
    expect(stripHtml(undefined)).toBe('')
  })
})

describe('unescapeHtml', () => {
  it('还原命名实体', () => {
    expect(unescapeHtml('&amp;&lt;&gt;&quot;')).toBe('&<>"')
  })

  it('还原数值实体', () => {
    expect(unescapeHtml('&#39;&#96;')).toBe("'`")
    expect(unescapeHtml('&#x2F;&#x3D;')).toBe('/=')
    expect(unescapeHtml('&#123;')).toBe('{')
  })

  it('未知实体保持原样', () => {
    expect(unescapeHtml('&unknownentity;')).toBe('&unknownentity;')
  })
})

describe('cleanText', () => {
  it('清洗 HTML 并压缩空白', () => {
    expect(cleanText('<p>Hello</p>   <p>World</p>')).toBe('Hello World')
  })

  it('处理空值', () => {
    expect(cleanText('')).toBe('')
    expect(cleanText(null)).toBe('')
    expect(cleanText(undefined)).toBe('')
  })

  it('保留代码片段中的尖括号内容以外的文本', () => {
    expect(cleanText('<code>const a = 1</code>')).toBe('const a = 1')
  })
})
