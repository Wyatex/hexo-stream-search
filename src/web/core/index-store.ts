import {
  ALL_TERMS_MATCH_BOOST,
  BM25_B,
  BM25_K1,
  CATEGORY_WEIGHT,
  CONTENT_WEIGHT,
  EXACT_PHRASE_BOOST,
  EXACT_TITLE_BOOST,
  TAG_WEIGHT,
  TITLE_WEIGHT,
} from '../../shared/constants'
import type { IndexedDoc, SearchPostRecord, SearchResult } from '../../shared/types'
import { buildSnippet, highlightText } from './highlight'
import { filterStopWords, tokenize } from './tokenize'

/**
 * 把 JSONL 文章记录转换为索引文档
 *
 * 按标题 / 标签 / 分类 / 正文分别分词并加权统计词频，同时计算有效文档长度。
 */
export function processPost(raw: SearchPostRecord): IndexedDoc {
  const titleTokens = tokenize(raw.t)
  const tagTokens = tokenize((raw.g || []).join(' '))
  const categoryTokens = tokenize((raw.k || []).join(' '))
  const contentTokens = tokenize(raw.c)

  const tf: Record<string, number> = Object.create(null)

  for (const token of titleTokens) tf[token] = (tf[token] || 0) + TITLE_WEIGHT
  for (const token of tagTokens) tf[token] = (tf[token] || 0) + TAG_WEIGHT
  for (const token of categoryTokens) tf[token] = (tf[token] || 0) + CATEGORY_WEIGHT
  for (const token of contentTokens) tf[token] = (tf[token] || 0) + CONTENT_WEIGHT

  const dl =
    titleTokens.length * TITLE_WEIGHT +
    tagTokens.length * TAG_WEIGHT +
    categoryTokens.length * CATEGORY_WEIGHT +
    contentTokens.length * CONTENT_WEIGHT

  return {
    id: raw.id,
    t: raw.t || '',
    u: raw.u || raw.id,
    m: raw.m || 0,
    g: raw.g || [],
    k: raw.k || [],
    c: raw.c || '',
    dl,
    tf,
  }
}

/**
 * 倒排索引 + 文档字典 + BM25 检索
 *
 * 倒排索引：Map<term, Map<docId, weightedTF>>
 * 文档字典：Map<docId, IndexedDoc>
 */
export class IndexStore {
  private invertedIndex = new Map<string, Map<string, number>>()
  private docStore = new Map<string, IndexedDoc>()
  private totalDocLength = 0
  private avgDocLength = 0

  /** 已索引文档数 */
  get size(): number {
    return this.docStore.size
  }

  /** 词项总数 */
  get termCount(): number {
    return this.invertedIndex.size
  }

  /** 是否已索引某文档 */
  has(docId: string): boolean {
    return this.docStore.has(docId)
  }

  /** 读取文档 */
  getDoc(docId: string): IndexedDoc | undefined {
    return this.docStore.get(docId)
  }

  /** 加入索引（已存在则先移除） */
  addPost(post: IndexedDoc): void {
    if (!post || !post.id) return
    if (this.docStore.has(post.id)) this.removePost(post.id)

    this.docStore.set(post.id, post)
    this.totalDocLength += post.dl

    const tfMap = post.tf || {}
    for (const term in tfMap) {
      let postings = this.invertedIndex.get(term)
      if (!postings) {
        postings = new Map()
        this.invertedIndex.set(term, postings)
      }
      postings.set(post.id, tfMap[term])
    }

    this.avgDocLength = this.docStore.size > 0 ? this.totalDocLength / this.docStore.size : 1
  }

  /** 从索引中移除文档 */
  removePost(docId: string): void {
    const doc = this.docStore.get(docId)
    if (!doc) return

    this.totalDocLength -= doc.dl
    this.docStore.delete(docId)

    const tfMap = doc.tf || {}
    for (const term in tfMap) {
      const postings = this.invertedIndex.get(term)
      if (postings) {
        postings.delete(docId)
        if (postings.size === 0) this.invertedIndex.delete(term)
      }
    }

    this.avgDocLength = this.docStore.size > 0 ? this.totalDocLength / this.docStore.size : 1
  }

  /** 重建索引 */
  buildFrom(posts: Iterable<IndexedDoc>): void {
    this.clear()
    for (const post of posts) this.addPost(post)
  }

  /** 清空索引 */
  clear(): void {
    this.invertedIndex.clear()
    this.docStore.clear()
    this.totalDocLength = 0
    this.avgDocLength = 0
  }

  /**
   * BM25 检索
   *
   * 打分 = BM25 基础分 × 词条协同系数 + 标题 / 短语 / 标签 / 分类加成
   */
  search(query: string, limit = 20): SearchResult[] {
    const rawQuery = (query || '').trim()
    if (!rawQuery || this.docStore.size === 0) return []

    const rawTokens = tokenize(rawQuery)
    if (rawTokens.length === 0) return []

    // 多词检索时剔除泛停用词，提升相关度
    const queryTokens = filterStopWords(rawTokens)
    const uniqueTerms = [...new Set(queryTokens)]
    const lowerQuery = rawQuery.toLowerCase()
    const N = this.docStore.size

    /** 每个文档的得分与命中的词条集合 */
    const docStats = new Map<string, { score: number; matchedTerms: Set<string> }>()

    for (const term of uniqueTerms) {
      let postings = this.invertedIndex.get(term)

      // 短词或技术英文单词的前缀命中回退（例如输入 type 匹配 typescript）
      if (!postings && term.length >= 2 && /^[a-z0-9_-]+$/i.test(term)) {
        for (const [indexedTerm, indexedPostings] of this.invertedIndex.entries()) {
          if (indexedTerm.startsWith(term)) {
            postings = indexedPostings
            break
          }
        }
      }

      if (!postings) continue

      const df = postings.size
      // Lucene / BM25 严格非负 IDF 公式
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))

      for (const [docId, tf] of postings.entries()) {
        const doc = this.docStore.get(docId)
        if (!doc) continue

        const dl = doc.dl || 1
        const numerator = tf * (BM25_K1 + 1)
        const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / this.avgDocLength))
        const termScore = idf * (numerator / denominator)

        let stat = docStats.get(docId)
        if (!stat) {
          stat = { score: 0, matchedTerms: new Set() }
          docStats.set(docId, stat)
        }
        stat.score += termScore
        stat.matchedTerms.add(term)
      }
    }

    const scoredDocs: Array<{ docId: string; score: number }> = []
    const totalTermsCount = uniqueTerms.length

    for (const [docId, stat] of docStats.entries()) {
      const doc = this.docStore.get(docId)
      if (!doc) continue
      let finalScore = stat.score

      // 1. 词条协同加成（Coordination Factor）
      if (totalTermsCount > 1) {
        const coverage = stat.matchedTerms.size / totalTermsCount
        finalScore *= 0.5 + 0.5 * coverage
        if (coverage === 1) finalScore *= ALL_TERMS_MATCH_BOOST
      }

      // 2. 标题完整包含检索词
      const lowerTitle = doc.t.toLowerCase()
      if (lowerTitle.includes(lowerQuery)) {
        finalScore += EXACT_TITLE_BOOST
        if (lowerTitle.startsWith(lowerQuery)) finalScore += EXACT_TITLE_BOOST * 0.5
      }

      // 3. 正文短语精确匹配
      if (rawQuery.length >= 3 && doc.c.toLowerCase().includes(lowerQuery)) {
        finalScore += EXACT_PHRASE_BOOST
      }

      // 4. 标签 / 分类命中加成
      if (doc.g && doc.g.some((tag) => tag.toLowerCase().includes(lowerQuery))) {
        finalScore += TAG_WEIGHT
      }
      if (doc.k && doc.k.some((category) => category.toLowerCase().includes(lowerQuery))) {
        finalScore += CATEGORY_WEIGHT
      }

      scoredDocs.push({ docId, score: finalScore })
    }

    scoredDocs.sort((a, b) => b.score - a.score)
    const topHits = scoredDocs.slice(0, limit)

    return topHits.map(({ docId, score }) => {
      const doc = this.docStore.get(docId)!
      return {
        id: doc.id,
        title: highlightText(doc.t, uniqueTerms, rawQuery),
        url: doc.u.startsWith('/') ? doc.u : `/${doc.u}`,
        updated: doc.m,
        tags: doc.g || [],
        categories: doc.k || [],
        score: Number(score.toFixed(2)),
        snippet: buildSnippet(doc.c, uniqueTerms, rawQuery),
      }
    })
  }
}
