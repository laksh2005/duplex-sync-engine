const mysql = require('mysql2/promise')
require('./env')

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'duplex_sync',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
})

async function getConnection() {
  return pool.getConnection()
}

module.exports = {
  pool,
  getConnection
}

