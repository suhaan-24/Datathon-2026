import { useState, useEffect } from 'react'

const ACTION_COLOR = {
  LOGIN: '#00ff9d',
  QUERY: '#00d4ff',
  CASE_SUMMARY: '#f59e0b',
  NETWORK_VIEW: '#a78bfa',
  TIMELINE_VIEW: '#a78bfa',
  VOICE_TRANSCRIBE: '#f472b6',
}

export default function AuditPanel({ auth }) {
  const [logs, setLogs]   = useState([])
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    fetch('/api/audit', { headers: { 'x-auth-token': auth.token } })
      .then(r => r.json())
      .then(d => {
        if (!active) return
        if (d.error) setError(d.error)
        else setLogs((d.logs || []).slice().reverse())
      })
      .catch(() => { if (active) setError('Cannot reach audit service.') })
    return () => { active = false }
  }, [auth.token])

  return (
    <div className="panel-wrap">
      <div className="panel-head">
        <div>
          <div className="section-title">Audit Log</div>
          <div className="section-sub">SUPERVISOR CLEARANCE · FULL SYSTEM ACTIVITY TRAIL · {logs.length} ENTRIES</div>
        </div>
      </div>

      {error ? (
        <div className="lp-error">{error}</div>
      ) : (
        <div className="panel-scroll" style={{ border: '1px solid var(--border)', borderRadius: 10 }}>
          <table className="kw-table">
            <thead>
              <tr>
                <th>Timestamp (UTC)</th>
                <th>User</th>
                <th>Role</th>
                <th>Action</th>
                <th>Query</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log, i) => (
                <tr key={i}>
                  <td className="mono" style={{ color: 'var(--dim)', fontSize: '0.68rem' }}>
                    {log.timestamp.replace('T', ' ').slice(0, 19)}
                  </td>
                  <td>{log.user}</td>
                  <td><span className={`role-badge ${log.role}`} style={{ animation: 'none' }}>{log.role}</span></td>
                  <td className="mono" style={{ color: ACTION_COLOR[log.action] || 'var(--text)', fontSize: '0.68rem', letterSpacing: '0.08em' }}>
                    {log.action}
                  </td>
                  <td style={{ color: 'var(--dim)' }}>{log.query || '—'}</td>
                </tr>
              ))}
              {!logs.length && (
                <tr><td colSpan="5" style={{ textAlign: 'center', color: 'var(--dim)', padding: '1.5rem' }}>NO AUDIT ENTRIES YET THIS SESSION</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
