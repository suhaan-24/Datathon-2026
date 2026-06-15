import { useState, useEffect, useRef } from 'react'
import { apiUrl } from '../api'

const ACCESS_CARDS = [
  { cls: 'inv', name: 'INVESTIGATOR ACCESS', clearance: 'Clearance Level 1', email: 'investigator@ksp.gov.in', password: 'inv123' },
  { cls: 'ana', name: 'ANALYST ACCESS',      clearance: 'Clearance Level 2', email: 'analyst@ksp.gov.in',      password: 'ana123' },
  { cls: 'sup', name: 'SUPERVISOR ACCESS',   clearance: 'Clearance Level 3', email: 'supervisor@ksp.gov.in',   password: 'sup123' },
]

export default function LoginPage({ onLogin }) {
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [error, setError]       = useState('')
  const [loading, setLoading]   = useState(false)
  const canvasRef               = useRef(null)

  // ── Animated particle network (criminal connections motif) ──
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    let raf

    const resize = () => {
      canvas.width = canvas.offsetWidth
      canvas.height = canvas.offsetHeight
    }
    resize()
    window.addEventListener('resize', resize)

    const N = 70
    const pts = Array.from({ length: N }, (_, i) => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      vx: (Math.random() - 0.5) * 0.45,
      vy: (Math.random() - 0.5) * 0.45,
      r: Math.random() * 1.6 + 1,
      hot: i % 9 === 0, // a few red "suspect" nodes
    }))

    const LINK_DIST = 130

    const tick = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      for (const p of pts) {
        p.x += p.vx
        p.y += p.vy
        if (p.x < 0 || p.x > canvas.width)  p.vx *= -1
        if (p.y < 0 || p.y > canvas.height) p.vy *= -1
      }

      for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j++) {
          const a = pts[i], b = pts[j]
          const dx = a.x - b.x, dy = a.y - b.y
          const d = Math.hypot(dx, dy)
          if (d < LINK_DIST) {
            const alpha = (1 - d / LINK_DIST) * 0.22
            ctx.strokeStyle = (a.hot || b.hot)
              ? `rgba(239, 68, 68, ${alpha})`
              : `rgba(0, 212, 255, ${alpha})`
            ctx.lineWidth = 0.7
            ctx.beginPath()
            ctx.moveTo(a.x, a.y)
            ctx.lineTo(b.x, b.y)
            ctx.stroke()
          }
        }
      }

      for (const p of pts) {
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.hot ? p.r + 0.8 : p.r, 0, Math.PI * 2)
        ctx.fillStyle = p.hot ? 'rgba(239, 68, 68, 0.85)' : 'rgba(0, 212, 255, 0.7)'
        ctx.shadowBlur = p.hot ? 10 : 6
        ctx.shadowColor = p.hot ? '#ef4444' : '#00d4ff'
        ctx.fill()
        ctx.shadowBlur = 0
      }

      raf = requestAnimationFrame(tick)
    }
    tick()

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [])

  const submit = async (e, creds) => {
    e?.preventDefault()
    const body = creds || { email, password }
    if (!body.email || !body.password) return
    setError('')
    setLoading(true)
    try {
      const res = await fetch(apiUrl('/api/auth/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Authentication failed'); return }
      onLogin(data)
    } catch {
      setError('Cannot reach KNOWHERE server. Verify backend is running on port 3000.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="lp-split">
      <div className="scanline-overlay" />

      {/* ── Left: particle network + brand ── */}
      <div className="lp-left">
        <canvas ref={canvasRef} className="lp-canvas" />
        <div className="lp-brand">
          <div className="lp-logo">KNOWHERE</div>
          <div className="lp-tagline">Intelligence. Precision. Justice.</div>
          <div className="lp-org">Karnataka State Police · Crime Intelligence Division</div>
        </div>
      </div>

      {/* ── Right: glass login card ── */}
      <div className="lp-right">
        <div className="lp-card glass">
          <div className="kw-shield">
            <span className="kw-shield-inner">KSP</span>
          </div>
          <div className="lp-card-title">SECURE ACCESS</div>
          <div className="lp-card-sub">Authorized Personnel Only</div>

          <form onSubmit={submit} style={{ width: '100%' }}>
            <div className="lp-label">Officer ID / Email</div>
            <input
              className="kw-input"
              type="email"
              placeholder="officer@ksp.gov.in"
              value={email}
              onChange={e => setEmail(e.target.value)}
              autoComplete="username"
              required
            />
            <div className="lp-label">Passcode</div>
            <input
              className="kw-input"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />

            {error && <div className="lp-error">{error}</div>}

            <button type="submit" className="kw-btn-primary" disabled={loading} style={{ marginTop: '1.1rem' }}>
              {loading ? 'AUTHENTICATING…' : 'INITIATE ACCESS'}
            </button>
          </form>

          <div className="lp-divider"><span>Classified Access Cards</span></div>

          {ACCESS_CARDS.map(c => (
            <button
              key={c.cls}
              className={`access-card ${c.cls}`}
              onClick={(e) => submit(e, { email: c.email, password: c.password })}
              disabled={loading}
            >
              <div>
                <div className="ac-name">{c.name}</div>
                <div className="ac-clearance">{c.clearance}</div>
              </div>
              <span className="ac-dot" />
            </button>
          ))}

          <div className="lp-footer">
            All access attempts are logged · IPC §66 compliance active
          </div>
        </div>
      </div>
    </div>
  )
}
