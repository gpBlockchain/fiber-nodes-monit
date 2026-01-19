import type { IncomingMessage, ServerResponse } from 'node:http'

type RpcProxyRequestBody = {
  url: string
  token?: string
  method: string
  params?: unknown
  id?: string | number | null
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return null
  return JSON.parse(text) as unknown
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown) {
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function setCors(res: ServerResponse) {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS')
  res.setHeader('access-control-allow-headers', 'content-type')
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

export async function handleRpcProxy(req: IncomingMessage, res: ServerResponse) {
  setCors(res)

  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return
  }

  if (req.method !== 'POST') {
    writeJson(res, 405, { error: 'Method Not Allowed' })
    return
  }

  let bodyUnknown: unknown
  try {
    bodyUnknown = await readJsonBody(req)
  } catch (err) {
    writeJson(res, 400, { error: 'Invalid JSON body', details: String(err) })
    return
  }

  const body = bodyUnknown as Partial<RpcProxyRequestBody> | null
  if (!body || typeof body !== 'object') {
    writeJson(res, 400, { error: 'Body must be a JSON object' })
    return
  }

  if (typeof body.url !== 'string' || !isHttpUrl(body.url)) {
    writeJson(res, 400, { error: 'Invalid url, must be http(s) URL' })
    return
  }
  if (typeof body.method !== 'string' || !body.method.trim()) {
    writeJson(res, 400, { error: 'Invalid method' })
    return
  }
  if (body.token != null && typeof body.token !== 'string') {
    writeJson(res, 400, { error: 'Invalid token' })
    return
  }

  const id = body.id ?? globalThis.crypto?.randomUUID?.() ?? Date.now()
  const payload: Record<string, unknown> = {
    jsonrpc: '2.0',
    id,
    method: body.method,
  }

  if (body.params !== undefined) {
    if (Array.isArray(body.params)) {
      payload.params = body.params
    } else if (body.params === null) {
      payload.params = []
    } else {
      payload.params = [body.params]
    }
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (body.token) headers.authorization = `Bearer ${body.token}`

  let upstreamText: string
  let upstreamStatus = 200
  let upstreamContentType = 'application/json; charset=utf-8'

  try {
    const upstream = await fetch(body.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    })
    upstreamStatus = upstream.status
    upstreamContentType =
      upstream.headers.get('content-type') ?? 'application/json; charset=utf-8'
    upstreamText = await upstream.text()
  } catch (err) {
    writeJson(res, 502, { error: 'Upstream RPC request failed', details: String(err) })
    return
  }

  res.statusCode = upstreamStatus
  res.setHeader('content-type', upstreamContentType)
  res.end(upstreamText)
}

