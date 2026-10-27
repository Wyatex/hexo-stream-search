/**
 * search-worker.js —— 浏览器 Worker 入口
 *
 * 技术栈：Fetch Stream + IndexedDB 增量持久化 + Intl.Segmenter 中英文分词
 *        + BM25 排序 + 词条协同奖励与短语精确命中
 *
 * 该文件仅做「Worker 全局作用域 ↔ 搜索引擎」的接线，核心逻辑位于 src/web/core。
 */
import { createEngine } from './core/engine'
import type { WorkerInboundMessage } from '../shared/types'

interface WorkerScope {
  onmessage: ((event: { data: unknown }) => void) | null
  postMessage(message: unknown): void
}

const scope = globalThis as unknown as WorkerScope

const engine = createEngine({
  postMessage: (message) => scope.postMessage(message),
})

scope.onmessage = async (event: { data: unknown }): Promise<void> => {
  await engine.handleMessage(event.data as WorkerInboundMessage)
}
