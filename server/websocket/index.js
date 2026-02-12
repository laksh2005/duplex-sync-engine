const WebSocket = require('ws')

let wss
const clients = new Set()

function initWebSocket(server) {
  wss = new WebSocket.Server({ server, path: '/ws' })
  wss.on('connection', socket => {
    clients.add(socket)
    socket.on('close', () => {
      clients.delete(socket)
    })
  })
}

function broadcast(type, payload) {
  if (!wss) {
    return
  }
  const message = JSON.stringify({ type, payload })
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message)
    }
  })
}

function broadcastStatus(status) {
  broadcast('status', status)
}

function broadcastSyncEvent(event) {
  broadcast('sync_event', event)
}

function broadcastConflictEvent(event) {
  broadcast('conflict_event', event)
}

module.exports = {
  initWebSocket,
  broadcastStatus,
  broadcastSyncEvent,
  broadcastConflictEvent
}

