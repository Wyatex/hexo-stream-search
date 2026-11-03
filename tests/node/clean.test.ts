/**
 * Node 端 HTML 清洗工具：状态机标签剥离、实体解码与空白折叠
 */
import { describe, expect, it } from 'vitest'
import { cleanText, stripHtml, unescapeHtml } from '../../src/node/clean'

describe('stripHtml', () => {
  it('剥离常规与嵌套 HTML 标签并保留纯文本', () => {
    expect(stripHtml('<p>Hello <strong>World</strong>!</p>')).toBe('Hello World!')
  })

  it('忽略引号属性值内的尖括号，避免提前闭合标签', () => {
    expect(stripHtml('<a title="1 > 0" data-expr=\'a < b && c > d\'>链接</a>')).toBe('链接')
  })

  it('处理标签内未加引号的嵌套左尖括号深度', () => {
    expect(stripHtml('<div<span class="x">>正文</div>')).toBe('正文')
  })

  it('剥离单行与多行 HTML 注释，保留非注释的感叹号文本', () => {
    expect(stripHtml('前<!-- 单行注释 -->中<!-- 多行\n -- 内部横线 \n注释 -->后')).toBe('前中后')
    expect(stripHtml('a<!-not-comment>b')).toBe('ab')
  })

  it('保留不构成标签的尖括号表达式（后跟空格或换行）', () => {
    expect(stripHtml('1 < 2 and 3 > 2')).toBe('1 < 2 and 3 > 2')
    expect(stripHtml('a <\nb')).toBe('a < b')
  })

  it('兼容 String 包装对象，空值或非字符串输入返回空字符串', () => {
    expect(stripHtml(new String('<b>包装</b>'))).toBe('包装')
    expect(stripHtml('')).toBe('')
    expect(stripHtml(undefined)).toBe('')
    expect(stripHtml(null)).toBe('')
    expect(stripHtml(123)).toBe('')
  })
})

describe('unescapeHtml', () => {
  it('还原 hexo-util 约定的全部命名与固定实体', () => {
    expect(unescapeHtml('&amp;&lt;&gt;&quot;&#39;&#96;&#x2F;&#x3D;')).toBe('&<>"\'`/=')
  })

  it('还原十进制与大小写十六进制数值实体（含补充平面 Emoji）', () => {
    expect(unescapeHtml('&#123;&#x7d;&#X7D; &#x1F680; &#128293;')).toBe('{}} 🚀 🔥')
  })

  it('超出合法 Unicode 码点范围或未知命名实体保持原样', () => {
    expect(unescapeHtml('&#x110000;')).toBe('&#x110000;')
    expect(unescapeHtml('&#99999999;')).toBe('&#99999999;')
    expect(unescapeHtml('&unknownentity;')).toBe('&unknownentity;')
    expect(unescapeHtml('')).toBe('')
  })
})

describe('cleanText', () => {
  it('先剥离真实标签再解码实体，保留代码块中转义的尖括号文本', () => {
    expect(cleanText('<pre><code>const generic: Array&lt;number&gt; = [1 &amp; 2]</code></pre>')).toBe(
      'const generic: Array<number> = [1 & 2]',
    )
  })

  it('折叠连续空格、制表符与换行并去除首尾空白', () => {
    expect(cleanText('  <p>Hello</p>\r\n\t  <p>World</p>  ')).toBe('Hello World')
  })

  it('空值返回空字符串', () => {
    expect(cleanText('')).toBe('')
    expect(cleanText(null)).toBe('')
    expect(cleanText(undefined)).toBe('')
  })
})
