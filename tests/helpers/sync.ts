/**
 * syncJsonlStream 驱动器：填充默认参数并记录全部回调
 */
import { processPost } from '../../src/web/core/index-store'
import { syncJsonlStream, type StreamSyncOptions, type StreamSyncResult } from '../../src/web/core/stream'
import type { IndexedDoc, IndexSyncState, SearchMetaRecord, SearchProgress } from '../../src/shared/types'
import { DEFAULT_URL } from './jsonl'

export interface CommittedBatch {
  toPut: IndexedDoc[]
  toDelete: string[]
  syncState: IndexSyncState
}

export interface SyncRun {
  result: StreamSyncResult
  localMap: Map<string, IndexedDoc>
  /** onDocument 回调序列 */
  documents: Array<{ id: string; kind: 'new' | 'cached' }>
  /** onDocumentRemoved 回调序列 */
  removed: string[]
  progress: SearchProgress[]
  metas: SearchMetaRecord[]
  batches: CommittedBatch[]
}

export type SyncInput = Partial<Omit<StreamSyncOptions, 'handlers'>> & {
  fetchImpl: typeof fetch
  /** 是否注册 onBatchCommit 记录批次，默认 true */
  recordBatches?: boolean
}

export function startSync(input: SyncInput): { promise: Promise<StreamSyncResult>; run: Omit<SyncRun, 'result'> } {
  const { recordBatches = true, ...options } = input
  const run: Omit<SyncRun, 'result'> = {
    localMap: options.localMap ?? new Map(),
    documents: [],
    removed: [],
    progress: [],
    metas: [],
    batches: [],
  }

  const promise = syncJsonlStream({
    url: DEFAULT_URL,
    processPost,
    ...(recordBatches
      ? {
          onBatchCommit: async (batch: CommittedBatch) => {
            run.batches.push({ ...batch, toPut: [...batch.toPut], toDelete: [...batch.toDelete] })
          },
        }
      : {}),
    ...options,
    localMap: run.localMap,
    handlers: {
      onMeta: (meta) => run.metas.push(meta),
      onDocument: (doc, kind) => run.documents.push({ id: doc.id, kind }),
      onDocumentRemoved: (id) => run.removed.push(id),
      onProgress: (progress) => run.progress.push(progress),
    },
  })

  return { promise, run }
}

export async function runSync(input: SyncInput): Promise<SyncRun> {
  const { promise, run } = startSync(input)
  const result = await promise
  return { ...run, result }
}
