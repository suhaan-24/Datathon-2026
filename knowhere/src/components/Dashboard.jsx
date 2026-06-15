import { useState, useEffect } from 'react'
import ChatPanel from './ChatPanel'
import NetworkPanel from './NetworkPanel'
import TimelinePanel from './TimelinePanel'
import HeatmapPanel from './HeatmapPanel'
import AuditPanel from './AuditPanel'
import AlertFeed, { AlertsPanel } from './AlertFeed'

const TYPING_TEXT = 'KARNATAKA STATE POLICE — CRIME INTELLIGENCE SYSTEM'

function TypingTitle() {
  const [len, setLen] = useState(0)
  useEffect(() => {
    if (len >= TYPING_TEXT.length) return
    const t = setTimeout(() => setLen(l => l + 1), 55)
    return () => clearTimeout(t)
  }, [len])
  return (
    <div className="dh-typing">
      {TYPING_TEXT.slice(0, len)}
      <span className="caret">▌</span>
    </div>
  )
}

function ISTClock() {
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])
  const time = now.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })
  const date = now.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' })
  return <span className="dh-clock">{date} · {time} IST</span>
}

const ICONS = {
  chat:     <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M21 11.5a8.38 8.38 0 01-9 8.36 8.5 8.5 0 01-3.4-.7L3 21l1.84-5.6A8.38 8.38 0 1121 11.5z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/></svg>,
  network:  <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="5" cy="6" r="2.4" stroke="currentColor" strokeWidth="1.6"/><circle cx="19" cy="6" r="2.4" stroke="currentColor" strokeWidth="1.6"/><circle cx="12" cy="18" r="2.4" stroke="currentColor" strokeWidth="1.6"/><path d="M7 7.5l8.5 9M17 7.5l-8.5 9M7.4 6h9.2" stroke="currentColor" strokeWidth="1.4"/></svg>,
  timeline: <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 3v18" stroke="currentColor" strokeWidth="1.6"/><circle cx="12" cy="6" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" stroke="currentColor" strokeWidth="1.6"/><circle cx="12" cy="18" r="2" fill="currentColor"/></svg>,
  alerts:   <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M13 2L4.5 13.5H11L10 22l8.5-11.5H12L13 2z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/></svg>,
  heatmap:  <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.6"/><rect x="13" y="3" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.6"/><rect x="3" y="13" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.6"/><rect x="13" y="13" width="8" height="8" rx="1.5" fill="currentColor" opacity="0.55"/></svg>,
  audit:    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/><path d="M14 2v6h6M9 13h6M9 17h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>,
  logout:   <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  chevR:    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  chevL:    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
}

export default function Dashboard({ auth, onLogout }) {
  const [view, setView] = useState('chat')
  const [railOpen, setRailOpen] = useState(true)
  const [districtFilter, setDistrictFilter] = useState(null)

  const canSeeHeatmap = auth.role === 'analyst' || auth.role === 'supervisor'
  const isSupervisor = auth.role === 'supervisor'

  const NAV = [
    { id: 'chat',     label: 'Chat Intelligence', icon: ICONS.chat },
    { id: 'network',  label: 'Network Analysis',  icon: ICONS.network },
    { id: 'timeline', label: 'Crime Timeline',    icon: ICONS.timeline },
    { id: 'alerts',   label: 'Anomaly Feed',      icon: ICONS.alerts },
    ...(canSeeHeatmap ? [{ id: 'heatmap', label: 'Threat Heatmap', icon: ICONS.heatmap }] : []),
    ...(isSupervisor  ? [{ id: 'audit',   label: 'Audit Log',      icon: ICONS.audit }] : []),
  ]

  const handleDistrictSelect = (district) => {
    setDistrictFilter(district)
    setView('chat')
  }

  return (
    <div className="dash">
      {/* ── Header ── */}
      <header className="dash-header">
        <div className="dh-brand">
          <div className="dh-shield" />
          <span className="dh-wordmark">KNOWHERE</span>
        </div>
        <TypingTitle />
        <div className="dh-right">
          <span className="dh-officer">{auth.name}</span>
          <span className={`role-badge ${auth.role}`}>{auth.role}</span>
          <ISTClock />
          <button className="dh-logout" onClick={onLogout} title="Sign out">{ICONS.logout}</button>
        </div>
      </header>

      <div className="dash-body">
        {/* ── Left sidebar ── */}
        <nav className="sidebar">
          {NAV.map(item => (
            <button
              key={item.id}
              className={`nav-item ${view === item.id ? 'active' : ''}`}
              onClick={() => setView(item.id)}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
          <div className="sidebar-spacer" />
          <div className="sidebar-profile">
            <span className="sp-name">{auth.name}</span>
            <div className="sp-row">
              <span className={`role-badge ${auth.role}`}>{auth.role}</span>
              <button className="sp-logout" onClick={onLogout}>Logout</button>
            </div>
          </div>
        </nav>

        {/* ── Center panel ── */}
        <main className="dash-center">
          {!railOpen && (
            <button className="rail-toggle" onClick={() => setRailOpen(true)} title="Show intelligence feed">
              {ICONS.chevL}
            </button>
          )}
          {view === 'chat' && (
            <ChatPanel
              auth={auth}
              districtFilter={districtFilter}
              onClearDistrict={() => setDistrictFilter(null)}
            />
          )}
          {view === 'network'  && <NetworkPanel auth={auth} />}
          {view === 'timeline' && <TimelinePanel auth={auth} />}
          {view === 'alerts'   && <AlertsPanel auth={auth} />}
          {view === 'heatmap'  && canSeeHeatmap && <HeatmapPanel auth={auth} onDistrictSelect={handleDistrictSelect} />}
          {view === 'audit'    && isSupervisor && <AuditPanel auth={auth} />}
        </main>

        {/* ── Right alert rail ── */}
        <aside className={`alert-rail ${railOpen ? '' : 'collapsed'}`}>
          <div className="alert-rail-head">
            <span className="alert-rail-title">⚡ LIVE INTELLIGENCE FEED</span>
            <button className="dh-logout" style={{ width: 24, height: 24 }} onClick={() => setRailOpen(false)} title="Collapse feed">
              {ICONS.chevR}
            </button>
          </div>
          <AlertFeed auth={auth} />
        </aside>
      </div>
    </div>
  )
}
