import express from 'express'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  flashRequestSchema,
  FlasherError,
  getJob,
  getSystemStatus,
  listSerialPorts,
  startFlash,
  subscribeToJob,
} from './flasher.js'

const app = express()
const port = Number(process.env.PORT ?? 8787)
const clientBuild = join(process.cwd(), 'client/dist/bnb-flasher-ui/browser')

app.disable('x-powered-by')
app.use(express.json({ limit: '16kb' }))

app.get('/api/status', (_request, response) => {
  response.json(getSystemStatus())
})

app.get('/api/ports', async (_request, response, next) => {
  try {
    response.json(await listSerialPorts())
  } catch (error) {
    next(error)
  }
})

app.post('/api/flash', async (request, response, next) => {
  const parsed = flashRequestSchema.safeParse(request.body)
  if (!parsed.success) {
    response.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid firmware settings.' })
    return
  }

  try {
    response.status(202).json(await startFlash(parsed.data))
  } catch (error) {
    next(error)
  }
})

app.get('/api/jobs/:jobId', (request, response) => {
  const job = getJob(request.params.jobId)
  if (!job) {
    response.status(404).json({ error: 'Flash job not found.' })
    return
  }
  response.json(job)
})

app.get('/api/jobs/:jobId/events', (request, response) => {
  const initial = getJob(request.params.jobId)
  if (!initial) {
    response.status(404).json({ error: 'Flash job not found.' })
    return
  }

  response.setHeader('Content-Type', 'text/event-stream')
  response.setHeader('Cache-Control', 'no-cache, no-transform')
  response.setHeader('Connection', 'keep-alive')
  response.flushHeaders()

  const sendUpdate = (update: typeof initial) => {
    response.write(`data: ${JSON.stringify(update)}\n\n`)
    if (update.state === 'success' || update.state === 'failed') response.end()
  }
  const unsubscribe = subscribeToJob(request.params.jobId, sendUpdate)
  request.on('close', unsubscribe)
  sendUpdate(getJob(request.params.jobId) ?? initial)
  const latest = getJob(request.params.jobId)
  if (latest?.state === 'success' || latest?.state === 'failed') unsubscribe()
})

app.use('/api', (_request, response) => {
  response.status(404).json({ error: 'API route not found.' })
})

if (existsSync(clientBuild)) {
  app.use(express.static(clientBuild))
  app.get(/.*/, (_request, response) => response.sendFile(join(clientBuild, 'index.html')))
}

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  if (error instanceof FlasherError) {
    response.status(error.statusCode).json({ error: error.message })
    return
  }
  const message = error instanceof Error ? error.message : 'Unexpected server error.'
  response.status(500).json({ error: message })
})

app.listen(port, '127.0.0.1', () => {
  console.log(`BNB Flasher API listening at http://127.0.0.1:${port}`)
})