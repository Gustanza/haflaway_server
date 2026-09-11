// Ported from functions/attendees/imagen.js — same compression/upload logic,
// adapted to this app's own Firebase Admin wiring (getBucket()) instead of
// calling admin.storage().bucket() directly.
const { getBucket } = require('../firebase')
const { renderCard } = require('./renderCard')
const sharp = require('sharp')
const { PDFDocument } = require('pdf-lib')

const WHATSAPP_LIMIT = 5 * 1024 * 1024

async function compressPng(buffer) {
  const compressed = await sharp(buffer)
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer()

  if (compressed.length < WHATSAPP_LIMIT) {
    return { buffer: compressed, ext: 'png', contentType: 'image/png' }
  }

  for (const quality of [85, 70, 55, 40]) {
    const jpeg = await sharp(buffer).jpeg({ quality }).toBuffer()
    if (jpeg.length < WHATSAPP_LIMIT) {
      return { buffer: jpeg, ext: 'jpg', contentType: 'image/jpeg' }
    }
  }

  const jpeg = await sharp(buffer).jpeg({ quality: 20 }).toBuffer()
  return { buffer: jpeg, ext: 'jpg', contentType: 'image/jpeg' }
}

async function compressPdf(buffer) {
  const pdfDoc = await PDFDocument.load(buffer)
  const compressed = await pdfDoc.save({ useObjectStreams: true })
  return Buffer.from(compressed)
}

// Renders one attendee's card and uploads the result to Firebase Storage,
// returning its public URL. Throws on failure — the caller (renderAttendeeCard)
// is responsible for treating that as a render failure, not swallowing it.
async function makeCard(templateJson, attendeeData, pdfUrl, usepng) {
  const { pngBuffer, pdfBuffer } = await renderCard(templateJson, attendeeData, pdfUrl)

  if (usepng) {
    const cleanAtName = attendeeData.full_name.trim().replace(/\s+/g, '_')

    let finalBuffer = pngBuffer
    let ext = 'png'
    let contentType = 'image/png'

    if (pngBuffer.length >= WHATSAPP_LIMIT) {
      const result = await compressPng(pngBuffer)
      finalBuffer = result.buffer
      ext = result.ext
      contentType = result.contentType
    }

    const filename = `Level0/${cleanAtName}_${attendeeData.pass_code}.${ext}`
    const bucket = getBucket()
    const file = bucket.file(filename)
    await file.save(finalBuffer, { metadata: { contentType } })
    await file.makePublic()
    return `https://storage.googleapis.com/${bucket.name}/${filename}`
  }

  let finalBuffer = pdfBuffer
  if (pdfBuffer.length >= WHATSAPP_LIMIT) {
    finalBuffer = await compressPdf(pdfBuffer)
  }

  const filename = `Level0/${attendeeData.full_name}_${attendeeData.pass_code}.pdf`
  const bucket = getBucket()
  const file = bucket.file(filename)
  await file.save(finalBuffer, { metadata: { contentType: 'application/pdf' } })
  await file.makePublic()
  return `https://storage.googleapis.com/${bucket.name}/${filename}`
}

module.exports = { makeCard }
