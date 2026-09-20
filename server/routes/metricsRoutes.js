const express = require('express')
const { getMetrics, getActivity } = require('../controllers/metricsController')

const router = express.Router()

router.get('/', getMetrics)
router.get('/activity', getActivity)

module.exports = router
