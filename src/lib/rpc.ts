import type { MonitoredNode } from './storage'

type JsonRpcError = {
  code: number
  message: string
  data?: unknown
}

type JsonRpcEnvelope<T> =
  | { jsonrpc: '2.0'; id: string | number | null; result: T }
  | { jsonrpc: '2.0'; id: string | number | null; error: JsonRpcError }

export async function callFiberRpc<T>(
  node: MonitoredNode,
  method: string,
  params?: unknown,
): Promise<T> {
  const res = await fetch('/api/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      url: node.rpcUrl,
      token: node.token,
      method,
      params,
    }),
  })

  const text = await res.text()
  let json: unknown
  try {
    json = JSON.parse(text) as unknown
  } catch {
    throw new Error(`RPC响应不是JSON (HTTP ${res.status})`)
  }

  const envelope = json as JsonRpcEnvelope<T>
  if ('error' in envelope) {
    throw new Error(envelope.error?.message ?? 'RPC error')
  }
  if (!('result' in envelope)) {
    throw new Error('RPC响应缺少result')
  }
  return envelope.result
}

