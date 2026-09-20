const IORedis = require('ioredis')
const { logError, logInfo } = require('../utils/logger')

function getRedisUrl() {
  return (process.env.REDIS_URL || '').trim()
}

// Redis is optional: without it the app falls back to the in-process runner so
// local dev and unit tests do not need a broker running.
function isRedisEnabled() {
  return getRedisUrl().length > 0
}

function createRedisConnection(label = 'redis') {
  // maxRetriesPerRequest must be null for BullMQ's blocking commands.
  const connection = new IORedis(getRedisUrl(), {
    maxRetriesPerRequest: null,
    enableReadyCheck: true
  })

  connection.on('error', err => logError(err))
  connection.on('ready', () => logInfo(`${label} connected`))

  return connection
}

module.exports = {
  getRedisUrl,
  isRedisEnabled,
  createRedisConnection
}
