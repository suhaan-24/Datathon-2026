import { useState, useEffect, useRef } from 'react'
import * as d3 from 'd3'

const NODE_STYLE = {
  accused:  { color: '#ef4444', shape: 'circle',  label: 'Accused' },
  victim:   { color: '#3b82f6', shape: 'circle',  label: 'Victim' },
  location: { color: '#00ff9d', shape: 'diamond', label: 'Location' },
  incident: { color: '#f59e0b', shape: 'square',  label: 'Incident' },
}

export default function NetworkPanel({ auth }) {
  const stageRef   = useRef(null)
  const svgRef     = useRef(null)
  const nodeSelRef = useRef(null)
  const zoomRef    = useRef(null)   // { zoom, svg }
  const [data, setData]         = useState(null)
  const [selected, setSelected] = useState(null)
  const [search, setSearch]     = useState('')

  useEffect(() => {
    let active = true
    fetch('/api/network', { headers: { 'x-auth-token': auth.token } })
      .then(r => r.json())
      .then(d => { if (active) setData(d) })
      .catch(() => {})
    return () => { active = false }
  }, [auth.token])

  /* ── D3 force simulation ── */
  useEffect(() => {
    if (!data || !svgRef.current || !stageRef.current) return

    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()
    const { width, height } = stageRef.current.getBoundingClientRect()

    // All drawing goes into this group — zoom.transform targets it
    const g = svg.append('g').attr('class', 'zoom-layer')

    const nodes = data.nodes.map(d => ({ ...d }))
    const links = data.edges.map(d => ({ ...d }))

    const degree = {}
    links.forEach(l => {
      degree[l.source] = (degree[l.source] || 0) + 1
      degree[l.target] = (degree[l.target] || 0) + 1
    })
    const radius = d => 7 + (degree[d.id] || 1) * 2.4

    const sim = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links).id(d => d.id).distance(95).strength(0.7))
      .force('charge', d3.forceManyBody().strength(-340))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collide', d3.forceCollide().radius(d => radius(d) + 16))

    const link = g.append('g')
      .selectAll('line')
      .data(links)
      .join('line')
      .attr('stroke', '#1e3a5f')
      .attr('stroke-width', 1.4)
      .attr('stroke-opacity', 0.8)

    const node = g.append('g')
      .selectAll('g')
      .data(nodes)
      .join('g')
      .style('cursor', 'pointer')
      .call(d3.drag()
        .on('start', (e, d) => {
          if (!e.active) sim.alphaTarget(0.25).restart()
          d.fx = d.x; d.fy = d.y
        })
        .on('drag', (e, d) => { d.fx = e.x; d.fy = e.y })
        .on('end', (e, d) => {
          if (!e.active) sim.alphaTarget(0)
          d.fx = null; d.fy = null
        }))

    node.each(function (d) {
      const el = d3.select(this)
      const st = NODE_STYLE[d.type] || NODE_STYLE.accused
      const r  = radius(d)
      let shape
      if (st.shape === 'diamond') {
        shape = el.append('rect')
          .attr('x', -r).attr('y', -r)
          .attr('width', r * 2).attr('height', r * 2)
          .attr('transform', 'rotate(45)')
          .attr('rx', 2)
      } else if (st.shape === 'square') {
        shape = el.append('rect')
          .attr('x', -r).attr('y', -r)
          .attr('width', r * 2).attr('height', r * 2)
          .attr('rx', 3)
      } else {
        shape = el.append('circle').attr('r', r)
      }
      shape
        .attr('fill', st.color + '26')
        .attr('stroke', st.color)
        .attr('stroke-width', 1.6)
        .style('filter', `drop-shadow(0 0 6px ${st.color}66)`)

      el.append('text')
        .text(d.label)
        .attr('text-anchor', 'middle')
        .attr('dy', r + 15)
        .attr('fill', '#94a3b8')
        .attr('font-size', '9.5px')
        .attr('font-family', "'JetBrains Mono', monospace")
        .style('pointer-events', 'none')
    })

    const connected = (a, b) =>
      a.id === b.id ||
      links.some(l =>
        (l.source.id === a.id && l.target.id === b.id) ||
        (l.source.id === b.id && l.target.id === a.id))

    node
      .on('mouseenter', (_, d) => {
        link
          .attr('stroke', l => (l.source.id === d.id || l.target.id === d.id) ? '#00d4ff' : '#1e3a5f')
          .attr('stroke-width', l => (l.source.id === d.id || l.target.id === d.id) ? 2.2 : 1.4)
          .attr('stroke-opacity', l => (l.source.id === d.id || l.target.id === d.id) ? 1 : 0.25)
        node.attr('opacity', n => connected(d, n) ? 1 : 0.25)
      })
      .on('mouseleave', () => {
        link.attr('stroke', '#1e3a5f').attr('stroke-width', 1.4).attr('stroke-opacity', 0.8)
        node.attr('opacity', 1)
      })
      .on('click', (e, d) => { e.stopPropagation(); setSelected(d) })

    nodeSelRef.current = node

    // ── Zoom / Pan ──────────────────────────────────────────────────────────────
    const zoom = d3.zoom()
      .scaleExtent([0.1, 5])
      .on('zoom', e => g.attr('transform', e.transform))

    svg
      .call(zoom)
      .on('dblclick.zoom', null)   // reserve double-click for fit-to-view
      .on('click', () => setSelected(null))

    zoomRef.current = { zoom, svg }

    sim.on('tick', () => {
      link
        .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x).attr('y2', d => d.target.y)
      node.attr('transform', d => `translate(${d.x},${d.y})`)
    })

    // Auto-fit once simulation settles
    sim.on('end', () => {
      applyFit(zoom, svg, g, width, height)
    })

    return () => {
      sim.stop()
      nodeSelRef.current = null
      zoomRef.current    = null
    }
  }, [data])

  /* ── Search filter ── */
  useEffect(() => {
    if (!nodeSelRef.current) return
    const q = search.toLowerCase().trim()
    nodeSelRef.current.attr('opacity', d =>
      !q ||
      d.label.toLowerCase().includes(q) ||
      (d.detail?.location || '').toLowerCase().includes(q)
        ? 1 : 0.12)
  }, [search, data])

  function applyFit(zoom, svg, g, w, h) {
    try {
      const bbox = g.node().getBBox()
      if (!bbox.width || !bbox.height) return
      const pad   = 48
      const scale = Math.min((w - pad * 2) / bbox.width, (h - pad * 2) / bbox.height, 1.6)
      const tx    = w / 2 - scale * (bbox.x + bbox.width / 2)
      const ty    = h / 2 - scale * (bbox.y + bbox.height / 2)
      svg.transition().duration(600)
        .call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale))
    } catch {}
  }

  function handleFit() {
    if (!zoomRef.current || !stageRef.current) return
    const { zoom, svg } = zoomRef.current
    const { width, height } = stageRef.current.getBoundingClientRect()
    applyFit(zoom, svg, svg.select('.zoom-layer'), width, height)
  }

  function handleZoom(factor) {
    if (!zoomRef.current) return
    zoomRef.current.svg.transition().duration(220)
      .call(zoomRef.current.zoom.scaleBy, factor)
  }

  const selStyle = selected ? (NODE_STYLE[selected.type] || NODE_STYLE.accused) : null

  return (
    <div className="panel-wrap">
      <div className="panel-head">
        <div>
          <div className="section-title">Network Analysis</div>
          <div className="section-sub">
            CRIMINAL LINK CHART · {data
              ? `${data.nodes.length} ENTITIES · ${data.edges.length} CONNECTIONS`
              : 'LOADING…'}
          </div>
        </div>
        <input
          className="kw-input"
          style={{ maxWidth: 300 }}
          placeholder="Search name or location…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      <div className="net-stage" ref={stageRef}>
        <svg ref={svgRef} />

        {/* Zoom controls */}
        <div className="net-zoom-ctrls glass">
          <button className="nzc-btn" onClick={() => handleZoom(1.5)} title="Zoom in">+</button>
          <button className="nzc-btn" onClick={() => handleZoom(1 / 1.5)} title="Zoom out">−</button>
          <button className="nzc-btn nzc-fit" onClick={handleFit} title="Fit all nodes">⊡</button>
        </div>

        <div className="net-legend glass">
          {Object.values(NODE_STYLE).map(st => (
            <span key={st.label} className="lg">
              <span
                className="sw"
                style={{
                  background: st.color + '33',
                  border: `1.5px solid ${st.color}`,
                  borderRadius: st.shape === 'circle' ? '50%' : 2,
                  transform: st.shape === 'diamond' ? 'rotate(45deg)' : 'none',
                }}
              />
              {st.label.toUpperCase()}
            </span>
          ))}
          <span className="lg" style={{ marginTop: 4 }}>NODE SIZE = CONNECTIONS</span>
          <span className="lg net-hint">SCROLL TO ZOOM · DRAG TO PAN</span>
        </div>

        {selected && (
          <div className="net-panel glass">
            <button className="np-close" onClick={() => setSelected(null)}>✕</button>
            <div className="np-type" style={{ color: selStyle.color }}>
              ◉ {selStyle.label}
            </div>
            <h4>{selected.label}</h4>
            <dl style={{ marginTop: '0.6rem' }}>
              <dt>Role</dt><dd>{selected.detail?.role || '—'}</dd>
              <dt>Cases</dt><dd>{(selected.detail?.cases || []).join(', ') || '—'}</dd>
              <dt>Last seen</dt><dd className="mono">{selected.detail?.lastSeen || '—'}</dd>
              <dt>District</dt><dd>{selected.detail?.location || '—'}</dd>
            </dl>
          </div>
        )}
      </div>
    </div>
  )
}
