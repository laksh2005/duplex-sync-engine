const { google } = require('googleapis')
const dotenv = require('dotenv')
const path = require('path')

dotenv.config({
  path: path.join(__dirname, '../.env')
})

async function getSheetsClient() {
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL
  let privateKey = process.env.GOOGLE_PRIVATE_KEY

  if (!clientEmail || !privateKey) {
    throw new Error('GOOGLE_CLIENT_EMAIL and GOOGLE_PRIVATE_KEY must be set')
  }

  privateKey = privateKey.replace(/\\n/g, '\n')
  
  if (privateKey.startsWith('"') && privateKey.endsWith('"')) {
    privateKey = privateKey.slice(1, -1)
  }

  if (!privateKey.includes('BEGIN PRIVATE KEY') || !privateKey.includes('END PRIVATE KEY')) {
    throw new Error(`GOOGLE_PRIVATE_KEY appears to be incomplete. Length: ${privateKey.length}, Starts with: ${privateKey.substring(0, 30)}, Ends with: ${privateKey.substring(privateKey.length - 30)}`)
  }

  const scopes = ['https://www.googleapis.com/auth/spreadsheets']

  const auth = new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: scopes
  })

  await auth.authorize()

  return google.sheets({ version: 'v4', auth })
}

module.exports = {
  getSheetsClient
}

