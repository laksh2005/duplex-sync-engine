import { useEffect, useMemo, useRef, useState } from 'react'
import { Activity, Database, Sheet, RefreshCw } from 'lucide-react'
import './App.css'

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000/api'

// Behind the nginx proxy the socket is same-origin, so derive it from the page
// rather than hardcoding a host. Falls back to the dev server port.
function resolveWsUrl() {
  if (import.meta.env.VITE_WS_URL) {
    return import.meta.env.VITE_WS_URL
  }
  if (API_BASE_URL.startsWith('/')) {
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${scheme}//${window.location.host}/ws`
  }
  return 'ws://localhost:4000/ws'
}

const WS_URL = resolveWsUrl()

function useWebSocket(onMessage) {
  useEffect(() => {
    let socket
    function connect() {
      socket = new WebSocket(WS_URL)
      socket.onmessage = event => {
        try {
          const data = JSON.parse(event.data)
          onMessage(data)
        } catch (e) {}
      }
      socket.onclose = () => {
        setTimeout(connect, 2000)
      }
    }
    connect()
    return () => {
      if (socket) {
        socket.close()
      }
    }
  }, [onMessage])
}

function App() {
  const [sheetData, setSheetData] = useState({ headers: [], rows: [] })
  const [dbData, setDbData] = useState([])
  const [lastSyncTime, setLastSyncTime] = useState(null)
  const [status, setStatus] = useState('idle')
  const [eventLog, setEventLog] = useState([])
  const [loading, setLoading] = useState(false)
  const isSyncingRef = useRef(false)
  const pendingEventsRef = useRef([])

  async function fetchData() {
    setLoading(true)
    try {
      const [sheetRes, dbRes, metaRes] = await Promise.all([
        fetch(`${API_BASE_URL}/data/sheet`),
        fetch(`${API_BASE_URL}/data/db`),
        fetch(`${API_BASE_URL}/sync/meta`)
      ])
      const sheetJson = await sheetRes.json()
      const dbJson = await dbRes.json()
      const metaJson = await metaRes.json()
      setSheetData({ headers: sheetJson.headers || [], rows: sheetJson.rows || [] })
      setDbData(dbJson.rows || [])
      setLastSyncTime(metaJson.lastSyncTime || null)
    } catch (e) {
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
  }, [])

  useWebSocket(message => {
    if (message.type === 'status') {
      if (message.payload.status) {
        setStatus(message.payload.status)
        if (message.payload.status === 'syncing') {
          isSyncingRef.current = true
          pendingEventsRef.current = []
        }
        if (message.payload.status === 'idle') {
          const pending = pendingEventsRef.current
          isSyncingRef.current = false
          pendingEventsRef.current = []
          const inserts = pending.filter(e => e.type === 'sync_event' && e.payload?.action === 'insert').length
          const updates = pending.filter(e => e.type === 'sync_event' && e.payload?.action === 'update').length
          const deletes = pending.filter(e => e.type === 'sync_event' && e.payload?.action === 'delete').length
          const conflicts = pending.filter(e => e.type === 'conflict_event').length
          const parts = []
          if (inserts) parts.push(`${inserts} insert${inserts > 1 ? 's' : ''}`)
          if (updates) parts.push(`${updates} update${updates > 1 ? 's' : ''}`)
          if (deletes) parts.push(`${deletes} delete${deletes > 1 ? 's' : ''}`)
          if (conflicts) parts.push(`${conflicts} conflict${conflicts > 1 ? 's' : ''}`)
          const summary = parts.length ? parts.join(', ') : 'no changes'
          const timestamp = new Date().toISOString()
          setEventLog(prev => {
            const last = prev[0]
            const sameAsLast = last?.type === 'sync_summary' && last?.summary === summary && last?.timestamp && (new Date(last.timestamp).getTime() - new Date(timestamp).getTime() < 2000)
            if (sameAsLast) return prev
            return [{ type: 'sync_summary', summary, timestamp }, ...prev].slice(0, 15)
          })
          fetchData()
        }
      }
      if (message.payload.lastSyncTime) {
        setLastSyncTime(message.payload.lastSyncTime)
      }
    }
    if (message.type === 'sync_event' || message.type === 'conflict_event') {
      if (isSyncingRef.current) {
        pendingEventsRef.current.push({
          type: message.type,
          payload: message.payload || {}
        })
      }
    }
  })

  const syncLabel = useMemo(() => {
    if (status === 'syncing') {
      return 'Syncing'
    }
    if (status === 'error') {
      return 'Error'
    }
    return 'Idle'
  }, [status])

  const eventSummary = useMemo(() => eventLog.slice(0, 10), [eventLog])

  async function handleForceSync() {
    try {
      await fetch(`${API_BASE_URL}/sync/force`, {
        method: 'POST'
      })
      // Refetch after sync so UI shows updated data (fallback if WS is slow)
      setTimeout(() => fetchData(), 2000)
    } catch (e) {}
  }

  return (
    <div className="min-h-screen bg-black text-white font-serif">
      <div className="max-w-7xl mx-auto px-6 py-6 flex flex-col gap-6 h-full">
        <header className="flex items-center justify-between border-b border-white/20 pb-4">
          <div className="flex items-center gap-3">
            <div>
              <h1 className="text-2xl tracking-wide">parity</h1>
              <p className="text-sm text-white/60">Google Sheets ↔ MySQL live sync</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Activity
                className={
                  status === 'syncing'
                    ? 'h-4 w-4 text-yellow-400'
                    : status === 'error'
                    ? 'h-4 w-4 text-red-500'
                    : 'h-4 w-4 text-white/60'
                }
              />
              <span className="text-sm uppercase tracking-wide text-white/70">{syncLabel}</span>
            </div>
            <div className="text-xs text-white/60 border border-white/20 rounded-full px-3 py-1">
              Last sync:{' '}
              {lastSyncTime ? new Date(lastSyncTime).toLocaleString() : 'Not yet'}
            </div>
            <button
              type="button"
              onClick={handleForceSync}
              className="inline-flex items-center gap-2 border border-white/30 px-3 py-1.5 text-sm rounded-full bg-black hover:bg-yellow-500 hover:text-black transition-colors"
            >
              <RefreshCw className="h-4 w-4" />
              Sync Now
            </button>
          </div>
        </header>
        <main className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-6 min-h-0">
          <section className="border border-white/20 rounded-xl p-4 flex flex-col min-h-0">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Sheet className="h-4 w-4 text-yellow-400" />
                <h2 className="text-lg">Google Sheet</h2>
              </div>
              <span className="text-xs text-white/50">
                {sheetData.rows.length} rows
              </span>
            </div>
            <div className="flex-1 overflow-auto rounded-lg border border-white/20">
              <DataTable headers={sheetData.headers} rows={sheetData.rows} />
            </div>
          </section>
          <section className="border border-white/20 rounded-xl p-4 flex flex-col min-h-0">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Database className="h-4 w-4 text-yellow-400" />
                <h2 className="text-lg">MySQL</h2>
              </div>
              <span className="text-xs text-white/50">{dbData.length} rows</span>
            </div>
            <div className="flex-1 overflow-auto rounded-lg border border-white/20 mb-4">
              <DbTable rows={dbData} sheetHeaders={sheetData.headers} />
            </div>
          </section>
          {/* <section className="border border-white/20 rounded-lg p-3">
              <h3 className="text-xs uppercase tracking-wide text-white/50 mb-2">
                Recent activity
              </h3>
              <div className="space-y-1 text-xs">
                {eventSummary.length === 0 && (
                  <div className="text-white/40">No activity yet</div>
                )}
                {eventSummary.map((item, index) => (
                  <div
                    key={`${item.timestamp}-${index}`}
                    className="flex items-center justify-between text-white/70"
                  >
                    <span>
                      {item.type === 'sync_summary'
                        ? `Sync: ${item.summary}`
                        : `${item.type === 'sync_event' ? 'Sync' : 'Conflict'} ${item.payload?.id ?? '-'} ${item.payload?.action ?? item.payload?.winner ?? ''}`}
                    </span>
                    <span className="text-white/40 tabular-nums">
                      {new Date(item.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                ))}
              </div>
            </section> */}

        </main>
        {loading && (
          <div className="fixed bottom-4 right-4 text-xs text-white/70 bg-black border border-white/20 px-3 py-1.5 rounded-full">
            Loading data
          </div>
        )}
      </div>
    </div>
  )
}

function DataTable({ headers, rows }) {
  if (!headers || !headers.length) {
    return (
      <div className="p-4 text-sm text-white/50 bg-black">
        No data available
      </div>
    )
  }
  return (
    <table className="min-w-full text-xs bg-black">
      <thead className="bg-white/5 sticky top-0 z-10">
        <tr>
          {headers.map(header => (
            <th
              key={header}
              className="px-3 py-2 text-left font-normal text-white/80 border-b border-white/20"
            >
              {header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(row => (
          <tr key={row.id}>
            {headers.map(header => {
              const key = header.toLowerCase().replace(/[^a-z0-9]+/g, '_')
              return (
                <td
                  key={header}
                  className="px-3 py-1.5 border-b border-white/10 text-white/80"
                >
                  {key === 'updated_at' && row.updated_at
                    ? new Date(row.updated_at).toLocaleString()
                    : String(row[key] ?? '')}
                </td>
              )
            })}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

const DB_HIDE_COLUMNS = ['checksum']

function sanitizeColumnKey(header) {
  const trimmed = String(header || '').trim().toLowerCase()
  let normalized = trimmed.replace(/[^a-z0-9]+/g, '_')
  if (/^[0-9]/.test(normalized)) normalized = `col_${normalized}`
  return normalized || 'col_unnamed'
}

function DbTable({ rows, sheetHeaders = [] }) {
  if (!rows || !rows.length) {
    return (
      <div className="p-4 text-sm text-white/50 bg-black">
        No data available
      </div>
    )
  }
  const keys = Object.keys(rows[0]).filter(k => !DB_HIDE_COLUMNS.includes(k))
  const keyToLabel = useMemo(() => {
    const map = {}
    const keySet = new Set(keys)
    keys.forEach(k => {
      map[k] = k
    })
    if (Array.isArray(sheetHeaders) && sheetHeaders.length) {
      sheetHeaders.forEach(h => {
        const key = sanitizeColumnKey(h)
        if (keySet.has(key)) map[key] = String(h).trim() || key
      })
    }
    return map
  }, [rows, sheetHeaders])
  return (
    <table className="min-w-full text-xs bg-black">
      <thead className="bg-white/5 sticky top-0 z-10">
        <tr>
          {keys.map(key => (
            <th
              key={key}
              className="px-3 py-2 text-left font-normal text-white/80 border-b border-white/20"
            >
              {keyToLabel[key] ?? key}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(row => (
          <tr key={row.id}>
            {keys.map(key => (
              <td
                key={key}
                className="px-3 py-1.5 border-b border-white/10 text-white/80"
              >
                {key === 'updated_at' && row[key]
                  ? new Date(row[key]).toLocaleString()
                  : String(row[key] ?? '')}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export default App
