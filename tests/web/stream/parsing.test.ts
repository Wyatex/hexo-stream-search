/**
 * syncJsonlStream —— JSONL 流解析：分块拼接、多字节字符、换行符与容错
 */
import { describe, expect, it } from 'vitest'
import { jsonlFetch, splitBytes } from '../../helpers/http'
import { buildSite, byteLength, encode, metaLine, postLine } from '../../helpers/jsonl'
import { runSync } from '../../helpers/sync'

describe('syncJsonlStream：JSONL 解析', () => {
  it('解析 meta 行与文章行并写入本地缓存', async () => {
    const { result, localMap, documents, metas, progress } = await runSync({
      fetchImpl: jsonlFetch([metaLine(['b/', 'a/'], [2, 1]), postLine('b/', 2), postLine('a/', 1)]).fetch,
    })

    expect(metas).toEqual([{ _type: 'meta', total: 2, allIds: ['b/', 'a/'], allM: [2, 1] }])
    expect(documents).toEqual([
      { id: 'b/', kind: 'new' },
      { id: 'a/', kind: 'new' },
    ])
    expect(result).toMatchObject({ canceledEarly: false, scannedCount: 2, totalCount: 2, resumed: false })
    expect(result.toPut.map((doc) => doc.id)).toEqual(['b/', 'a/'])
    expect(result.toDelete).toEqual([])
    expect([...localMap.keys()]).toEqual(['b/', 'a/'])
    expect(progress.at(-1)).toMatchObject({ loaded: 2, total: 2, percent: 100 })
  })

  it('文章行经过 processPost 生成词频与文档长度', async () => {
    const { localMap } = await runSync({
      fetchImpl: jsonlFetch([metaLine(['a/'], [1]), postLine('a/', 1, { t: 'TypeScript', c: 'typescript' })]).fetch,
    })

    const doc = localMap.get('a/')!
    expect(doc.tf.typescript).toBeGreaterThan(0)
    expect(doc.dl).toBeGreaterThan(0)
  })

  it('跨数据块的半行被正确拼接', async () => {
    const line = postLine('a/', 1)
    const { result } = await runSync({
      fetchImpl: jsonlFetch([metaLine(['a/'], [1]), line.slice(0, 20), line.slice(20)]).fetch,
    })

    expect(result.toPut.map((doc) => doc.id)).toEqual(['a/'])
  })

  it('单个数据块包含多行时逐行处理', async () => {
    const site = buildSite(3)
    const { result } = await runSync({ fetchImpl: jsonlFetch([site.text]).fetch })

    expect(result.toPut).toHaveLength(3)
    expect(result.finalSyncState?.byteOffset).toBe(site.bytes.byteLength)
  })

  it('1 字节分块传输仍能完整解析', async () => {
    const site = buildSite(3)
    const { result, localMap } = await runSync({ fetchImpl: jsonlFetch(splitBytes(site.bytes, 1)).fetch })

    expect(result.toPut).toHaveLength(3)
    expect(localMap.get(site.ids[2])?.t).toBe(`Title ${site.ids[2]}`)
    expect(result.finalSyncState).toMatchObject({ status: 'completed', byteOffset: site.bytes.byteLength })
  })

  it('多字节 UTF-8 字符被切断在 chunk 边界时不产生乱码，且提交偏移严格对齐行尾', async () => {
    const articles = [
      { id: 'cjk/', t: '深入解析 UTF-8 编码 🚀🔥', c: '日文カタカナ、韩文한국어、简体中文与繁體字' },
      { id: 'emoji/', t: 'ZWJ 👨‍💻 👩‍👩‍👧‍👦 𝄞 𠮷野家', c: '4 字节字符：🌟🎉🦄💡💎' },
      { id: 'latin/', t: 'Café naïve München', c: 'Привет мир α β γ Ω' },
    ]
    // 混用 CRLF 与 LF
    const lines = [
      metaLine(articles.map((a) => a.id), [3, 2, 1]),
      postLine(articles[0].id, 3, { t: articles[0].t, c: articles[0].c }, '\r\n'),
      postLine(articles[1].id, 2, { t: articles[1].t, c: articles[1].c }),
      postLine(articles[2].id, 1, { t: articles[2].t, c: articles[2].c }, '\r\n'),
    ]
    const expectedOffsets = lines.slice(1).map((_, i) => byteLength(lines.slice(0, i + 2).join('')))

    const { result, localMap, batches } = await runSync({
      batchSize: 1,
      fetchImpl: jsonlFetch(splitBytes(encode(lines.join('')), 1)).fetch,
    })

    const committed = batches.map((batch) => batch.syncState.byteOffset)
    for (const offset of expectedOffsets) expect(committed).toContain(offset)

    expect(result.scannedCount).toBe(3)
    for (const article of articles) {
      const doc = localMap.get(article.id)!
      expect(doc.t).toBe(article.t)
      expect(doc.c).toBe(article.c)
      expect(`${doc.t}${doc.c}`).not.toContain('\uFFFD')
    }
  })

  it('CRLF 行尾不影响 JSON 解析', async () => {
    const site = buildSite(2, { eol: '\r\n' })
    const { result } = await runSync({ fetchImpl: jsonlFetch([site.text]).fetch })

    expect(result.toPut.map((doc) => doc.id)).toEqual(site.ids)
    expect(result.finalSyncState?.byteOffset).toBe(site.bytes.byteLength)
  })

  it('最后一行没有换行符时仍会被处理并判定完成', async () => {
    const site = buildSite(3)
    const text = site.text.trimEnd()
    const { result, localMap } = await runSync({ fetchImpl: jsonlFetch([text]).fetch })

    expect(localMap.has(site.ids[2])).toBe(true)
    expect(result.scannedCount).toBe(3)
    expect(result.finalSyncState).toMatchObject({ status: 'completed', byteOffset: byteLength(text) })
  })

  it('跳过空行、空白行与无法解析的残缺行', async () => {
    const { result, localMap } = await runSync({
      fetchImpl: jsonlFetch([
        metaLine(['a/', 'b/'], [2, 1]),
        'INVALID_JSON_LINE\n',
        postLine('a/', 2),
        '{ "id": "broken" \n',
        '   \n',
        '123\n',
        postLine('b/', 1),
        '\n\n',
      ]).fetch,
    })

    expect(result.toPut.map((doc) => doc.id)).toEqual(['a/', 'b/'])
    expect(result.scannedCount).toBe(2)
    expect(localMap.size).toBe(2)
  })

  it('没有 meta 行的旧格式索引按文章行全量处理', async () => {
    const { result } = await runSync({ fetchImpl: jsonlFetch([postLine('a/', 1), postLine('b/', 2)]).fetch })

    expect(result.toPut).toHaveLength(2)
    expect(result.totalCount).toBe(2)
    expect(result.finalSyncState?.status).toBe('completed')
  })
})
