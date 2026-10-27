import type { SearchJsonlRecord, SearchMetaRecord } from '../../shared/types'

/** 判断是否为 JSONL 的元数据行 */
export function isMetaRecord(data: unknown): data is SearchMetaRecord {
  return !!data && typeof data === 'object' && (data as { _type?: unknown })._type === 'meta'
}

/** 解析单行 JSONL，解析失败返回 undefined（跳过残缺行） */
export function parseJsonlLine(line: string): SearchJsonlRecord | undefined {
  const trimmed = line.trim()
  if (!trimmed) return undefined
  try {
    const parsed = JSON.parse(trimmed) as SearchJsonlRecord
    if (!parsed || typeof parsed !== 'object') return undefined
    return parsed
  } catch {
    return undefined
  }
}
