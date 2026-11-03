/**
 * syncJsonlStream —— 分批持久化、进度节流与流完成态判定
 */
import { describe, expect, it } from 'vitest'
import { processPost } from '../../../src/web/core/index-store'
import { syncJsonlStream } from '../../../src/web/core/stream'
import type { IndexedDoc, IndexSyncState } from '../../../src/shared/types'
import { jsonlFetch, mockFetch, splitBytes, streamOf } from '../../helpers/http'
import { buildSite, cacheOf, cachedDoc, DEFAULT_URL, metaLine, postLine } from '../../helpers/jsonl'
import { runSync } from '../../helpers/sync'

describe('syncJsonlStream：分批持久化与进度上报', () => {
  describe('分批持久化（onBatchCommit / onPersistBatch）', () => {
    it('按 batchSize 分批触发提交，且每次提交的 byteOffset 严格单调对齐行尾', async () => {
      const site = buildSite(120)
      const { result, batches } = await runSync({
        batchSize: 50,
        fetchImpl: jsonlFetch(site.lines).fetch,
      })

      // 首行 meta 提交 1 次初始状态，随后按 50 + 50 + 20 分 3 批提交文章
      const articleBatches = batches.filter((b) => b.toPut.length > 0)
      expect(articleBatches.map((b) => ({ count: b.toPut.length, status: b.syncState.status }))).toEqual([
        { count: 50, status: 'syncing' },
        { count: 50, status: 'syncing' },
        { count: 20, status: 'completed' },
      ])

      for (let i = 1; i < batches.length; i++) {
        expect(batches[i].syncState.byteOffset).toBeGreaterThanOrEqual(batches[i - 1].syncState.byteOffset)
      }
      for (const batch of batches) {
        expect(site.lineEnds).toContain(batch.syncState.byteOffset)
      }
      expect(result.finalSyncState).toMatchObject({
        status: 'completed',
        completed: true,
        byteOffset: site.bytes.byteLength,
        scannedCount: 120,
      })
    })

    it('未达到 batchSize 但超过 batchIntervalMs 时按时间窗口刷新批次', async () => {
      const site = buildSite(5)
      let clock = 1000
      const { batches } = await runSync({
        batchSize: 50,
        batchIntervalMs: 500,
        now: () => {
          clock += 300
          return clock
        },
        fetchImpl: jsonlFetch(site.lines).fetch,
      })

      // 在流结束前就已经因为时间间隔触发了中间批次刷新
      const syncingArticleBatches = batches.filter((b) => b.toPut.length > 0 && b.syncState.status === 'syncing')
      expect(syncingArticleBatches.length).toBeGreaterThanOrEqual(1)
      expect(batches.reduce((sum, b) => sum + b.toPut.length, 0)).toBe(5)
      expect(batches.at(-1)?.syncState.status).toBe('completed')
    })

    it('扫描到未变更缓存行时，若缓冲区已有待提交新文档且到达时间阈值也会触发刷新', async () => {
      // 第 0 篇为新文章，第 1 篇命中缓存，第 2 篇为新文章（保证第 1 篇不会触发提前断流）
      const ids = ['p0/', 'p1/', 'p2/']
      const ms = [300, 200, 100]
      const localMap = cacheOf([cachedDoc('p1/', 200)])
      let clock = 0

      const { batches } = await runSync({
        localMap,
        batchSize: 50,
        batchIntervalMs: 100,
        now: () => {
          clock += 60
          return clock
        },
        fetchImpl: jsonlFetch([
          metaLine(ids, ms),
          postLine('p0/', 300),
          postLine('p1/', 200),
          postLine('p2/', 100),
        ]).fetch,
      })

      const articleBatches = batches.filter((b) => b.toPut.length > 0)
      expect(articleBatches.map((b) => b.toPut.map((d) => d.id))).toEqual([['p0/'], ['p2/']])
    })

    it('兼容 onPersistBatch 别名参数', async () => {
      const site = buildSite(3)
      const persisted: IndexSyncState[] = []

      await syncJsonlStream({
        url: DEFAULT_URL,
        localMap: new Map<string, IndexedDoc>(),
        handlers: { onDocument: () => {} },
        processPost,
        batchSize: 2,
        onPersistBatch: async (batch) => {
          persisted.push(batch.syncState)
        },
        fetchImpl: jsonlFetch(site.lines).fetch,
      })

      expect(persisted.length).toBeGreaterThanOrEqual(2)
      expect(persisted.at(-1)?.status).toBe('completed')
    })
  })

  describe('进度上报节流（throttleMs）', () => {
    it('节流窗口内合并中间进度，首行 meta 与完成终态强制上报', async () => {
      const site = buildSite(10)
      let clock = 100

      const { progress } = await runSync({
        throttleMs: 50,
        now: () => {
          clock += 10
          return clock
        },
        fetchImpl: jsonlFetch(site.lines).fetch,
      })

      // 首行 meta 强制上报 loaded=0，中间按每 50ms 节流，终态强制上报 100%
      expect(progress[0]).toMatchObject({ loaded: 0, total: 10, percent: 0 })
      expect(progress.length).toBeLessThan(10)
      expect(progress.at(-1)).toMatchObject({ loaded: 10, total: 10, percent: 100, updated: 10, scanned: 10 })
    })
  })

  describe('流完成态判定（自然截断 vs 正常完成）', () => {
    const site = buildSite(10)

    it.each([
      { name: 'meta 行半中间截断', cutoff: Math.floor(site.lineEnds[0] / 2), expectedScanned: 0, expectedOffset: 0 },
      { name: 'meta 行刚结束（0 篇文章）截断', cutoff: site.lineEnds[0], expectedScanned: 0, expectedOffset: site.lineEnds[0] },
      { name: '第 1 篇文章半中间截断', cutoff: site.lineEnds[0] + 15, expectedScanned: 0, expectedOffset: site.lineEnds[0] },
      { name: '第 4 篇文章完整结束处截断', cutoff: site.lineEnds[4], expectedScanned: 4, expectedOffset: site.lineEnds[4] },
      { name: '第 9 篇文章结束（差最后 1 篇）截断', cutoff: site.lineEnds[9], expectedScanned: 9, expectedOffset: site.lineEnds[9] },
    ])('流在$name发生自然 EOF 时保持 syncing 状态以便后续续传', async ({ cutoff, expectedScanned, expectedOffset }) => {
      const truncated = site.bytes.subarray(0, cutoff)
      const { result, batches } = await runSync({
        fetchImpl: mockFetch(
          () => new Response(streamOf(splitBytes(truncated, 64)), { status: 200, headers: { ETag: '"eof"' } }),
        ).fetch,
      })

      expect(result.scannedCount).toBe(expectedScanned)
      expect(result.finalSyncState).toMatchObject({
        status: 'syncing',
        completed: false,
        byteOffset: expectedOffset,
        scannedCount: expectedScanned,
        etag: '"eof"',
      })
      expect(batches.at(-1)?.syncState.status).toBe('syncing')
    })
  })
})
