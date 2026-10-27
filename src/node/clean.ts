/**
 * HTML 清洗工具（不依赖 hexo-util，保证包零运行时依赖）
 *
 * 行为与 `hexo-util` 的 `stripHTML` / `unescapeHTML` 保持等价：
 * - stripHtml：状态机式剥离标签（保留标签外文本）
 * - unescapeHtml：还原 `&amp; &lt; &gt; &quot; &#39; &#96; &#x2F; &#x3D;`
 * - cleanText：在上述基础上再还原十进制 / 十六进制数值实体并压缩空白
 */

/** hexo-util unescapeHTML 支持的实体表 */
const HTML_ENTITY_MAP: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#96;': '`',
  '&#x2F;': '/',
  '&#x3D;': '=',
}

const ENTITY_PATTERN = /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g

function fromCodePoint(code: number, fallback: string): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return fallback
  try {
    return String.fromCodePoint(code)
  } catch {
    return fallback
  }
}

/**
 * 还原 HTML 实体（命名实体 + 十进制 / 十六进制数值实体）
 */
export function unescapeHtml(input: string): string {
  if (!input) return ''
  return input.replace(ENTITY_PATTERN, (match, entity: string) => {
    const named = HTML_ENTITY_MAP[`&${entity};`]
    if (named !== undefined) return named

    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      return fromCodePoint(Number.parseInt(entity.slice(2), 16), match)
    }
    if (entity.startsWith('#')) {
      return fromCodePoint(Number.parseInt(entity.slice(1), 10), match)
    }
    return match
  })
}

/**
 * 剥离 HTML 标签，返回纯文本
 *
 * 采用与 `striptags` 等价的状态机实现：标签（含属性、引号、注释）被整体丢弃，
 * 标签之外的文本原样保留；`< ` 这种不构成标签的情况保留为 `< `。
 */
export function stripHtml(input: unknown = ''): string {
  if (typeof input !== 'string' && !(input instanceof String)) return ''
  const html = String(input)

  const STATE_PLAINTEXT = 0
  const STATE_HTML = 1
  const STATE_COMMENT = 2

  let state = STATE_PLAINTEXT
  let tagBuffer = ''
  let depth = 0
  let inQuoteChar = ''
  let output = ''

  const { length } = html
  for (let idx = 0; idx < length; idx++) {
    const char = html[idx]

    if (state === STATE_PLAINTEXT) {
      if (char === '<') {
        state = STATE_HTML
        tagBuffer += char
      } else {
        output += char
      }
      continue
    }

    if (state === STATE_HTML) {
      switch (char) {
        case '<':
          // 引号内的 '<' 视为属性值内容
          if (inQuoteChar) break
          depth++
          break
        case '>':
          if (inQuoteChar) break
          if (depth) {
            depth--
            break
          }
          inQuoteChar = ''
          state = STATE_PLAINTEXT
          tagBuffer = ''
          break
        case '"':
        case '\'':
          if (char === inQuoteChar) {
            inQuoteChar = ''
          } else {
            inQuoteChar = inQuoteChar || char
          }
          tagBuffer += char
          break
        case '-':
          if (tagBuffer === '<!-') state = STATE_COMMENT
          tagBuffer += char
          break
        case ' ':
        case '\n':
          if (tagBuffer === '<') {
            state = STATE_PLAINTEXT
            output += '< '
            tagBuffer = ''
            break
          }
          tagBuffer += char
          break
        default:
          tagBuffer += char
          break
      }
      continue
    }

    // STATE_COMMENT
    if (char === '>') {
      if (tagBuffer.slice(-2) === '--') state = STATE_PLAINTEXT
      tagBuffer = ''
    } else {
      tagBuffer += char
    }
  }

  return output
}

/**
 * 清洗 HTML 内容为纯文本：
 * 1. 剥离 HTML 标签
 * 2. 还原命名实体与十进制 / 十六进制数值实体
 * 3. 压缩空白字符
 */
export function cleanText(input?: string | null): string {
  if (!input) return ''
  return unescapeHtml(stripHtml(input)).replace(/\s+/g, ' ').trim()
}
