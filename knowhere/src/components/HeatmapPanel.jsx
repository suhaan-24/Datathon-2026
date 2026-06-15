import { useState, useEffect, useRef } from 'react'
import { withToken } from '../api'

/* Stylized tile cartogram of Karnataka — 31 districts placed
   approximately geographically (north at top, coast at left). */
const TILE_POS = {
  'Bidar':            [4,   0],
  'Vijayapura':       [2.5, 1], 'Kalaburagi':      [3.5, 1], 'Yadgir':         [4.5, 1],
  'Belagavi':         [1.5, 2], 'Bagalkote':       [2.5, 2], 'Koppal':         [3.5, 2], 'Raichur':       [4.5, 2],
  'Dharwad':          [1.5, 3], 'Gadag':           [2.5, 3], 'Vijayanagara':   [3.5, 3], 'Ballari':       [4.5, 3],
  'Uttara Kannada':   [0.5, 4], 'Haveri':          [1.5, 4], 'Davanagere':     [2.5, 4], 'Chitradurga':   [3.5, 4],
  'Udupi':            [0.5, 5], 'Shivamogga':      [1.5, 5], 'Chikkamagaluru': [2.5, 5], 'Tumakuru':      [3.5, 5], 'Chikkaballapura': [4.5, 5],
  'Dakshina Kannada': [0.5, 6], 'Hassan':          [1.5, 6], 'Bengaluru Rural': [4, 6],  'Kolar':         [5,   6],
  'Kodagu':           [1,   7], 'Mandya':          [2.5, 7], 'Ramanagara':     [3.5, 7], 'Bengaluru Urban': [4.5, 7],
  'Mysuru':           [2,   8], 'Chamarajanagara': [3,   8],
}

const TILE_W = 98, TILE_H = 52, GAP_X = 105, GAP_Y = 60

const TREND_ARROW = { up: '↑', down: '↓', flat: '→' }
const TREND_COLOR = { up: '#ef4444', down: '#00ff9d', flat: '#64748b' }
const LEVEL_LABEL = {
  critical: 'CRITICAL', elevated: 'ELEVATED', normal: 'NORMAL', nodata: 'NO DATA',
}

export default function HeatmapPanel({ auth, onDistrictSelect }) {
  const [districts, setDistricts] = useState([])
  const [tip, setTip] = useState(null)
  const stageRef = useRef(null)

  useEffect(() => {
    let active = true
    fetch(withToken('/api/heatmap', auth.token))
      .then(r => r.json())
      .then(d => { if (active) setDistricts(d.districts || []) })
      .catch(() => {})
    return () => { active = false }
  }, [auth.token])

  const handleMove = (e, d) => {
    const rect = stageRef.current.getBoundingClientRect()
    setTip({
      d,
      x: Math.min(e.clientX - rect.left + 16, rect.width - 210),
      y: Math.min(e.clientY - rect.top + 12, rect.height - 110),
    })
  }

  const counts = districts.reduce((acc, d) => {
    acc[d.level] = (acc[d.level] || 0) + 1
    return acc
  }, {})

  const hotlist = [...districts]
    .filter(d => d.level === 'critical' || d.level === 'elevated')
    .sort((a, b) => b.activeFirs - a.activeFirs)

  return (
    <div className="panel-wrap">
      <div className="panel-head">
        <div>
          <div className="section-title">District Threat Heatmap</div>
          <div className="section-sub">
            KARNATAKA · 31 DISTRICTS · {counts.critical || 0} CRITICAL / {counts.elevated || 0} ELEVATED · CLICK A DISTRICT TO FILTER CHAT
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.9rem', fontFamily: 'var(--font-mono)', fontSize: '0.62rem', letterSpacing: '0.08em', color: 'var(--dim)' }}>
          <span><span style={{ color: '#ef4444' }}>■</span> CRITICAL</span>
          <span><span style={{ color: '#f59e0b' }}>■</span> ELEVATED</span>
          <span><span style={{ color: '#10b981' }}>■</span> NORMAL</span>
          <span><span style={{ color: '#334155' }}>■</span> NO DATA</span>
        </div>
      </div>

      <div className="hm-stage" ref={stageRef}>
        <svg viewBox="0 0 645 560" preserveAspectRatio="xMidYMid meet">
          {districts.map(d => {
            const pos = TILE_POS[d.district]
            if (!pos) return null
            const x = pos[0] * GAP_X + 8
            const y = pos[1] * GAP_Y + 8
            return (
              <g
                key={d.district}
                onMouseMove={e => handleMove(e, d)}
                onMouseLeave={() => setTip(null)}
                onClick={() => onDistrictSelect(d.district)}
              >
                <rect className={`hm-tile ${d.level}`} x={x} y={y} width={TILE_W} height={TILE_H} rx="6" strokeWidth="1.2" />
                <text className="hm-label" x={x + TILE_W / 2} y={y + 19} textAnchor="middle">
                  {d.district}
                </text>
                <text className="hm-count" x={x + TILE_W / 2} y={y + 40} textAnchor="middle">
                  {d.level === 'nodata' ? '—' : d.activeFirs}
                  <tspan fill={TREND_COLOR[d.trend]} fontSize="11"> {TREND_ARROW[d.trend]}</tspan>
                </text>
              </g>
            )
          })}
        </svg>

        {tip && (
          <div className="hm-tooltip glass" style={{ left: tip.x, top: tip.y }}>
            <h5>{tip.d.district}</h5>
            <div className="row"><span>Threat level</span><b style={{ color: tip.d.level === 'critical' ? '#ef4444' : tip.d.level === 'elevated' ? '#f59e0b' : '#10b981' }}>{LEVEL_LABEL[tip.d.level]}</b></div>
            <div className="row"><span>Active FIRs</span><b>{tip.d.activeFirs}</b></div>
            <div className="row"><span>Top crime</span><b>{tip.d.topCrime}</b></div>
            <div className="row"><span>Trend</span><b style={{ color: TREND_COLOR[tip.d.trend] }}>{TREND_ARROW[tip.d.trend]} {tip.d.trend.toUpperCase()}</b></div>
          </div>
        )}

        <div className="hm-side">
          <span className="section-sub" style={{ marginBottom: '0.3rem' }}>⚠ PRIORITY DISTRICTS</span>
          {hotlist.map(d => (
            <button key={d.district} className={`alert-card ${d.level === 'critical' ? 'critical' : 'warning'}`} style={{ textAlign: 'left', width: '100%' }} onClick={() => onDistrictSelect(d.district)}>
              <div className="alert-district">{d.district}</div>
              <div className="alert-meta">
                <span>{d.activeFirs} FIRs · {d.topCrime}</span>
                <span style={{ color: TREND_COLOR[d.trend] }}>{TREND_ARROW[d.trend]}</span>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
