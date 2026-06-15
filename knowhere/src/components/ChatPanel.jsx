import { useState, useRef, useEffect } from 'react'
import { apiUrl, withToken } from '../api'

const SUGGESTED = [
  'Show recent FIRs in Bengaluru North',
  'List accused with pending warrants',
  'Crime hotspots in the last 30 days',
  'Vehicle thefts linked to repeat offenders',
]

const SUPPORTED_LANGS = {
  'en-IN': 'English',
  'kn-IN': 'ಕನ್ನಡ',
  'hi-IN': 'हिन्दी',
  'ta-IN': 'தமிழ்',
  'te-IN': 'తెలుగు',
  'ml-IN': 'മലയാളം',
}

/* Unicode script ranges → language code; Latin text falls through to en-IN */
const SCRIPT_RANGES = [
  ['kn-IN', /[ಀ-೿]/],
  ['te-IN', /[ఀ-౿]/],
  ['ta-IN', /[஀-௿]/],
  ['ml-IN', /[ഀ-ൿ]/],
  ['hi-IN', /[ऀ-ॿ]/],
]

function detectScript(text) {
  for (const [code, re] of SCRIPT_RANGES) {
    if (re.test(text)) return code
  }
  return 'en-IN'
}

const fmtSecs = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

/* BCP-47 lang code → Web Speech API lang tag */
const TTS_LANG = {
  'en-IN': 'en-IN',
  'kn-IN': 'kn-IN',
  'hi-IN': 'hi-IN',
  'ta-IN': 'ta-IN',
  'te-IN': 'te-IN',
  'ml-IN': 'ml-IN',
}

export default function ChatPanel({ auth, districtFilter, onClearDistrict }) {
  const [messages, setMessages] = useState([])
  const [input, setInput]       = useState('')
  const [loading, setLoading]   = useState(false)
  const [recording, setRecording] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [recordSecs, setRecordSecs] = useState(0)
  const [toast, setToast]       = useState('')
  const [briefBusy, setBriefBusy] = useState(false)
  const [detected, setDetected] = useState(null)
  const [speakingId, setSpeakingId] = useState(null) // which bot message is being read aloud

  const bottomRef = useRef(null)
  const inputRef  = useRef(null)
  const mediaRef = useRef(null)
  const voiceLangRef = useRef(null)   // set after voice transcription only; cleared on manual edit
  const detectedTimerRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  // Stop TTS when component unmounts
  useEffect(() => () => { window.speechSynthesis?.cancel() }, [])

  const showToast = (msg, ms = 2200) => {
    setToast(msg)
    if (ms) setTimeout(() => setToast(''), ms)
  }

  /* ── TTS: read bot reply aloud ── */
  const speakTTS = (msg) => {
    if (!window.speechSynthesis) return
    if (speakingId === msg.id) {
      window.speechSynthesis.cancel()
      setSpeakingId(null)
      return
    }
    window.speechSynthesis.cancel()
    const utter = new SpeechSynthesisUtterance(msg.text)
    const lang = TTS_LANG[detectScript(msg.text)] || 'en-IN'
    utter.lang = lang
    utter.rate = 0.95
    utter.onend = () => setSpeakingId(null)
    utter.onerror = () => setSpeakingId(null)
    setSpeakingId(msg.id)
    window.speechSynthesis.speak(utter)
  }

  /* ── Voice input via MediaRecorder + Groq Whisper ── */
  const MAX_RECORD_MS = 30000

  const applyTranscript = (transcript, code) => {
    setInput(prev => (prev ? prev + ' ' : '') + transcript)
    voiceLangRef.current = code  // only voice sets this
    setDetected({ code, label: SUPPORTED_LANGS[code] || code })
    clearTimeout(detectedTimerRef.current)
    detectedTimerRef.current = setTimeout(() => setDetected(null), 3000)
    inputRef.current?.focus()
  }

  const transcribe = async (blob) => {
    setProcessing(true)
    setToast('PROCESSING…')
    try {
      const fd = new FormData()
      fd.append('audio', blob, 'recording.webm')
      const res = await fetch(withToken('/api/transcribe', auth.token), {
        method: 'POST',
        body: fd,
      })
      const data = await res.json()
      if (!res.ok) {
        showToast((data.error || 'TRANSCRIPTION FAILED').toUpperCase())
        return
      }
      const transcript = (data.transcript || '').trim()
      if (!transcript) {
        showToast('NO SPEECH DETECTED. PLEASE TRY AGAIN.')
        return
      }
      applyTranscript(transcript, data.detectedLanguage || detectScript(transcript))
    } catch {
      showToast('TRANSCRIPTION FAILED — CHECK BACKEND CONNECTION')
    } finally {
      setProcessing(false)
      setToast(t => (t === 'PROCESSING…' ? '' : t))
    }
  }

  const toggleMic = async () => {
    if (processing) return

    if (mediaRef.current) {
      try { mediaRef.current.recorder.stop() } catch { /* already stopped */ }
      return
    }

    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      showToast('AUDIO RECORDING NOT SUPPORTED IN THIS BROWSER')
      return
    }

    let stream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      showToast('MICROPHONE ACCESS REQUIRED FOR VOICE INPUT')
      return
    }

    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : ''
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
    const session = { recorder, stream, chunks: [], cancelled: false }
    mediaRef.current = session

    recorder.ondataavailable = (e) => { if (e.data.size) session.chunks.push(e.data) }
    recorder.onstop = () => {
      session.stream.getTracks().forEach(t => t.stop())
      clearInterval(session.timer)
      clearTimeout(session.maxTimer)
      mediaRef.current = null
      setRecording(false)
      setRecordSecs(0)
      setToast('')
      if (session.cancelled) return
      const blob = new Blob(session.chunks, { type: mime || 'audio/webm' })
      if (blob.size < 1000) {
        showToast('NO SPEECH DETECTED. PLEASE TRY AGAIN.')
        return
      }
      transcribe(blob)
    }

    setRecording(true)
    setRecordSecs(0)
    setToast('RECORDING — TAP MIC TO STOP')
    session.timer = setInterval(() => setRecordSecs(s => s + 1), 1000)
    session.maxTimer = setTimeout(() => {
      try { recorder.stop() } catch { /* noop */ }
    }, MAX_RECORD_MS)
    recorder.start()
  }

  useEffect(() => () => {
    const s = mediaRef.current
    if (s) {
      s.cancelled = true
      clearInterval(s.timer)
      clearTimeout(s.maxTimer)
      try { s.recorder.stop() } catch { /* noop */ }
      s.stream.getTracks().forEach(t => t.stop())
    }
    clearTimeout(detectedTimerRef.current)
  }, [])

  const sendMessage = async (forced) => {
    const q = (forced || input).trim()
    if (!q || loading) return
    setInput('')
    setLoading(true)

    setMessages(prev => [...prev, { id: Date.now(), role: 'user', text: q, ts: new Date() }])

    const fullQuery = districtFilter ? `[District: ${districtFilter}] ${q}` : q

    // Only pass detectedLanguage from voice transcription.
    // For typed text, the backend infers language from the query text itself.
    const detectedLanguage = voiceLangRef.current || null
    voiceLangRef.current = null

    try {
      const res = await fetch(apiUrl('/api/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ query: fullQuery, detectedLanguage, token: auth.token }),
      })
      const data = await res.json()
      setMessages(prev => [...prev, {
        id: Date.now() + 1,
        role: 'bot',
        text: data.answer || data.error || 'No response received.',
        ts: new Date(),
        demo: !!data.demo,
      }])
    } catch (err) {
      console.error('Chat request failed:', err)
      setMessages(prev => [...prev, {
        id: Date.now() + 1,
        role: 'bot',
        text: 'CONNECTION ERROR — verify KNOWHERE backend is running on port 3000.',
        ts: new Date(),
        isError: true,
      }])
    } finally {
      setLoading(false)
      inputRef.current?.focus()
    }
  }

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const handleInputChange = (e) => {
    setInput(e.target.value)
    // If user manually edits after a voice input, discard the voice-detected language
    // so the next send uses the typed text's script for detection
    voiceLangRef.current = null
  }

  /* ── Case brief ── */
  const generateBrief = async () => {
    if (briefBusy) return
    setBriefBusy(true)
    showToast('GENERATING CASE BRIEF…', 0)
    try {
      const res = await fetch(apiUrl('/api/case-summary'), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({
          conversationHistory: messages.map(m => ({ role: m.role, text: m.text })),
          language: detectScript(
            [...messages].reverse().find(m => m.role === 'user')?.text || ''
          ).split('-')[0],
          token: auth.token,
        }),
      })
      const data = await res.json()
      openBriefWindow(data, auth)
    } catch {
      showToast('CASE BRIEF GENERATION FAILED')
    } finally {
      setBriefBusy(false)
      setToast('')
    }
  }

  const showBriefBtn = messages.filter(m => m.role === 'user').length >= 3

  return (
    <div className="chat-wrap">
      {messages.length === 0 ? (
        <div className="chat-empty">
          <div className="radar">
            <div className="radar-sweep" />
            <div className="radar-ping" />
          </div>
          <div className="chat-empty-title">SYSTEM READY — AWAITING QUERY</div>
          <div className="section-sub">CLEARANCE: {auth.role.toUpperCase()} · {auth.permissions?.length || 0} QUERY SCOPES AUTHORIZED</div>
          <div className="chip-row">
            {SUGGESTED.map(q => (
              <button key={q} className="chip" onClick={() => sendMessage(q)}>{q}</button>
            ))}
          </div>
        </div>
      ) : (
        <div className="chat-scroll">
          {messages.map(m => (
            <div key={m.id} className={`msg-row ${m.role}`}>
              {m.role === 'bot' ? (
                <div className={`bubble-bot ${m.demo ? 'demo' : ''} ${m.isError ? 'error' : ''}`}>
                  <div className="bot-head">
                    <span>KNOWHERE AI • CLEARANCE VERIFIED{m.demo && <span className="demo-flag"> • DEMO MODE</span>}</span>
                    <button
                      className={`tts-btn ${speakingId === m.id ? 'speaking' : ''}`}
                      onClick={() => speakTTS(m)}
                      title={speakingId === m.id ? 'Stop reading' : 'Read aloud'}
                    >
                      {speakingId === m.id ? (
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                          <rect x="6" y="4" width="4" height="16" rx="1"/>
                          <rect x="14" y="4" width="4" height="16" rx="1"/>
                        </svg>
                      ) : (
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                          <polygon points="11,5 6,9 2,9 2,15 6,15 11,19" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/>
                          <path d="M15.54 8.46a5 5 0 010 7.07M19.07 4.93a10 10 0 010 14.14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                        </svg>
                      )}
                    </button>
                  </div>
                  {m.text}
                </div>
              ) : (
                <div className="bubble-user">{m.text}</div>
              )}
              <span className="msg-time">
                {m.ts.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })} IST
              </span>
            </div>
          ))}
          {loading && (
            <div className="msg-row bot">
              <div className="bubble-bot">
                <div className="bot-head"><span>KNOWHERE AI • PROCESSING</span></div>
                <div className="think"><i /><i /><i /></div>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      )}

      <div className="chat-bottom">
        <div className="chat-toolbar">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            {districtFilter && (
              <span className="district-chip">
                FILTER: {districtFilter.toUpperCase()}
                <button onClick={onClearDistrict} title="Clear district filter">✕</button>
              </span>
            )}
          </div>
          {showBriefBtn && (
            <button className="kw-btn-ghost" onClick={generateBrief} disabled={briefBusy}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/>
                <path d="M14 2v6h6M9 13h6M9 17h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
              </svg>
              {briefBusy ? 'GENERATING…' : 'GENERATE CASE BRIEF'}
            </button>
          )}
        </div>

        <div className="chat-input-bar glass">
          <button
            className={`mic-btn ${recording ? 'recording' : ''}`}
            onClick={toggleMic}
            title={recording ? 'Stop recording' : processing ? 'Transcribing…' : 'Voice input — language auto-detected'}
          >
            {processing ? (
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" style={{ animation: 'kw-spin 0.9s linear infinite' }}>
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.2" strokeDasharray="42" strokeDashoffset="14" strokeLinecap="round"/>
              </svg>
            ) : (
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
                <rect x="9" y="2" width="6" height="12" rx="3" stroke="currentColor" strokeWidth="1.8"/>
                <path d="M5 10v1a7 7 0 0014 0v-1M12 18v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
              </svg>
            )}
          </button>
          <textarea
            ref={inputRef}
            rows={1}
            placeholder="Speak or type in any Indian language..."
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKey}
          />
          <button className="send-btn" onClick={() => sendMessage()} disabled={!input.trim() || loading} title="Send query">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </div>
        <div className="chat-hint-row">
          <span className="chat-hint">
            ENTER TO TRANSMIT · SHIFT+ENTER FOR NEW LINE · ALL QUERIES AUDITED
          </span>
          {detected && (
            <span className="lang-detect-pill">🎙️ Detected: {detected.label}</span>
          )}
        </div>
      </div>

      {toast && (
        <div className="kw-toast glass">
          {(recording || briefBusy) && <span className="rec-dot" />}
          {toast}
          {recording && (
            <span className="mono" style={{ color: 'var(--danger)' }}>
              {fmtSecs(recordSecs)} / 0:30
            </span>
          )}
        </div>
      )}
    </div>
  )
}

/* ── Print-ready case brief window with KSP letterhead ── */

function escapeHtml(str = '') {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function openBriefWindow(data, auth) {
  const s = data.sections
  const generated = new Date(data.generatedAt || Date.now())

  const body = data.raw
    ? `<div class="sec"><h2>CASE BRIEF</h2><div class="prose">${escapeHtml(data.raw)}</div></div>`
    : `
      <div class="sec"><h2>CASE OVERVIEW</h2><div class="prose">${escapeHtml(s.overview)}</div></div>
      <div class="sec"><h2>PERSONS OF INTEREST</h2>
        <table><thead><tr><th>Name</th><th>Role</th><th>Status</th></tr></thead><tbody>
        ${s.personsOfInterest.map(p => `<tr><td>${escapeHtml(p.name)}</td><td>${escapeHtml(p.role)}</td><td>${escapeHtml(p.status)}</td></tr>`).join('')}
        </tbody></table>
      </div>
      <div class="sec"><h2>TIMELINE OF EVENTS</h2>
        <table><thead><tr><th>Date</th><th>Event</th></tr></thead><tbody>
        ${s.timeline.map(t => `<tr><td class="nowrap">${escapeHtml(t.date)}</td><td>${escapeHtml(t.event)}</td></tr>`).join('')}
        </tbody></table>
      </div>
      <div class="sec"><h2>RECOMMENDED LEADS</h2>
        <ol>${s.leads.map(l => `<li>${escapeHtml(l)}</li>`).join('')}</ol>
      </div>
      <div class="sec"><h2>RELATED FIR NUMBERS</h2>
        <p class="firs">${s.firNumbers.map(f => `<span>${escapeHtml(f)}</span>`).join('')}</p>
      </div>
      <div class="sec"><h2>RISK ASSESSMENT</h2><div class="risk">${escapeHtml(s.riskAssessment)}</div></div>
    `

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<title>KNOWHERE Case Brief — ${escapeHtml(data.caseId || '')}</title>
<style>
  @page { margin: 22mm 18mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Georgia, 'Times New Roman', serif; color: #1a1a2e; padding: 36px 44px; position: relative; }
  .watermark {
    position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
    pointer-events: none; z-index: 0;
  }
  .watermark span {
    transform: rotate(-32deg); font-family: Arial, sans-serif; font-size: 42px; font-weight: 800;
    color: rgba(220, 38, 38, 0.13); letter-spacing: 4px; text-align: center; line-height: 1.6;
    border: 4px solid rgba(220, 38, 38, 0.13); padding: 14px 30px; border-radius: 8px;
  }
  .content { position: relative; z-index: 1; }
  .letterhead { display: flex; align-items: center; justify-content: space-between; border-bottom: 3px double #1e3a8a; padding-bottom: 14px; }
  .lh-left { display: flex; align-items: center; gap: 14px; }
  .shield { width: 46px; height: 54px; background: linear-gradient(160deg, #0ea5e9, #1e3a8a);
    clip-path: polygon(50% 0%, 100% 16%, 100% 56%, 50% 100%, 0% 56%, 0% 16%);
    display: flex; align-items: center; justify-content: center; color: #fff;
    font-family: Arial, sans-serif; font-weight: 800; font-size: 11px; }
  .lh-org { font-family: Arial, sans-serif; }
  .lh-org b { font-size: 15px; letter-spacing: 1px; color: #1e3a8a; display: block; }
  .lh-org span { font-size: 10px; color: #555; letter-spacing: 2px; text-transform: uppercase; }
  .lh-right { text-align: right; font-family: Arial, sans-serif; }
  .lh-right .wordmark { font-size: 17px; font-weight: 800; letter-spacing: 5px; color: #0e7490; }
  .lh-right .cls-stamp { display: inline-block; margin-top: 6px; border: 2px solid #b91c1c; color: #b91c1c;
    font-size: 10px; font-weight: 800; letter-spacing: 3px; padding: 3px 10px; transform: rotate(-3deg); }
  .meta { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 6px;
    font-family: Arial, sans-serif; font-size: 10.5px; color: #444; padding: 10px 0 4px; border-bottom: 1px solid #ccc; }
  .meta b { color: #111; }
  h1 { font-family: Arial, sans-serif; font-size: 19px; letter-spacing: 2px; color: #1e3a8a; margin: 22px 0 2px; }
  .codename { font-family: Arial, sans-serif; font-size: 11px; letter-spacing: 3px; color: #b91c1c; font-weight: 700; margin-bottom: 14px; }
  .sec { margin-top: 20px; page-break-inside: avoid; }
  .sec h2 { font-family: Arial, sans-serif; font-size: 12px; letter-spacing: 2.5px; color: #0e7490;
    border-bottom: 1px solid #0e7490; padding-bottom: 3px; margin-bottom: 8px; }
  .prose { font-size: 13px; line-height: 1.75; text-align: justify; white-space: pre-wrap; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { font-family: Arial, sans-serif; font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase;
    text-align: left; background: #eef2f7; color: #1e3a8a; padding: 6px 10px; border: 1px solid #c7d2e0; }
  td { padding: 6px 10px; border: 1px solid #c7d2e0; line-height: 1.5; }
  .nowrap { white-space: nowrap; }
  ol { padding-left: 22px; font-size: 13px; line-height: 1.8; }
  .firs span { display: inline-block; font-family: 'Courier New', monospace; font-size: 12px; font-weight: 700;
    border: 1px solid #1e3a8a; color: #1e3a8a; border-radius: 4px; padding: 2px 10px; margin: 0 8px 6px 0; }
  .risk { border-left: 4px solid #b91c1c; background: #fef2f2; padding: 10px 14px; font-size: 13px; line-height: 1.7; }
  footer { margin-top: 34px; border-top: 1px solid #ccc; padding-top: 8px; display: flex; justify-content: space-between;
    font-family: Arial, sans-serif; font-size: 9px; color: #888; letter-spacing: 1px; }
</style>
</head>
<body>
  <div class="watermark"><span>DEMO DATA<br/>NOT FOR OFFICIAL USE</span></div>
  <div class="content">
    <div class="letterhead">
      <div class="lh-left">
        <div class="shield">KSP</div>
        <div class="lh-org">
          <b>KARNATAKA STATE POLICE</b>
          <span>Crime Intelligence Division</span>
        </div>
      </div>
      <div class="lh-right">
        <div class="wordmark">KNOWHERE</div>
        <div class="cls-stamp">CONFIDENTIAL</div>
      </div>
    </div>
    <div class="meta">
      <span>OFFICER: <b>${escapeHtml(auth.name)}</b> (${escapeHtml(auth.role.toUpperCase())})</span>
      <span>CASE ID: <b>${escapeHtml(data.caseId || '—')}</b></span>
      <span>GENERATED: <b>${generated.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</b></span>
    </div>
    <h1>AUTO-GENERATED CASE BRIEF</h1>
    <div class="codename">${escapeHtml(data.codename || '')}</div>
    ${body}
    <footer>
      <span>KNOWHERE — AI-ASSISTED CRIME INTELLIGENCE · KSP DATATHON 2026</span>
      <span>PAGE GENERATED BY KNOWHERE v1.0</span>
    </footer>
  </div>
  <script>setTimeout(function () { window.print(); }, 1000);</scr${''}ipt>
</body>
</html>`

  const w = window.open('', '_blank')
  if (!w) return
  w.document.write(html)
  w.document.close()
  w.focus()
}
