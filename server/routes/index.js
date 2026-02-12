const express = require('express')
const dataRoutes = require('./dataRoutes')
const syncRoutes = require('./syncRoutes')

const router = express.Router()

router.use('/data', dataRoutes)
router.use('/sync', syncRoutes)

module.exports = router

