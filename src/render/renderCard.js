/**
 * index.js — Firebase-compatible card renderer
 *
 * Uses Puppeteer + @sparticuz/chromium (no native system libs needed).
 * Renders the designer template as HTML/CSS, then exports PNG + PDF.
 *
 * Dependencies:
 *   npm install puppeteer-core @sparticuz/chromium pdfjs-dist qrcode
 */

'use strict'

const puppeteer = require('puppeteer-core')
const chromium = require('@sparticuz/chromium')
const QRCode = require('qrcode')
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js')
const fs = require('fs')
const path = require('path')
const https = require('https')
const http = require('http')
const os = require('os')

pdfjsLib.GlobalWorkerOptions.workerSrc = null

// ─── PDF downloader ───────────────────────────────────────────────────────────

/**
 * Downloads a PDF from a URL (Firebase Storage or any https URL) to a tmp file.
 * Returns the local file path. Caller is responsible for deleting it.
 */
function downloadPdfToTmp(url) {
  return new Promise((resolve, reject) => {
    const tmpPath = path.join(os.tmpdir(), `pdf_${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`)
    const file = fs.createWriteStream(tmpPath)
    const client = url.startsWith('https') ? https : http

    client.get(url, (res) => {
      // Follow redirects
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close()
        fs.unlinkSync(tmpPath)
        return downloadPdfToTmp(res.headers.location).then(resolve).catch(reject)
      }
      if (res.statusCode !== 200) {
        file.close()
        fs.unlinkSync(tmpPath)
        return reject(new Error(`Failed to download PDF: HTTP ${res.statusCode} from ${url}`))
      }
      res.pipe(file)
      file.on('finish', () => file.close(() => resolve(tmpPath)))
    }).on('error', (err) => {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath)
      reject(err)
    })
  })
}

// ─── PDF page dimensions reader ───────────────────────────────────────────────

/**
 * Reads page dimensions from the PDF and returns the raw base64 + page sizes.
 * The PDF itself is rendered inside Puppeteer via browser-side pdf.js.
 */
async function pdfPagesToBase64(rawBytes) {
  const data = new Uint8Array(rawBytes)
  const pdf = await pdfjsLib.getDocument({ data }).promise

  const pages = await Promise.all(
    Array.from({ length: pdf.numPages }, async (_, i) => {
      const page = await pdf.getPage(i + 1)
      const vp = page.getViewport({ scale: 1 })
      return { width: vp.width, height: vp.height }
    })
  )

  return {
    base64: rawBytes.toString('base64'),
    numPages: pdf.numPages,
    pages,
  }
}

// ─── QR code generator ────────────────────────────────────────────────────────

async function qrToDataUrl(value, sizePx = 256) {
  if (!value) return null
  return QRCode.toDataURL(String(value), {
    width: sizePx,
    margin: 1,
    color: { dark: '#000000', light: '#ffffff' },
  })
}

// ─── HTML builder ─────────────────────────────────────────────────────────────

/**
 * COORDINATE SYSTEM EXPLANATION
 * ──────────────────────────────
 * The designer stores:
 *   - page width/height  in PDF points (pt)
 *   - element x/y/w/h   as fractions 0–1 of the page
 *   - fontSize           in PDF points (pt)
 *
 * We render the HTML page at exactly 1px per PDF point (PT_TO_PX = 1).
 * This means the page is e.g. 595px × 842px for A4.
 *
 * Element positions are:  fraction × pagePt × PT_TO_PX  → absolute px
 * Font sizes are:         fontPt × (PT_TO_PX / 1.3333)  → px
 *   The /1.3333 corrects for the browser's internal pt→px scaling
 *   (browsers treat 1pt = 1.333px at 96dpi) which would otherwise
 *   make every font 33% too large since our page is already in px, not pt.
 *
 * deviceScaleFactor:2 on the viewport makes the PNG 2× resolution (sharp)
 * without changing the CSS layout — it only affects the pixel output.
 */
/**
 * Extracts all unique font families from the template and builds
 * Google Fonts <link> tags for each one. Falls back to DM Sans always.
 * Handles values like "Inter, sans-serif" or "Pacifico" or "DM Sans".
 */
function buildFontLinks(templateJson) {
  const GENERIC = new Set(['sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'system-ui'])
  const families = new Set(['DM Sans']) // always include base font

  for (const page of templateJson.pages || []) {
    for (const el of page.elements || []) {
      if (!el.fontFamily) continue
      // fontFamily may be: "Inter, sans-serif" or '"Dancing Script", cursive' or 'Pacifico'
      // Split on comma, take first token, strip surrounding quotes and whitespace
      const raw = el.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '').trim()
      if (raw && !GENERIC.has(raw)) {
        families.add(raw)
      }
    }
  }

  // Build one Google Fonts link per family.
  // Most decorative/script fonts only have weight 400 — request a broad range
  // and Google Fonts will return what's available without erroring.
  return Array.from(families).map(family => {
    const urlFamily = encodeURIComponent(family).replace(/%20/g, '+')
    const url = `https://fonts.googleapis.com/css2?family=${urlFamily}:ital,wght@0,400;0,500;0,600;0,700;1,400;1,700&display=swap`
    return `<link href="${url}" rel="stylesheet">`
  }).join('\n')
}

function buildHtml(templateJson, attendeeData, pdfBase64, pageDimensions, qrDataUrls, fontLinks) {
  const PT_TO_PX = 1 // 1 PDF point = 1 CSS px in our layout coordinate space

  const pageSections = templateJson.pages.map((templatePage, i) => {
    const dim = pageDimensions[i] || pageDimensions[0]
    const { width: ptW, height: ptH } = dim
    const pageNumber = templatePage.pageNumber || i + 1

    const pxW = (ptW * PT_TO_PX).toFixed(2)
    const pxH = (ptH * PT_TO_PX).toFixed(2)

    const elements = (templatePage.elements || []).map(el => {
      // Convert fractional positions to absolute px
      const x = (el.x * ptW * PT_TO_PX).toFixed(2)
      const y = (el.y * ptH * PT_TO_PX).toFixed(2)
      const w = (el.width * ptW * PT_TO_PX).toFixed(2)
      const h = (el.height * ptH * PT_TO_PX).toFixed(2)

      if (el.type === 'text') {
        const value = attendeeData[el.key] !== undefined
          ? String(attendeeData[el.key])
          : el.label || el.key

        // The designer stores fontSize in px relative to a 2× rendered canvas
        // (pdf.js renders at scale:2, so containerWidth = naturalWidth * 2).
        // Our layout is 1px per PDF point (natural size = 1× scale).
        // Therefore divide fontSize by 2 to get the correct size in our coordinate space.
        const fontSizePx = ((el.fontSize || 14) / 2).toFixed(2)
        const fontWeight = el.fontWeight || 'normal'
        const align = el.align || 'left'
        const color = el.color || '#000000'

        // Strip outer escaped quotes from fontFamily for safe inline CSS use
        // e.g. '"Dancing Script", cursive' → 'Dancing Script, cursive'
        const fontFamily = (el.fontFamily || 'DM Sans, sans-serif').replace(/['"]/g, '')
        // Wrap in a block span so text-align is respected within the flex container
        return `<div class="el-text" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;font-size:${fontSizePx}px;font-weight:${fontWeight};color:${color};font-family:${fontFamily};"><span style="display:block;width:100%;text-align:${align};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(value)}</span></div>`

      } else if (el.type === 'qr') {
        const dataUrl = qrDataUrls[el.id]
        if (!dataUrl) return '' // silently skip — no data, no QR
        // Use the smaller of width/height as the square size, then center within bounds
        const qrSize = Math.min(parseFloat(w), parseFloat(h)).toFixed(2)
        const offsetX = ((parseFloat(w) - parseFloat(qrSize)) / 2).toFixed(2)
        const offsetY = ((parseFloat(h) - parseFloat(qrSize)) / 2).toFixed(2)
        return `<div class="el-qr" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;"><img src="${dataUrl}" style="position:absolute;left:${offsetX}px;top:${offsetY}px;width:${qrSize}px;height:${qrSize}px;display:block;"></div>`
      }
      return ''
    }).join('\n')

    return `
<section class="page" data-page="${pageNumber}" data-ptw="${ptW}" data-pth="${ptH}" style="width:${pxW}px;height:${pxH}px;page:p${i};">
  <canvas class="pdf-bg" id="pdf-bg-${i}"></canvas>
  <div class="overlay">${elements}</div>
</section>`
  }).join('\n')

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { background: white; }
  body { font-family: 'DM Sans', 'Helvetica Neue', Arial, sans-serif; }

  .page {
    position: relative;
    display: block;
    overflow: hidden;
    page-break-after: always;
    break-after: page;
  }
  .pdf-bg {
    position: absolute;
    top: 0; left: 0;
    width: 100%; height: 100%;
    display: block;
  }
  .overlay {
    position: absolute;
    top: 0; left: 0;
    width: 100%; height: 100%;
  }
  .el-text {
    position: absolute;
    display: flex;
    align-items: center;
    overflow: hidden;
    white-space: nowrap;
    line-height: 1.2;
  }
  .el-qr {
    position: absolute;
  }
  @media print {
    .page { page-break-after: always; break-after: page; }
  }
</style>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
${fontLinks}
<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
</head>
<body>
${pageSections}
<script>
(async function() {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'

  const pdfData = atob('${pdfBase64}')
  const pdfBytes = new Uint8Array(pdfData.length)
  for (let i = 0; i < pdfData.length; i++) pdfBytes[i] = pdfData.charCodeAt(i)

  const pdf = await pdfjsLib.getDocument({ data: pdfBytes }).promise
  const sections = document.querySelectorAll('.page')

  for (let i = 0; i < sections.length; i++) {
    const section  = sections[i]
    const pageNum  = parseInt(section.dataset.page)
    const ptW      = parseFloat(section.dataset.ptw)
    const ptH      = parseFloat(section.dataset.pth)
    const canvas   = section.querySelector('.pdf-bg')
    const ctx      = canvas.getContext('2d')

    const page     = await pdf.getPage(pageNum)

    // Render at 2× for sharpness but keep the canvas CSS size = page px size
    const RENDER_SCALE = 2
    const viewport = page.getViewport({ scale: RENDER_SCALE })
    canvas.width   = viewport.width   // actual pixel buffer (2×)
    canvas.height  = viewport.height
    // CSS size stays 1:1 with the layout — CSS handles the downscaling
    canvas.style.width  = ptW + 'px'
    canvas.style.height = ptH + 'px'

    await page.render({ canvasContext: ctx, viewport }).promise
  }

  window.__PDF_RENDERED__ = true
})()
<\/script>
</body>
</html>`
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ─── Puppeteer launcher ───────────────────────────────────────────────────────

async function launchBrowser() {
  // @sparticuz/chromium bundles a prebuilt Linux x86-64 binary — it's built
  // for the VPS/Lambda-style Linux target, and chromium.executablePath()
  // happily resolves to it on any OS (it doesn't check whether the binary
  // can actually run here). Spawning that ELF binary on macOS/Windows fails
  // with ENOEXEC, not a catchable "not found" error, so the old try/catch
  // around executablePath() never reached the local-Chrome fallback below.
  // Only trust it on the platform it was actually built for.
  let executablePath = null
  if (process.platform === 'linux') {
    try {
      executablePath = await chromium.executablePath()
    } catch {
      executablePath = null
    }
  }

  if (!executablePath) {
    const localPaths = [
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ]
    executablePath = localPaths.find(p => fs.existsSync(p)) || null
  }
  if (!executablePath) {
    throw new Error('No usable Chromium/Chrome executable found for this platform.')
  }

  return puppeteer.launch({
    args: process.platform === 'linux' ? chromium.args : [],
    defaultViewport: chromium.defaultViewport,
    executablePath,
    headless: chromium.headless ?? true,
    ignoreHTTPSErrors: true,
  })
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * renderCard — import this in your Firebase Cloud Function.
 *
 * @param {object} templateJson   — exportTemplate() output from the designer app
 * @param {object} attendeeData   — flat key→value map e.g. { full_name, qr_code, ... }
 * @param {string} pdfUrl         — Firebase Storage URL (or any https URL) to the PDF template
 * @param {object} [options]
 * @param {string} [options.outputDir]       — write card.png + card.pdf here if set
 * @param {string} [options.outputBaseName]  — filename stem, default 'card'
 *
 * @returns {Promise<{ pngBuffer: Buffer, pdfBuffer: Buffer }>}
 */
async function renderCard(templateJson, attendeeData, pdfUrl, options = {}) {
  if (!templateJson?.pages?.length) {
    throw new Error('Invalid templateJson: must have at least one page.')
  }
  if (!pdfUrl || !pdfUrl.startsWith('http')) {
    throw new Error('pdfUrl must be a valid http/https URL.')
  }

  const { outputDir, outputBaseName = 'card' } = options

  // ── 1. Download PDF from URL → tmp file, read bytes, then clean up ──────────
  console.log('📄 Downloading PDF...')
  let tmpPdfPath
  let rawPdfBytes
  try {
    tmpPdfPath = await downloadPdfToTmp(pdfUrl)
    rawPdfBytes = fs.readFileSync(tmpPdfPath)
  } finally {
    if (tmpPdfPath && fs.existsSync(tmpPdfPath)) fs.unlinkSync(tmpPdfPath)
  }

  const { base64: pdfBase64, pages: pageDimensions } = await pdfPagesToBase64(rawPdfBytes)

  // ── 2. Pre-generate QR codes server-side ────────────────────────────────────
  console.log('🔲 Generating QR codes...')
  const qrDataUrls = {}
  for (const page of templateJson.pages) {
    for (const el of page.elements || []) {
      if (el.type === 'qr') {
        const val = attendeeData[el.key]
        if (val) {
          const dim = pageDimensions[(page.pageNumber || 1) - 1] || pageDimensions[0]
          const sizePx = Math.round(el.width * dim.width * 2) // 2× for sharpness
          qrDataUrls[el.id] = await qrToDataUrl(val, sizePx)
        }
      }
    }
  }

  // ── 3. Build HTML ───────────────────────────────────────────────────────────
  console.log('🏗️  Building HTML...')
  const fontLinks = buildFontLinks(templateJson)
  const html = buildHtml(templateJson, attendeeData, pdfBase64, pageDimensions, qrDataUrls, fontLinks)

  // ── 4. Launch Puppeteer ─────────────────────────────────────────────────────
  console.log('🚀 Launching Puppeteer...')
  const browser = await launchBrowser()
  let pngBuffer, pdfBuffer

  try {
    const page = await browser.newPage()
    const firstPage = pageDimensions[0]

    // Viewport matches our layout coordinate space (1px per PDF point)
    // deviceScaleFactor:2 makes PNG 2× sharp without affecting CSS layout
    await page.setViewport({
      width: Math.ceil(firstPage.width),
      height: Math.ceil(firstPage.height),
      deviceScaleFactor: 2,
    })

    await page.setContent(html, { waitUntil: 'networkidle0' })

    // Wait for pdf.js to finish rendering all PDF background canvases
    await page.waitForFunction('window.__PDF_RENDERED__ === true', { timeout: 20000 })

    // Wait for DM Sans to fully load
    await page.evaluateHandle('document.fonts.ready')

    // ── PNG ──────────────────────────────────────────────────────────────────
    console.log('📸 Capturing PNG...')
    pngBuffer = await page.screenshot({ fullPage: true, type: 'png' })

    // ── PDF ──────────────────────────────────────────────────────────────────
    // Measure each page section individually so we can set a named @page rule
    // per section. A single global @page size breaks multi-page PDFs because
    // each page can have a different height.
    const pageSizes = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.page')).map((s, i) => ({
        name: 'p' + i,
        width: s.offsetWidth,
        height: s.offsetHeight,
      }))
    })

    // Assign each .page section a page-name so its @page rule targets it alone
    await page.evaluate((sizes) => {
      const sections = document.querySelectorAll('.page')
      sections.forEach((s, i) => {
        s.style.pageBreakAfter = 'always'
        s.style.breakAfter = 'page'
        s.style.pageName = sizes[i].name
      })
    }, pageSizes)

    // Build one named @page rule per page with its exact dimensions
    const pageCSS = pageSizes.map(p =>
      `@page ${p.name} { size: ${p.width}px ${p.height}px; margin: 0; }`
    ).join('\n')

    await page.addStyleTag({ content: pageCSS })

    console.log('🖨️  Generating PDF...')
    pdfBuffer = await page.pdf({
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    })

  } finally {
    await browser.close()
  }

  // ── 5. Write to disk if requested ───────────────────────────────────────────
  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true })
    const pngOut = path.join(outputDir, `${outputBaseName}.png`)
    const pdfOut = path.join(outputDir, `${outputBaseName}.pdf`)
    fs.writeFileSync(pngOut, pngBuffer)
    fs.writeFileSync(pdfOut, pdfBuffer)
    console.log(`✅ PNG → ${pngOut}`)
    console.log(`✅ PDF → ${pdfOut}`)
  }

  return { pngBuffer, pdfBuffer }
}

module.exports = { renderCard }