import { SNIPPET_WINDOW, STOP_WORDS } from '../../shared/constants'

/** HTML 转义，防止正文中的标签造成 XSS 或排版异常 */
export function escapeHtml(str?: string | null): string {
  if (!str) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 转义正则特殊字符 */
export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 高亮命中的关键词
 *
 * 必须先做 HTML 转义，再包裹 `<mark class="search-keyword">`；
 * 长词优先匹配，避免短词把长词截断。
 */
export function highlightText(text: string, terms: string[], rawQuery: string): string {
  if (!text) return ''
  const safeText = escapeHtml(text)

  const candidates: string[] = []
  if (rawQuery && rawQuery.trim().length > 1) {
    candidates.push(escapeHtml(rawQuery.trim()))
  }
  for (const term of terms) {
    if (term.length > 1 || (term.length === 1 && !STOP_WORDS.has(term))) {
      candidates.push(escapeHtml(term))
    }
  }

  if (candidates.length === 0) return safeText

  const sorted = [...new Set(candidates)].sort((a, b) => b.length - a.length)
  const pattern = new RegExp(`(${sorted.map(escapeRegExp).join('|')})`, 'gi')

  return safeText.replace(pattern, '<mark class="search-keyword">$1</mark>')
}

/**
 * 生成智能摘要：围绕最佳命中位置截取上下文
 */
export function buildSnippet(
  content: string,
  terms: string[],
  rawQuery: string,
  windowSize: number = SNIPPET_WINDOW,
): string {
  if (!content) return ''
  const lowerContent = content.toLowerCase()
  let bestIdx = -1

  // 1. 优先定位完整查询词
  if (rawQuery && rawQuery.trim().length > 1) {
    bestIdx = lowerContent.indexOf(rawQuery.trim().toLowerCase())
  }

  // 2. 否则定位最长 / 信息量最大的检索词所在位置
  if (bestIdx === -1) {
    const validTerms = terms
      .filter((t) => t.length > 1 || !STOP_WORDS.has(t))
      .sort((a, b) => b.length - a.length)
    for (const term of validTerms) {
      const idx = lowerContent.indexOf(term)
      if (idx !== -1) {
        bestIdx = idx
        break
      }
    }
  }

  const start = bestIdx === -1 ? 0 : Math.max(0, bestIdx - 35)
  const end = Math.min(content.length, start + windowSize)
  let snippet = content.slice(start, end)

  if (start > 0) snippet = `...${snippet}`
  if (end < content.length) snippet = `${snippet}...`

  return highlightText(snippet, terms, rawQuery)
}
