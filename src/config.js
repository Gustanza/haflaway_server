require('dotenv').config()

// ── Render concurrency ──────────────────────────────────────────────────────
//
// Each concurrent render job is a full headless Chromium instance (Puppeteer),
// rendering a template's HTML/PDF overlay and taking a full-page screenshot —
// genuinely heavy per job, not a cheap async task. Two different ceilings
// apply, and the real limit is whichever is lower:
//
// 1. RAM ceiling. Reserve a chunk for the OS + this Node process + headroom
//    (4GB is conservative for a VPS that might run other things too), and
//    assume ~500MB peak per Chromium instance (fonts + PDF.js + a 2x-scale
//    screenshot buffer) — a deliberately generous estimate, not a measured
//    one; tune CARD_RENDER_MB_PER_JOB below once real usage is observed.
//
// 2. CPU ceiling. Screenshot rendering is CPU-bound (layout + rasterization),
//    so running more concurrent jobs than there are cores just makes every
//    job slower, not more throughput. CARD_SERVER_VPS_CORES defaults to 6 —
//    a documented ASSUMPTION matching Contabo's Cloud VPS tier that commonly
//    ships with 24GB RAM, not a detected value. Set the real core count via
//    env once confirmed (`nproc` on the VPS) for an accurate number.
//
// The lower of the two wins, minus one core reserved for the Node event loop
// itself and everything else running on the box.

const TOTAL_RAM_MB = Number(process.env.CARD_SERVER_VPS_RAM_MB || 24576) // 24GB
const RESERVED_RAM_MB = Number(process.env.CARD_SERVER_RESERVED_RAM_MB || 4096) // OS + Node + headroom
const MB_PER_RENDER_JOB = Number(process.env.CARD_RENDER_MB_PER_JOB || 500)
const VPS_CORES = Number(process.env.CARD_SERVER_VPS_CORES || 6) // ASSUMPTION — confirm with `nproc`

const ramBoundConcurrency = Math.max(1, Math.floor((TOTAL_RAM_MB - RESERVED_RAM_MB) / MB_PER_RENDER_JOB))
const cpuBoundConcurrency = Math.max(1, VPS_CORES - 1)

const RENDER_CONCURRENCY = Number(
  process.env.CARD_RENDER_CONCURRENCY || Math.min(ramBoundConcurrency, cpuBoundConcurrency)
)

module.exports = {
  RENDER_CONCURRENCY,
  _debug: { TOTAL_RAM_MB, RESERVED_RAM_MB, MB_PER_RENDER_JOB, VPS_CORES, ramBoundConcurrency, cpuBoundConcurrency },
}
