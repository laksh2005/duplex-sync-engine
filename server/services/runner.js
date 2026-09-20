// Indirection point for "how does a sync actually get run". Callers only ever
// enqueue; whether that lands on a BullMQ queue or an in-process coalescing
// runner is decided here from config.
const inProcess = require('./inProcessRunner')

module.exports = {
  enqueueSync: inProcess.enqueueSync,
  initRunner: inProcess.initRunner,
  shutdownRunner: inProcess.shutdownRunner,
  getRunnerStatus: inProcess.getRunnerStatus
}
