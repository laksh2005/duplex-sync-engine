const http = require('http')
const dotenv = require('dotenv')
const path = require('path')
const app = require('./app')
const { initSchema } = require('./services/dbService')
const { initWebSocket } = require('./websocket')
const { startSyncLoop } = require('./services/syncEngine')
const { logError } = require('./utils/logger')

dotenv.config({
  path: path.join(__dirname, '.env')
})

const port = Number(process.env.PORT || 4000)

async function start() {
  try {
    await initSchema()
    const server = http.createServer(app)
    initWebSocket(server)
    await startSyncLoop()
    server.listen(port)
  } catch (err) {
    logError(err)
    process.exit(1)
  }
}

start()

