const express = require('express')
const { getSheetData, getDbData } = require('../controllers/dataController')

const router = express.Router()

router.get('/sheet', getSheetData)
router.get('/db', getDbData)

module.exports = router

