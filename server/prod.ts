import http from 'node:http'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { handleRpcProxy } from './rpcProxy'

const host = process.env.HOST ?? '127.0.0.1'
const port = Number(process.env.PORT ?? 4173)
const distDir = path.resolve(process.cwd(), 'dist')

const mimeByExt: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

function safeJoin(baseDir: string, requestPath: string): string | null {
  const withoutQuery = requestPath.split('?')[0]?.split('#')[0] ?? '/'
  const decoded = decodeURIComponent(withoutQuery)
  const joined = path.join(baseDir, decoded)
  const normalized = path.normalize(joined)
  if (!normalized.startsWith(baseDir)) return null
  return normalized
}

async function tryReadFile(filePath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(filePath)
  } catch {
    return null
  }
}

const server = http.createServer(async (req, res) => {
  const url = req.url ?? '/'
  if (url.startsWith('/api/rpc')) {
    await handleRpcProxy(req, res)
    return
  }

  const candidatePath = safeJoin(distDir, url)
  if (!candidatePath) {
    res.statusCode = 400
    res.end('Bad Request')
    return
  }

  const isDirLike = candidatePath.endsWith(path.sep)
  const filePath = isDirLike ? path.join(candidatePath, 'index.html') : candidatePath
  const ext = path.extname(filePath)

  const direct = await tryReadFile(filePath)
  if (direct) {
    res.statusCode = 200
    res.setHeader('content-type', mimeByExt[ext] ?? 'application/octet-stream')
    res.end(direct)
    return
  }

  const index = await tryReadFile(path.join(distDir, 'index.html'))
  if (!index) {
    res.statusCode = 500
    res.end('Missing dist/index.html. Run `npm run build` first.')
    return
  }

  res.statusCode = 200
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(index)
})

server.listen(port, host, () => {
  console.log(`Fiber Nodes Monits: http://${host}:${port}`)
})
