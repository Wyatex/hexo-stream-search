/**
 * HTTP 模拟：可控的 ReadableStream / Response / fetch，以及支持 Range 的静态文件服务器
 */
import { encode } from './jsonl'

export type Chunk = string | Uint8Array

export interface StreamOptions {
  /** 数据推送完毕后保持连接不关闭（用于验证调用方主动 cancel） */
  keepOpen?: boolean
  /** 推送到第 n 个 chunk 时让流出错（模拟网络中断） */
  errorAtChunk?: number
  /** 出错信息 */
  errorMessage?: string
  /** 流被 cancel 时回调 */
  onCancel?: (reason?: unknown) => void
  /** cancel 时抛错（验证调用方容错） */
  throwOnCancel?: boolean
}

export interface TrackedStream {
  stream: ReadableStream<Uint8Array>
  /** 已被拉取的 chunk 下标 */
  pulled: number[]
}

/** 按 chunk 逐个推送的可追踪流 */
export function trackedStream(chunks: Chunk[], options: StreamOptions = {}): TrackedStream {
  const pulled: number[] = []
  let index = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (options.errorAtChunk !== undefined && index === options.errorAtChunk) {
        controller.error(new Error(options.errorMessage ?? 'Simulated network failure'))
        return
      }
      if (index >= chunks.length) {
        if (!options.keepOpen) controller.close()
        return
      }
      pulled.push(index)
      const chunk = chunks[index++]
      controller.enqueue(typeof chunk === 'string' ? encode(chunk) : chunk)
    },
    cancel(reason) {
      options.onCancel?.(reason)
      if (options.throwOnCancel) throw new Error('Simulated cancel failure')
    },
  })
  return { stream, pulled }
}

export function streamOf(chunks: Chunk[], options: StreamOptions = {}): ReadableStream<Uint8Array> {
  return trackedStream(chunks, options).stream
}

/** 把字节按固定大小切片 */
export function splitBytes(bytes: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = []
  for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.subarray(i, i + size))
  return chunks
}

export interface RecordedRequest {
  url: string
  /** 是否传入了 RequestInit */
  hasInit: boolean
  headers: Headers
}

export interface MockFetch {
  fetch: typeof fetch
  requests: RecordedRequest[]
}

/** 记录每次请求并交给 handler 生成响应 */
export function mockFetch(handler: (request: RecordedRequest, index: number) => Response | Promise<Response>): MockFetch {
  const requests: RecordedRequest[] = []
  const impl = async (input: string, init?: RequestInit): Promise<Response> => {
    const request: RecordedRequest = {
      url: String(input),
      hasInit: init !== undefined,
      headers: new Headers(init?.headers),
    }
    requests.push(request)
    return handler(request, requests.length - 1)
  }
  return { fetch: impl as unknown as typeof fetch, requests }
}

/** 每次请求都返回同一组 chunk 的 200 响应 */
export function jsonlFetch(
  chunks: Chunk[],
  init: ResponseInit = {},
  streamOptions: StreamOptions = {},
): MockFetch {
  return mockFetch(() => new Response(streamOf(chunks, streamOptions), { status: 200, ...init }))
}

export interface StaticServerOptions {
  etag?: string
  lastModified?: string
  /** 本次连接只发送到该字节位置（不含），用于模拟中途断开 */
  cutoff?: number
  /** 到达 cutoff 时的断开方式：正常关闭（clean EOF）或报错 */
  end?: 'close' | 'error'
  /** 推送的 chunk 大小（字节） */
  chunkSize?: number
  /** 是否支持 Range，默认 true；为 false 时忽略 Range 永远返回 200 全量 */
  supportsRange?: boolean
}

/**
 * 静态 JSONL 文件服务器
 *
 * 带 `Range: bytes=<n>-` 时返回 206 + Content-Range，否则返回 200 全量。
 */
export function staticServer(bytes: Uint8Array, options: StaticServerOptions = {}): MockFetch {
  return mockFetch((request) => {
    const range = options.supportsRange === false ? null : request.headers.get('range')
    const match = range?.match(/^bytes=(\d+)-$/)
    const start = match ? Number(match[1]) : 0
    const end = Math.max(start, Math.min(options.cutoff ?? bytes.length, bytes.length))

    const headers: Record<string, string> = {}
    if (options.etag) headers.ETag = options.etag
    if (options.lastModified) headers['Last-Modified'] = options.lastModified
    if (start > 0) headers['Content-Range'] = `bytes ${start}-${bytes.length - 1}/${bytes.length}`

    const chunks = splitBytes(bytes.subarray(start, end), options.chunkSize ?? 512)
    const stream = streamOf(chunks, {
      errorAtChunk: options.end === 'error' ? chunks.length : undefined,
      errorMessage: 'Simulated connection drop',
    })
    return new Response(stream, { status: start > 0 ? 206 : 200, headers })
  })
}

/** 304 Not Modified */
export function notModifiedServer(): MockFetch {
  return mockFetch(() => new Response(null, { status: 304 }))
}
