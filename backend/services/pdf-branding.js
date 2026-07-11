const PDFDocument = require('pdfkit');
const path = require('path');

const FONT_DIR = path.join(__dirname, '..', '..', 'public', 'assets', 'fonts');
const LOGO_PATH = path.join(__dirname, '..', '..', 'public', 'assets', 'images', 'logomark.png');

// Mirrors the site's own CSS tokens (public/css/lumina.css light theme) so a
// downloaded document reads as the same brand as the portal, not a generic export.
const INDIGO = '#312e81';
const TEXT   = '#14110f';
const MUTED  = '#5a514a';
const FAINT  = '#ded6c7';

function registerFonts(doc) {
  doc.registerFont('Serif',        path.join(FONT_DIR, 'Cormorant-Regular.ttf'));
  doc.registerFont('Serif-Semi',   path.join(FONT_DIR, 'Cormorant-SemiBold.ttf'));
  doc.registerFont('Serif-Italic', path.join(FONT_DIR, 'Cormorant-Italic.ttf'));
  doc.registerFont('Sans',         path.join(FONT_DIR, 'ElmsSans-Regular.ttf'));
  doc.registerFont('Sans-Bold',    path.join(FONT_DIR, 'ElmsSans-Bold.ttf'));
}

function drawHeader(doc, category) {
  const top   = 36;
  const left  = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;

  doc.image(LOGO_PATH, left, top, { width: 24, height: 24 });
  doc.font('Serif').fontSize(15).fillColor(TEXT)
     .text('The ', left + 32, top + 4, { continued: true });
  doc.font('Serif-Italic').fillColor(INDIGO).text('Lumina', { continued: false });

  doc.font('Sans-Bold').fontSize(7.5).fillColor(MUTED)
     .text(category.toUpperCase(), left, top + 8, { width: right - left, align: 'right', characterSpacing: 1.4 });

  doc.moveTo(left, top + 34).lineTo(right, top + 34).lineWidth(1.4).strokeColor(INDIGO).stroke();
}

function drawFooter(doc, pageNum, pageCount) {
  const y     = doc.page.height - 46;
  const left  = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const half  = (right - left) / 2;

  // Drawing this close to the bottom edge trips pdfkit's auto-pagination even
  // with an explicit y (it still checks against margins.bottom and silently
  // inserts a blank extra page) - zero the margin out for this one draw.
  const savedBottom = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;

  doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).strokeColor(FAINT).stroke();
  doc.font('Sans').fontSize(7.5).fillColor(MUTED)
     .text('The Lumina  ·  Resident Document Library', left, y + 8, { width: half, align: 'left', lineBreak: false });
  doc.font('Sans').fontSize(7.5).fillColor(MUTED)
     .text(`Page ${pageNum} of ${pageCount}`, left + half, y + 8, { width: half, align: 'right', lineBreak: false });

  doc.page.margins.bottom = savedBottom;
}

// A line with no lowercase letters and no leading em-dash reads as a section
// header ("1. GENERAL CONDUCT" or a bare "DEVELOPMENT") regardless of whether
// the source document numbers its sections.
function isSectionHeader(line) {
  return line.length > 0 && line.length < 70 && !line.startsWith('—') && line === line.toUpperCase() && /[A-Z]/.test(line);
}

/**
 * @param {{title:string, category:string, updated:string, body:string}} doc
 * @returns {Promise<Buffer>}
 */
function buildBrandedPdf({ title, category, updated, body }) {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({
      size: 'A4',
      bufferPages: true,
      margins: { top: 92, bottom: 76, left: 56, right: 56 },
    });
    const chunks = [];
    pdf.on('data', (c) => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);

    registerFonts(pdf);
    pdf.on('pageAdded', () => drawHeader(pdf, category));
    drawHeader(pdf, category);

    pdf.font('Sans-Bold').fontSize(8).fillColor(INDIGO).text(category.toUpperCase(), { characterSpacing: 1.6 });
    pdf.moveDown(0.3);
    pdf.font('Serif-Semi').fontSize(25).fillColor(TEXT).text(title);
    pdf.moveDown(0.1);
    pdf.font('Sans').fontSize(9).fillColor(MUTED).text(updated);
    pdf.moveDown(1.3);

    let paragraph = [];
    const flush = () => {
      if (!paragraph.length) return;
      pdf.font('Sans').fontSize(10.5).fillColor(TEXT)
         .text(paragraph.join(' '), { align: 'justify', lineGap: 4 });
      pdf.moveDown(0.55);
      paragraph = [];
    };

    body.split('\n').forEach((raw) => {
      const line = raw.trim();
      if (!line) { flush(); return; }
      if (line.startsWith('—')) {
        flush();
        pdf.moveDown(0.5);
        pdf.font('Serif-Italic').fontSize(10.5).fillColor(MUTED).text(line);
      } else if (isSectionHeader(line)) {
        flush();
        pdf.moveDown(0.25);
        pdf.font('Serif-Semi').fontSize(12.5).fillColor(INDIGO).text(line);
        pdf.moveDown(0.2);
      } else {
        paragraph.push(line);
      }
    });
    flush();

    const range = pdf.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      pdf.switchToPage(i);
      drawFooter(pdf, i - range.start + 1, range.count);
    }

    pdf.end();
  });
}

module.exports = { buildBrandedPdf };
