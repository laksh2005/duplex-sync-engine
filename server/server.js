require('./config/env')

const http = require('http')
const app = require('./app')
const { initSyncEngine } = require('./services/syncEngine')
const { initRunner, shutdownRunner } = require('./services/runner')
const { initWebSocket } = require('./websocket')
const { logError, logInfo } = require('./utils/logger')

const port = Number(process.env.PORT || 4000)

async function start() {
  await initSyncEngine()

  const server = http.createServer(app)
  initWebSocket(server)

  const runner = await initRunner()
  server.listen(port, () => {
    logInfo(`server listening on :${port} (runner=${runner.mode})`)
  })

  const shutdown = async signal => {
    logInfo(`received ${signal}, shutting down`)
    server.close()
    try {
      await shutdownRunner()
    } catch (err) {
      logError(err)
    }
    process.exit(0)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

start().catch(err => {
  logError(err)
  process.exit(1)
})
