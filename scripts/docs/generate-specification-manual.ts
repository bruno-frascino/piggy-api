import { createWriteStream, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import PDFDocument from 'pdfkit'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(dirname, '..', '..')
const sourcePath = path.join(root, 'docs', 'specification-system-manual.md')
const outputPath = path.join(root, 'docs', 'specification-system-manual.pdf')
const documentDate = new Date('2026-08-01T00:00:00.000Z')

const colors = {
  ink: '#17212B',
  muted: '#52606D',
  accent: '#0B6E69',
  line: '#D9E2EC',
  code: '#F2F6F7',
}

const doc = new PDFDocument({
  size: 'A4',
  bufferPages: true,
  margins: { top: 58, right: 54, bottom: 58, left: 54 },
  info: {
    Title: 'Truffles specification and context system',
    Author: 'Truffles engineering',
    Subject:
      'Operating manual for generated context and specification maintenance',
    CreationDate: documentDate,
    ModDate: documentDate,
  },
})

const stream = createWriteStream(outputPath)
doc.pipe(stream)

function ensureSpace(height: number): void {
  if (doc.y + height > doc.page.height - doc.page.margins.bottom) doc.addPage()
}

function renderInline(
  text: string,
  options: { size?: number; color?: string } = {}
): void {
  doc
    .font('Helvetica')
    .fontSize(options.size ?? 10.5)
    .fillColor(options.color ?? colors.ink)
    .text(text.replaceAll('`', ''), { lineGap: 3 })
}

function renderParagraph(text: string): void {
  ensureSpace(32)
  renderInline(text)
  doc.moveDown(0.35)
}

function renderHeading(level: number, text: string): void {
  const sizes: Record<number, number> = { 1: 25, 2: 17, 3: 12.5 }
  ensureSpace(level === 1 ? 80 : 46)
  if (level !== 1) doc.moveDown(level === 2 ? 0.8 : 0.45)
  doc
    .font('Helvetica-Bold')
    .fontSize(sizes[level] ?? 12)
    .fillColor(level === 1 ? colors.accent : colors.ink)
    .text(text, { lineGap: 3 })
  if (level === 1) {
    doc.moveDown(0.3)
    doc
      .strokeColor(colors.accent)
      .lineWidth(2)
      .moveTo(54, doc.y)
      .lineTo(190, doc.y)
      .stroke()
  }
  doc.moveDown(level === 1 ? 1 : 0.35)
}

function renderBullet(text: string): void {
  ensureSpace(28)
  const left = doc.x
  const top = doc.y
  doc
    .font('Helvetica-Bold')
    .fontSize(11)
    .fillColor(colors.accent)
    .text('•', left, top)
  doc.x = left + 15
  doc.y = top
  renderInline(text)
  doc.x = left
  doc.moveDown(0.2)
}

function renderNumbered(text: string, number: string): void {
  ensureSpace(28)
  const left = doc.x
  const top = doc.y
  doc
    .font('Helvetica-Bold')
    .fontSize(10.5)
    .fillColor(colors.accent)
    .text(number, left, top)
  doc.x = left + 20
  doc.y = top
  renderInline(text)
  doc.x = left
  doc.moveDown(0.2)
}

const lines = readFileSync(sourcePath, 'utf8').split(/\r?\n/)
let paragraph: string[] = []

function flushParagraph(): void {
  if (paragraph.length === 0) return
  renderParagraph(paragraph.join(' '))
  paragraph = []
}

for (const line of lines) {
  const heading = /^(#{1,3})\s+(.+)$/.exec(line)
  const bullet = /^-\s+(.+)$/.exec(line)
  const numbered = /^(\d+\.)\s+(.+)$/.exec(line)

  if (heading) {
    flushParagraph()
    renderHeading(heading[1].length, heading[2])
  } else if (bullet) {
    flushParagraph()
    renderBullet(bullet[1])
  } else if (numbered) {
    flushParagraph()
    renderNumbered(numbered[2], numbered[1])
  } else if (line.trim() === '') {
    flushParagraph()
  } else {
    paragraph.push(line.trim())
  }
}
flushParagraph()

const pageCount = doc.bufferedPageRange().count
for (let page = 0; page < pageCount; page += 1) {
  doc.switchToPage(page)
  const bottom = doc.page.height - 34
  const bodyBottomMargin = doc.page.margins.bottom
  doc.page.margins.bottom = 0
  doc
    .strokeColor(colors.line)
    .lineWidth(0.5)
    .moveTo(doc.page.margins.left, bottom - 9)
    .lineTo(doc.page.width - doc.page.margins.right, bottom - 9)
    .stroke()
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor(colors.muted)
    .text('Truffles engineering documentation', doc.page.margins.left, bottom, {
      lineBreak: false,
    })
    .text(`Page ${page + 1} of ${pageCount}`, doc.page.width - 130, bottom, {
      width: 76,
      align: 'right',
      lineBreak: false,
    })
  doc.page.margins.bottom = bodyBottomMargin
}

doc.end()

await new Promise<void>((resolve, reject) => {
  stream.on('finish', resolve)
  stream.on('error', reject)
})

console.log(`Wrote ${path.relative(root, outputPath)}`)
