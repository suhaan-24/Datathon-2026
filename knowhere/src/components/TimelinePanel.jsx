import { useState, useEffect, useMemo } from 'react'
import { apiUrl } from '../api'

const EVENT_META = {
  fir:      { icon: '📋', label: 'FIR Filed' },
  arrest:   { icon: '🔒', label: 'Arrest' },
  court:    { icon: '⚖️', label: 'Court' },
  witness:  { icon: '👁', label: 'Witness' },
  evidence: { icon: '🔬', label: 'Evidence' },
}

export default function TimelinePanel({ auth }) {
  const [data, setData]   = useState(null)
  const [type, setType]   = useState('all')
  const [district, setDistrict] = useState('all')
  const [from, setFrom]   = useState('')
  const [to, setTo]       = useState('')

  useEffect(() => {
    let active = true
    fetch(apiUrl('/api/timeline?case=KSP-2026-OPS-0047'), { headers: { 'x-auth-token': auth.token } })
      .then(r => r.json())
      .then(d => { if (active) setData(d) })
      .catch(() => {})
    return () => { active = false }
  }, [auth.token])

  const districts = useMemo(
    () => [...new Set((data?.events || []).map(e => e.district))],
    [data]
  )

  const events = useMemo(() => {
    let evts = data?.events || []
    if (type !== 'all')     evts = evts.filter(e => e.type === type)
    if (district !== 'all') evts = evts.filter(e => e.district === district)
    if (from)               evts = evts.filter(e => e.date.slice(0, 10) >= from)
    if (to)                 evts = evts.filter(e => e.date.slice(0, 10) <= to)
    return evts
  }, [data, type, district, from, to])

  const fmtDate = iso => new Date(iso).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  })

  return (
    <div className="panel-wrap">
      <div className="panel-head">
        <div>
          <div className="section-title">Crime Timeline</div>
          <div className="section-sub">
            {data ? `${data.codename} · CASE ${data.caseId}` : 'LOADING…'} · {events.length} EVENTS
          </div>
        </div>
        <div className="tl-filters">
          <select value={type} onChange={e => setType(e.target.value)}>
            <option value="all">All event types</option>
            {Object.entries(EVENT_META).map(([k, v]) => (
              <option key={k} value={k}>{v.label}</option>
            ))}
          </select>
          <select value={district} onChange={e => setDistrict(e.target.value)}>
            <option value="all">All districts</option>
            {districts.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} title="From date" />
          <input type="date" value={to} onChange={e => setTo(e.target.value)} title="To date" />
        </div>
      </div>

      <div className="panel-scroll">
        <div className="tl-body">
          {events.map(ev => (
            <div key={ev.id} className={`tl-event ${ev.type}`}>
              <div className="tl-node">{EVENT_META[ev.type]?.icon}</div>
              <div className="tl-card kw-card">
                <div className="tl-top">
                  <span className="tl-type">{EVENT_META[ev.type]?.label || ev.type}</span>
                  <span className="tl-date">{fmtDate(ev.date)} IST</span>
                  <span className="tl-loc">{ev.district} · {ev.ps}</span>
                </div>
                <div className="tl-desc">{ev.description}</div>
                <div className="tl-meta">
                  <button className="tl-fir" title="FIR reference">FIR {ev.fir}</button>
                  <span className="tl-officer">ASSIGNED: {ev.officer.toUpperCase()}</span>
                </div>
              </div>
            </div>
          ))}
          {!events.length && data && (
            <div className="section-sub" style={{ padding: '1rem 0' }}>
              NO EVENTS MATCH CURRENT FILTERS
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
