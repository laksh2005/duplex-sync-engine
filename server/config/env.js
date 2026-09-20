const path = require('path')
const dotenv = require('dotenv')

// Single place the .env file is loaded. Every entry point requires this first,
// so modules that read process.env at require time (the webhook secret, the
// Redis URL) always see the real values.
dotenv.config({ path: path.join(__dirname, '../.env'), quiet: true })

module.exports = process.env
