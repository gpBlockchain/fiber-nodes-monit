import http from 'node:http'
import { createServer as createViteServer } from 'vite'
import { handleRpcProxy } from './rpcProxy'

const host = process.env.HOST ?? '127.0.0.1'
const port = Number(process.env.PORT ?? 5173)

const vite = await createViteServer({
  root: process.cwd(),
  server: { middlewareMode: true },
  appType: 'custom',
})

const server = http.createServer(async (req, res) => {
  try {
    const url = req.url ?? '/'
    if (url.startsWith('/api/rpc')) {
      await handleRpcProxy(req, res)
      return
    }

    vite.middlewares(req, res, (err: unknown) => {
      if (!err) return
      vite.ssrFixStacktrace(err as Error)
      res.statusCode = 500
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.end(String(err))
    })
  } catch (err) {
    res.statusCode = 500
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    res.end(String(err))
  }
})

server.listen(port, host, () => {
  console.log(`Fiber Nodes Monits dev: http://${host}:${port}`)
})
