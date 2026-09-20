const express = require('express')
const dataRoutes = require('./dataRoutes')
const syncRoutes = require('./syncRoutes')
const webhookRoutes = require('./webhookRoutes')
const metricsRoutes = require('./metricsRoutes')

const router = express.Router()

router.get('/health', (req, res) => {
  res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) })
})

router.use('/data', dataRoutes)
router.use('/sync', syncRoutes)
router.use('/webhook', webhookRoutes)
router.use('/metrics', metricsRoutes)

module.exports = router
