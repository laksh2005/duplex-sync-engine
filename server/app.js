const express = require('express')
const cors = require('cors')
const dotenv = require('dotenv')
const path = require('path')
const routes = require('./routes')

dotenv.config({
  path: path.join(__dirname, '.env')
})

const app = express()

app.use(cors())
app.use(express.json())

app.use('/api', routes)

module.exports = app

