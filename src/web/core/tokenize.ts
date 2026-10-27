import { STOP_WORDS } from '../../shared/constants'

let segmenter: Intl.Segmenter | undefined | null = null

/** 获取分词器（浏览器 / Worker / Node 均可用；不可用时返回 undefined 走兜底分词） */
export function getSegmenter(): Intl.Segmenter | undefined {
  if (segmenter !== null) return segmenter ?? undefined
  segmenter =
    typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
      ? new Intl.Segmenter('zh-CN', { granularity: 'word' })
      : undefined
  return segmenter ?? undefined
}

/** 规范化特殊技术词汇：C++ → cpp、C# → csharp */
export function normalizeTechTerms(text: string): string {
  return String(text).replace(/c\+\+/gi, 'cpp').replace(/c\#/gi, 'csharp')
}

/**
 * 兜底分词（环境不支持 Intl.Segmenter 时使用）
 *
 * 英文按单词切分，中文按二元组切分，精度低于 Intl.Segmenter 但保证可用。
 */
export function fallbackTokenize(text?: string | null): string[] {
  if (!text) return []
  const normalized = normalizeTechTerms(text).toLowerCase()
  const chunks = normalized.match(/[a-z0-9_+#.-]+|[\u4e00-\u9fff]+/g) ?? []
  const tokens: string[] = []

  for (const chunk of chunks) {
    if (/^[\u4e00-\u9fff]+$/.test(chunk)) {
      for (let i = 0; i < chunk.length; i++) {
        tokens.push(chunk.slice(i, i + 2))
      }
    } else {
      tokens.push(chunk)
    }
  }

  return tokens
}

/**
 * 分词：小英文单词按空格切分，中文按词切分
 */
export function tokenize(text?: string | null): string[] {
  if (!text) return []

  const normalized = normalizeTechTerms(text)
  const currentSegmenter = getSegmenter()
  if (!currentSegmenter) return fallbackTokenize(normalized)

  const tokens: string[] = []
  for (const { segment, isWordLike } of currentSegmenter.segment(normalized)) {
    if (isWordLike) {
      const lower = segment.toLowerCase().trim()
      if (lower) tokens.push(lower)
    }
  }
  return tokens
}

/** 是否为停用词 */
export function isStopWord(token: string): boolean {
  return STOP_WORDS.has(token)
}

/**
 * 过滤停用词
 *
 * 与既有实现一致：多词查询时剔除泛停用词；若剔除后为空则保留原词。
 */
export function filterStopWords(tokens: string[]): string[] {
  if (tokens.length <= 1) return tokens
  const nonStop = tokens.filter((token) => !STOP_WORDS.has(token))
  return nonStop.length > 0 ? nonStop : tokens
}
