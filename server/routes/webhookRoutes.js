const express = require('express')
const { sheetWebhook, webhookHealth } = require('../controllers/webhookController')

const router = express.Router()

router.post('/sheet', sheetWebhook)
router.get('/health', webhookHealth)

module.exports = router
