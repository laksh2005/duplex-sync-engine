const express = require('express')
const { forceSyncHandler, getMeta } = require('../controllers/syncController')

const router = express.Router()

router.post('/force', forceSyncHandler)
router.get('/meta', getMeta)

module.exports = router

