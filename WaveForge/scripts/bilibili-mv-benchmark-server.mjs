import express from 'express'
import { registerBilibiliRoutes } from '../server/bilibili-api.mjs'

const port = Number(process.env.PORT || 3011)
const app = express()
app.use(express.json({ limit: '1mb' }))
registerBilibiliRoutes(app)
app.get('/health', (_req, res) => res.json({ ok: true }))

const server = app.listen(port, '127.0.0.1', () => {
  console.log(`[bilibili-mv-benchmark] api ready on http://127.0.0.1:${port}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
