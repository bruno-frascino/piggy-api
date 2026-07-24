import PDFDocument from 'pdfkit'
import type { CgtReportResult } from './cgt-engine.js'
import { APP_ICON_PNG_BASE64 } from './app-icon.js'

export interface ReportUserInfo {
  name?: string | null
  email: string
}

const APP_ICON_PNG = Buffer.from(APP_ICON_PNG_BASE64, 'base64')

const BRAND = '#2563EB'
const TEXT = '#1A2B4B'
const TEXT_2 = '#52698A'
const DANGER = '#E5343A'

function formatAud(n: number): string {
  const sign = n < 0 ? '-' : ''
  return `${sign}$${Math.abs(n).toLocaleString('en-AU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

const DETAIL_COLUMNS: {
  header: string
  weight: number
  align?: 'left' | 'right'
  get: (l: CgtReportResult['lineItems'][number]) => string
}[] = [
  {
    header: 'Symbol',
    weight: 0.13,
    get: (l) => `${l.symbol} (${l.exchangeCode})`,
  },
  { header: 'Account', weight: 0.13, get: (l) => l.accountName },
  { header: 'Acquired', weight: 0.11, get: (l) => l.acquireDate },
  { header: 'Disposed', weight: 0.11, get: (l) => l.disposeDate },
  {
    header: 'Qty',
    weight: 0.06,
    align: 'right',
    get: (l) => l.quantity.toString(),
  },
  {
    header: 'Proceeds (AUD)',
    weight: 0.13,
    align: 'right',
    get: (l) => formatAud(l.proceedsAud),
  },
  {
    header: 'Cost base (AUD)',
    weight: 0.13,
    align: 'right',
    get: (l) => formatAud(l.costBaseAud),
  },
  {
    header: 'Gain/(Loss)',
    weight: 0.11,
    align: 'right',
    get: (l) => formatAud(l.capitalGainAud),
  },
  {
    header: 'Discount',
    weight: 0.09,
    align: 'right',
    get: (l) => (l.discountEligible ? 'Yes' : 'No'),
  },
]

/**
 * Renders a Capital Gains Tax summary PDF for a computed report result.
 * Uses `pdfkit` (pure-JS, no Chromium/native deps — important on a small VPS).
 */
export function buildCapitalGainsPdf(
  result: CgtReportResult,
  user: ReportUserInfo
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 })
    const chunks: Buffer[] = []
    doc.on('data', (chunk) => chunks.push(chunk as Buffer))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    const titleY = doc.y
    const iconSize = 22
    doc.image(APP_ICON_PNG, doc.page.margins.left, titleY - 2, {
      width: iconSize,
      height: iconSize,
    })
    doc
      .fontSize(18)
      .fillColor(TEXT)
      .text(
        'Truffles — Capital Gains Tax Summary',
        doc.page.margins.left + iconSize + 8,
        titleY
      )
    doc.x = doc.page.margins.left
    doc.moveDown(0.4)
    doc
      .fontSize(11)
      .fillColor(TEXT_2)
      .text(
        `${result.financialYearLabel} (1 Jul ${result.financialYearStartYear} – 30 Jun ${result.financialYearStartYear + 1})`
      )
    doc.moveDown(1.2)

    doc.fontSize(10).fillColor(TEXT)
    doc.text(`Prepared for: ${user.name ? `${user.name} ` : ''}(${user.email})`)
    doc.moveDown(0.4)
    doc.text(`Generated: ${new Date().toLocaleString('en-AU')}`)
    doc.moveDown(1.2)

    doc
      .fontSize(9)
      .fillColor(DANGER)
      .text(
        'This document is generated automatically and is NOT professional tax advice. ' +
          'Figures are estimates based on the data recorded in Truffles and simplified ATO ' +
          'capital gains rules. Please verify all figures with a registered tax agent before ' +
          'lodging your tax return.',
        { lineGap: 3 }
      )
    doc.fillColor(TEXT)
    doc.moveDown(1.5)

    const contentLeft = doc.page.margins.left
    const contentWidth =
      doc.page.width - doc.page.margins.left - doc.page.margins.right

    doc.fontSize(13).fillColor(BRAND).text('Summary')
    doc.moveDown(0.3)
    doc
      .moveTo(contentLeft, doc.y)
      .lineTo(contentLeft + contentWidth, doc.y)
      .strokeColor('#DDE3F0')
      .stroke()
    doc.moveDown(0.6)

    const summaryRows: [string, string][] = [
      ['Total proceeds', formatAud(result.totalProceedsAud)],
      ['Total cost base', formatAud(result.totalCostBaseAud)],
      ['Gross capital gain', formatAud(result.totalCapitalGainGrossAud)],
      ['Capital losses this year', formatAud(result.totalCapitalLossAud)],
      [
        'Carried-forward loss (opening)',
        formatAud(result.carriedForwardLossOpeningAud),
      ],
      ['CGT discount applied', formatAud(result.discountAppliedAud)],
      ['Net capital gain / (loss)', formatAud(result.netCapitalGainAud)],
      [
        'Carried-forward loss (closing)',
        formatAud(result.carriedForwardLossClosingAud),
      ],
    ]
    const summaryValueWidth = 140
    const summaryLabelWidth = contentWidth - summaryValueWidth
    doc.fontSize(10)
    for (const [label, value] of summaryRows) {
      const rowY = doc.y
      doc
        .fillColor(TEXT_2)
        .text(label, contentLeft, rowY, { width: summaryLabelWidth })
      doc.fillColor(TEXT).text(value, contentLeft + summaryLabelWidth, rowY, {
        width: summaryValueWidth,
        align: 'right',
      })
      doc.y = rowY + 18
    }
    doc.x = contentLeft
    doc.moveDown(0.8)
    doc
      .moveTo(contentLeft, doc.y)
      .lineTo(contentLeft + contentWidth, doc.y)
      .strokeColor('#DDE3F0')
      .stroke()
    doc.moveDown(0.8)

    doc.fontSize(9).fillColor(TEXT_2)
    doc.text(
      'Methodology: 50% CGT discount applied for individuals when an asset is held for more ' +
        'than 12 months. Capital losses (current year + any carried-forward balance) are applied ' +
        'first to non-discount-eligible gains, then to discount-eligible gains, before the 50% ' +
        'discount is applied to what remains — the ATO-preferred ordering that maximises the ' +
        'discount. Foreign-currency amounts are converted to AUD using the Reserve Bank of ' +
        "Australia's official daily exchange rates where available, falling back to Yahoo " +
        'Finance historical rates only when an RBA rate could not be resolved (e.g. dates before ' +
        '2023) — the source used for each disposal is noted in the detail table overleaf. Each ' +
        'position is treated as a single, discrete acquisition parcel.',
      { lineGap: 3 }
    )
    doc.fillColor(TEXT)

    doc.addPage()
    doc.fontSize(13).fillColor(BRAND).text('Disposal Detail')
    doc.moveDown(0.6)

    const startX = doc.page.margins.left
    const tableWidth =
      doc.page.width - doc.page.margins.left - doc.page.margins.right
    const columns = DETAIL_COLUMNS.map((col) => ({
      ...col,
      width: Math.floor(tableWidth * col.weight),
    }))
    const rowHeight = 18
    const cellPadding = 4

    const drawHeader = () => {
      const headerY = doc.y
      let x = startX
      doc.fontSize(8).fillColor(TEXT_2)
      for (const col of columns) {
        doc.text(col.header, x + cellPadding, headerY, {
          width: col.width - cellPadding,
          align: col.align ?? 'left',
          ellipsis: true,
          lineBreak: false,
        })
        x += col.width
      }
      doc.y = headerY + rowHeight
      doc
        .moveTo(startX, doc.y)
        .lineTo(startX + tableWidth, doc.y)
        .strokeColor('#94A3C7')
        .stroke()
      doc.moveDown(0.4)
      doc.fillColor(TEXT)
    }

    drawHeader()

    result.lineItems.forEach((item, index) => {
      if (doc.y > doc.page.height - doc.page.margins.bottom - rowHeight) {
        doc.addPage()
        drawHeader()
      }
      const rowY = doc.y
      if (index % 2 === 1) {
        doc
          .rect(startX, rowY - 2, tableWidth, rowHeight)
          .fillColor('#F5F7FC')
          .fill()
      }
      let x = startX
      doc.fontSize(8).fillColor(TEXT)
      for (const col of columns) {
        doc.text(col.get(item), x + cellPadding, rowY, {
          width: col.width - cellPadding,
          align: col.align ?? 'left',
          ellipsis: true,
          lineBreak: false,
        })
        x += col.width
      }
      doc.y = rowY + rowHeight
    })

    if (result.lineItems.length === 0) {
      doc
        .fontSize(9)
        .fillColor(TEXT_2)
        .text(
          'No disposals found for this financial year and account selection.'
        )
    }

    doc.end()
  })
}
