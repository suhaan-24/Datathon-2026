import { useState, useEffect, useRef } from 'react'

const SEV_LABEL = { critical: '🔴 CRITICAL', warning: '🟡 WARNING', normal: '🟢 NORMAL' }

function timeAgo(mins) {
  if (mins < 60) return `${mins} mins ago`
  const h = Math.floor(mins / 60)
  return `${h} hr${h > 1 ? 's' : ''} ago`
}

function useAlerts(auth) {
  const [alerts, setAlerts] = useState([])
  useEffect(() => {
    let active = true
    fetch('/api/alerts', { headers: { 'x-auth-token': auth.token } })
      .then(r => r.json())
      .then(d => { if (active) setAlerts(d.alerts || []) })
      .catch(() => {})
    return () => { active = false }
  }, [auth.token])
  return alerts
}

function AlertCard({ alert }) {
  return (
    <div className={`alert-card ${alert.severity}`}>
      <span className="alert-sev">{SEV_LABEL[alert.severity]}</span>
      <div className="alert-district">{alert.district}</div>
      <div className="alert-msg">{alert.message}</div>
      <div className="alert-meta">
        <span>{alert.type} · {alert.change}</span>
        <span>{timeAgo(alert.minutesAgo)}</span>
      </div>
    </div>
  )
}

/* Right-rail feed: shows 5 alerts, cycles a new one to the top every 30s */
export default function AlertFeed({ auth }) {
  const alerts = useAlerts(auth)
  const [visible, setVisible] = useState([])
  const cursor = useRef(0)

  useEffect(() => {
    if (!alerts.length) return
    cursor.current = 5 % alerts.length
    setVisible(alerts.slice(0, 5))

    const t = setInterval(() => {
      setVisible(prev => {
        const next = alerts[cursor.current % alerts.length]
        cursor.current += 1
        // refresh "time ago" so the feed feels live
        const incoming = { ...next, minutesAgo: Math.floor(Math.random() * 9) + 1, _k: Date.now() }
        return [incoming, ...prev.slice(0, 4)]
      })
    }, 30000)
    return () => clearInterval(t)
  }, [alerts])

  return (
    <div className="alert-rail-body">
      {visible.map(a => <AlertCard key={a._k || a.id} alert={a} />)}
      {!visible.length && (
        <span className="section-sub" style={{ textAlign: 'center', marginTop: '1rem' }}>
          AWAITING FEED…
        </span>
      )}
    </div>
  )
}

/* Full-page anomaly feed view (sidebar nav → Anomaly Feed) */
export function AlertsPanel({ auth }) {
  const alerts = useAlerts(auth)
  return (
    <div className="panel-wrap">
      <div className="panel-head">
        <div>
          <div className="section-title">⚡ Anomaly Feed</div>
          <div className="section-sub">AI-DETECTED PATTERNS · ALL DISTRICTS · LIVE</div>
        </div>
        <span className="section-sub">{alerts.length} ACTIVE SIGNALS</span>
      </div>
      <div className="panel-scroll">
        <div className="alerts-grid">
          {alerts.map(a => <AlertCard key={a.id} alert={a} />)}
        </div>
      </div>
    </div>
  )
}
