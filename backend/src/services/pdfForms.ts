/**
 * PDFs whose figures live in form fields, and text read in page order.
 *
 * Westlake Portfolio Management sends its statements as a fillable form: the
 * page itself prints only the labels ("Statement Date", "CURRENT AMOUNT DUE:",
 * "Previous Transaction Detail"), and every value — account number, dates,
 * amounts, the transaction rows — is a filled form field drawn on top. A text
 * reader sees the labels and none of the values, so the only dollar figure it
 * found was the "$5.00" processing fee in the fine print on the back, and a
 * run of $722.49 statements was filed as $5.00 bills with no breakdown.
 *
 * Flattening draws each field's own appearance into the page, so the values
 * become ordinary page text for every reader, the AI's included.
 */
import {
  PDFDocument, PDFName, PDFDict, PDFArray, PDFNumber, PDFStream, PDFRef,
  pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject,
} from 'pdf-lib';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require('pdf-parse') as (buf: Buffer, opts?: { pagerender?: (page: any) => Promise<string> }) => Promise<{ text: string }>;

/**
 * The PDF with every visible form field's appearance drawn into its page and
 * the form removed, or null when there is no filled field to draw. pdf-lib's
 * own flatten() throws on a widget without an appearance (Westlake's empty
 * image placeholders), so this draws the appearances directly and skips the
 * ones that have none.
 */
export async function flattenFormFields(buf: Buffer): Promise<Buffer | null> {
  try {
    const doc = await PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false });
    if (!doc.catalog.lookup(PDFName.of('AcroForm'))) return null;
    let drawn = 0;
    for (const page of doc.getPages()) {
      const annots = page.node.Annots();
      if (!annots) continue;
      const keep: PDFRef[] = [];
      for (let i = 0; i < annots.size(); i++) {
        const ref = annots.get(i);
        const a = doc.context.lookup(ref);
        const isWidget = a instanceof PDFDict && a.lookup(PDFName.of('Subtype')) === PDFName.of('Widget');
        if (!isWidget) { if (ref instanceof PDFRef) keep.push(ref); continue; }
        const flags = (a.lookup(PDFName.of('F')) as PDFNumber | undefined)?.asNumber?.() ?? 0;
        if (flags & 2) continue; // hidden
        const ap = a.lookup(PDFName.of('AP'));
        let n = ap instanceof PDFDict ? ap.get(PDFName.of('N')) : undefined;
        let appearance = n ? doc.context.lookup(n) : undefined;
        // A checkbox keeps one appearance per state; draw the one it is in.
        if (appearance instanceof PDFDict && !(appearance instanceof PDFStream)) {
          const state = a.lookup(PDFName.of('AS'));
          n = state instanceof PDFName ? appearance.get(state) : undefined;
          appearance = n ? doc.context.lookup(n) : undefined;
        }
        if (!(appearance instanceof PDFStream) || !(n instanceof PDFRef)) continue;
        const rectArr = a.lookup(PDFName.of('Rect'));
        if (!(rectArr instanceof PDFArray)) continue;
        const rect = rectArr.asRectangle();
        const bboxArr = appearance.dict.lookup(PDFName.of('BBox'));
        const bb = bboxArr instanceof PDFArray ? bboxArr.asRectangle() : { x: 0, y: 0, width: rect.width, height: rect.height };
        const sx = bb.width ? rect.width / bb.width : 1;
        const sy = bb.height ? rect.height / bb.height : 1;
        const name = page.node.newXObject('FlatField', n);
        page.pushOperators(
          pushGraphicsState(),
          concatTransformationMatrix(sx, 0, 0, sy, rect.x - bb.x * sx, rect.y - bb.y * sy),
          drawObject(name),
          popGraphicsState(),
        );
        drawn++;
      }
      page.node.set(PDFName.of('Annots'), doc.context.obj(keep));
    }
    if (!drawn) return null;
    doc.catalog.delete(PDFName.of('AcroForm'));
    return Buffer.from(await doc.save());
  } catch (e) {
    console.warn(`[PDFForms] could not flatten (${e instanceof Error ? e.message : e})`);
    return null;
  }
}

/**
 * The text layer read the way the page is laid out: fragments on the same
 * line joined left to right, lines top to bottom. The default reading follows
 * the content stream, which on a form-built statement puts every label first
 * and every value after it, and on a printed table can put the date, the
 * description and the amount of one row on three separate lines.
 */
export async function layoutText(buf: Buffer): Promise<string> {
  const render = async (page: any): Promise<string> => {
    const tc = await page.getTextContent({ normalizeWhitespace: true });
    const items: Frag[] = (tc.items as { str: string; transform: number[]; width?: number }[])
      .filter(i => i.str.trim())
      .map(i => ({ s: i.str.trim(), x: i.transform[4], y: i.transform[5], w: i.width ?? 0 }));
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const lines: { y: number; items: Frag[] }[] = [];
    for (const it of items) {
      const line = lines.find(l => Math.abs(l.y - it.y) <= 3);
      if (line) line.items.push(it); else lines.push({ y: it.y, items: [it] });
    }
    lines.sort((a, b) => b.y - a.y);
    for (const l of lines) l.items.sort((a, b) => a.x - b.x);
    const body = lines.map(l => l.items.map(i => i.s).join('  ')).join('\n');
    const pairs = headerPairs(lines);
    return pairs.length ? `${pairs.join('\n')}\n${body}` : body;
  };
  try { return (await pdfParse(buf, { pagerender: render })).text; } catch { return ''; }
}

interface Frag { s: string; x: number; y: number; w: number }

const VALUE = /^(?:\(?-?\$\s?-?[\d,]+\.\d{2}\)?(?:\s*CR)?|\d{1,2}\/\d{1,2}\/\d{2,4}|[A-Z]{0,3}\d[\d-]{3,}\d)$/;
// A column heading: two to five words, no digits, not a sentence.
const LABEL = /^[A-Za-z][A-Za-z&#/'()-]*(?: [A-Za-z&#/'()-]+){1,4}:?$/;

/**
 * A header row with its values printed under it — "Statement Date / Due
 * Date / Amount Due" over "09/08/2026 09/28/2026 $722.49" — read as
 * "Statement Date: 09/08/2026" lines, so a reader that looks for a label and
 * the figure after it finds the right one. Each value goes to the label
 * centred over it, one or two lines up. Placed before the page text, so the
 * labelled form is the first a label search meets.
 */
function headerPairs(lines: { y: number; items: Frag[] }[]): string[] {
  const out: string[] = [];
  const centre = (f: Frag) => f.x + f.w / 2;
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].items.filter(f => VALUE.test(f.s) && (f.s.match(/\d/g) ?? []).length >= 3);
    if (!values.length) continue;
    for (const v of values) {
      for (let j = i - 1; j >= Math.max(0, i - 2); j--) {
        if (lines[j].y - lines[i].y > 30) break;
        if (lines[j].items.length > 6) continue; // running text, not a header row
        const labels = lines[j].items.filter(f => LABEL.test(f.s) && f.s.length <= 30);
        if (labels.length < 2) continue; // a header row names several columns
        const best = labels.reduce((b, l) => Math.abs(centre(l) - centre(v)) < Math.abs(centre(b) - centre(v)) ? l : b);
        if (Math.abs(centre(best) - centre(v)) > Math.max(30, best.w)) continue;
        out.push(`${best.s.replace(/:$/, '')}: ${v.s}`);
        break;
      }
    }
  }
  return out;
}
