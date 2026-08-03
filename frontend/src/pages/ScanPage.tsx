import { useRef, useState } from 'react';
import { PageHeader } from '../components/ui';
import { loadOpenCv } from '../lib/opencvLoader';
import { analyzeScannedDocument, confirmScannedDocument } from '../api/client';
import type { DocumentCategory, DocumentClassification, DocumentMatch } from '../types';
import { DOCUMENT_CATEGORY_LABELS } from '../types';

type Corners = {
  topLeftCorner: { x: number; y: number };
  topRightCorner: { x: number; y: number };
  bottomLeftCorner: { x: number; y: number };
  bottomRightCorner: { x: number; y: number };
};

interface ScannedPage {
  id: string;
  dataUrl: string; // corrected JPEG, base64 data URL
}

type Step = 'capture' | 'analyzing' | 'review' | 'saved';

export default function ScanPage() {
  const [pages, setPages] = useState<ScannedPage[]>([]);
  const [capturing, setCapturing] = useState<{ img: HTMLImageElement; corners: Corners } | null>(null);
  const [step, setStep] = useState<Step>('capture');
  const [error, setError] = useState<string | null>(null);
  const [loadingCv, setLoadingCv] = useState(false);

  const [pdfBase64, setPdfBase64] = useState<string | null>(null);
  const [classified, setClassified] = useState<DocumentClassification | null>(null);
  const [match, setMatch] = useState<DocumentMatch | null>(null);
  const [properties, setProperties] = useState<{ id: string; address: string; nickname?: string }[]>([]);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<DocumentCategory>('OTHER');
  const [propertyId, setPropertyId] = useState('');
  const [saving, setSaving] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setError(null);
    setLoadingCv(true);
    try {
      const img = await loadImage(file);
      const [{ default: jscanify }] = await Promise.all([import('jscanify/client'), loadOpenCv()]);
      const cv = (window as any).cv;
      const scanner = new jscanify();
      const cvImg = cv.imread(img);
      let corners: Corners | null = null;
      try {
        const contour = scanner.findPaperContour(cvImg);
        if (contour) {
          const c = scanner.getCornerPoints(contour, cvImg);
          if (c.topLeftCorner && c.topRightCorner && c.bottomLeftCorner && c.bottomRightCorner) {
            corners = c as Corners;
          }
          contour.delete?.();
        }
      } finally {
        cvImg.delete();
      }
      if (!corners) {
        const inset = 0.06;
        corners = {
          topLeftCorner: { x: img.naturalWidth * inset, y: img.naturalHeight * inset },
          topRightCorner: { x: img.naturalWidth * (1 - inset), y: img.naturalHeight * inset },
          bottomLeftCorner: { x: img.naturalWidth * inset, y: img.naturalHeight * (1 - inset) },
          bottomRightCorner: { x: img.naturalWidth * (1 - inset), y: img.naturalHeight * (1 - inset) },
        };
      }
      setCapturing({ img, corners });
    } catch {
      setError('Could not process that photo. Try again with better lighting.');
    } finally {
      setLoadingCv(false);
    }
  }

  async function confirmPage() {
    if (!capturing) return;
    const { default: jscanify } = await import('jscanify/client');
    const scanner = new jscanify();
    const { topLeftCorner, topRightCorner, bottomLeftCorner, bottomRightCorner } = capturing.corners;
    const width = Math.round(Math.hypot(topRightCorner.x - topLeftCorner.x, topRightCorner.y - topLeftCorner.y));
    const height = Math.round(Math.hypot(bottomLeftCorner.x - topLeftCorner.x, bottomLeftCorner.y - topLeftCorner.y));
    const maxSide = 1600;
    const scale = Math.min(1, maxSide / Math.max(width, height, 1));
    const outW = Math.max(200, Math.round(width * scale));
    const outH = Math.max(200, Math.round(height * scale));

    const canvas = scanner.extractPaper(capturing.img, outW, outH, capturing.corners);
    if (!canvas) { setError('Could not extract the page. Try adjusting the corners.'); return; }
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    setPages(prev => [...prev, { id: `${Date.now()}_${prev.length}`, dataUrl }]);
    setCapturing(null);
  }

  function removePage(id: string) {
    setPages(prev => prev.filter(p => p.id !== id));
  }

  async function finishScan() {
    if (pages.length === 0) return;
    setError(null);
    setStep('analyzing');
    try {
      const { jsPDF } = await import('jspdf');
      const doc = new jsPDF({ unit: 'pt', format: 'letter' });
      pages.forEach((p, i) => {
        if (i > 0) doc.addPage();
        const pageW = doc.internal.pageSize.getWidth();
        const pageH = doc.internal.pageSize.getHeight();
        const margin = 24;
        const maxW = pageW - margin * 2;
        const maxH = pageH - margin * 2;
        const props = (doc as any).getImageProperties(p.dataUrl);
        const ratio = Math.min(maxW / props.width, maxH / props.height);
        const w = props.width * ratio;
        const h = props.height * ratio;
        doc.addImage(p.dataUrl, 'JPEG', (pageW - w) / 2, (pageH - h) / 2, w, h);
      });
      const dataUri: string = doc.output('datauristring');
      const base64 = dataUri.split(',')[1];
      setPdfBase64(base64);

      const result = await analyzeScannedDocument(base64);
      setClassified(result.classified);
      setMatch(result.match);
      setProperties(result.properties);
      setTitle(result.classified.title);
      setCategory(result.classified.category);
      if (result.match.confidence === 'high' || result.match.confidence === 'medium') {
        setPropertyId(result.match.propertyId || '');
      } else {
        setPropertyId('');
      }
      setStep('review');
    } catch {
      setError('Failed to analyze the scan. You can still save it manually below.');
      setStep('review');
    }
  }

  async function handleSave() {
    if (!pdfBase64 || !title) return;
    setSaving(true);
    setError(null);
    try {
      await confirmScannedDocument({
        fileData: pdfBase64,
        filename: `${title}.pdf`,
        propertyId: propertyId || null,
        category,
        title,
        pageCount: pages.length,
      });
      setStep('saved');
    } catch {
      setError('Failed to save the document. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  function resetAll() {
    setPages([]);
    setCapturing(null);
    setStep('capture');
    setPdfBase64(null);
    setClassified(null);
    setMatch(null);
    setProperties([]);
    setTitle('');
    setCategory('OTHER');
    setPropertyId('');
    setError(null);
  }

  return (
    <div>
      <PageHeader title="Scan" subtitle="Digitize physical mail — auto edge-detect, correct, and file it to the right property" />

      <div className="p-6 max-w-3xl mx-auto">
        {error && (
          <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 mb-4">{error}</div>
        )}

        {step === 'saved' ? (
          <div className="text-center py-16">
            <p className="text-lg font-semibold text-white mb-1">Document saved</p>
            <p className="text-sm text-gray-500 mb-6">
              Filed as {DOCUMENT_CATEGORY_LABELS[category]}{propertyId ? '' : ' in the generic Documents bucket'}.
            </p>
            <button onClick={resetAll} className="btn-primary px-4 py-2 text-sm">Scan another document</button>
          </div>
        ) : step === 'review' ? (
          <ReviewForm
            pages={pages}
            title={title} setTitle={setTitle}
            category={category} setCategory={setCategory}
            propertyId={propertyId} setPropertyId={setPropertyId}
            properties={properties}
            match={match}
            saving={saving}
            onSave={handleSave}
            onBack={() => setStep('capture')}
          />
        ) : step === 'analyzing' ? (
          <div className="text-center py-16 text-sm text-gray-500">Analyzing document…</div>
        ) : capturing ? (
          <CornerAdjust
            img={capturing.img}
            corners={capturing.corners}
            onChange={corners => setCapturing({ img: capturing.img, corners })}
            onConfirm={confirmPage}
            onCancel={() => setCapturing(null)}
          />
        ) : (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={handleFileSelected}
            />
            <div className="flex items-center justify-between mb-4">
              <p className="text-sm text-gray-400">
                {pages.length === 0 ? 'Capture the first page' : `${pages.length} page${pages.length > 1 ? 's' : ''} captured`}
              </p>
              <button
                disabled={loadingCv}
                onClick={() => fileInputRef.current?.click()}
                className="btn-primary px-4 py-2 text-sm disabled:opacity-50"
              >
                {loadingCv ? 'Loading scanner…' : pages.length === 0 ? '+ Capture page' : '+ Add another page'}
              </button>
            </div>

            {pages.length > 0 && (
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-3 mb-6">
                {pages.map((p, i) => (
                  <div key={p.id} className="relative rounded-lg overflow-hidden border border-white/10">
                    <img src={p.dataUrl} alt={`Page ${i + 1}`} className="w-full h-32 object-cover" />
                    <button
                      onClick={() => removePage(p.id)}
                      className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/70 text-white text-xs leading-none flex items-center justify-center hover:bg-red-600"
                    >×</button>
                    <span className="absolute bottom-1 left-1 text-[10px] text-white bg-black/60 rounded px-1">{i + 1}</span>
                  </div>
                ))}
              </div>
            )}

            {pages.length > 0 && (
              <button onClick={finishScan} className="btn-primary px-4 py-2 text-sm">
                Finish scan &amp; auto-sort ({pages.length} page{pages.length > 1 ? 's' : ''})
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Corner adjustment overlay ───────────────────────────────────────────────

function CornerAdjust({ img, corners, onChange, onConfirm, onCancel }: {
  img: HTMLImageElement;
  corners: Corners;
  onChange: (c: Corners) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<keyof Corners | null>(null);

  const displayW = 480;
  const displayH = (img.naturalHeight / img.naturalWidth) * displayW;

  function toDisplay(pt: { x: number; y: number }) {
    return { x: (pt.x / img.naturalWidth) * displayW, y: (pt.y / img.naturalHeight) * displayH };
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (!dragging || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX - rect.left, 0), displayW);
    const y = Math.min(Math.max(e.clientY - rect.top, 0), displayH);
    const natural = { x: (x / displayW) * img.naturalWidth, y: (y / displayH) * img.naturalHeight };
    onChange({ ...corners, [dragging]: natural });
  }

  const points: { key: keyof Corners; label: string }[] = [
    { key: 'topLeftCorner', label: 'TL' },
    { key: 'topRightCorner', label: 'TR' },
    { key: 'bottomLeftCorner', label: 'BL' },
    { key: 'bottomRightCorner', label: 'BR' },
  ];

  const dTL = toDisplay(corners.topLeftCorner);
  const dTR = toDisplay(corners.topRightCorner);
  const dBL = toDisplay(corners.bottomLeftCorner);
  const dBR = toDisplay(corners.bottomRightCorner);

  return (
    <div>
      <p className="text-sm text-gray-400 mb-3">Drag the corners to match the page edges, then confirm.</p>
      <div
        ref={containerRef}
        className="relative mx-auto touch-none select-none"
        style={{ width: displayW, height: displayH }}
        onPointerMove={handlePointerMove}
        onPointerUp={() => setDragging(null)}
        onPointerLeave={() => setDragging(null)}
      >
        <img src={img.src} alt="Captured page" width={displayW} height={displayH} className="absolute inset-0 rounded-lg" draggable={false} />
        <svg className="absolute inset-0 pointer-events-none" width={displayW} height={displayH}>
          <polygon
            points={`${dTL.x},${dTL.y} ${dTR.x},${dTR.y} ${dBR.x},${dBR.y} ${dBL.x},${dBL.y}`}
            fill="rgba(245,166,35,0.15)" stroke="#F5A623" strokeWidth={2}
          />
        </svg>
        {points.map(({ key, label }) => {
          const d = toDisplay(corners[key]);
          return (
            <div
              key={key}
              onPointerDown={() => setDragging(key)}
              className="absolute w-6 h-6 -ml-3 -mt-3 rounded-full bg-amber-400 border-2 border-white shadow cursor-grab active:cursor-grabbing flex items-center justify-center text-[9px] font-bold text-black"
              style={{ left: d.x, top: d.y }}
            >{label}</div>
          );
        })}
      </div>
      <div className="flex justify-center gap-2 mt-4">
        <button onClick={onCancel} className="btn-ghost px-4 py-2 text-sm">Retake</button>
        <button onClick={onConfirm} className="btn-primary px-4 py-2 text-sm">Use this page</button>
      </div>
    </div>
  );
}

// ─── Review / confirm form ────────────────────────────────────────────────────

function ReviewForm({ pages, title, setTitle, category, setCategory, propertyId, setPropertyId, properties, match, saving, onSave, onBack }: {
  pages: ScannedPage[];
  title: string; setTitle: (v: string) => void;
  category: DocumentCategory; setCategory: (v: DocumentCategory) => void;
  propertyId: string; setPropertyId: (v: string) => void;
  properties: { id: string; address: string; nickname?: string }[];
  match: DocumentMatch | null;
  saving: boolean;
  onSave: () => void;
  onBack: () => void;
}) {
  return (
    <div>
      <div className="flex gap-3 mb-5 overflow-x-auto">
        {pages.map((p, i) => (
          <img key={p.id} src={p.dataUrl} alt={`Page ${i + 1}`} className="w-20 h-24 object-cover rounded-lg border border-white/10 flex-shrink-0" />
        ))}
      </div>

      {match && match.confidence !== 'none' && (
        <p className="text-xs text-gray-500 mb-3">
          Suggested match: <span className="text-amber-400">{match.propertyName}</span> ({match.confidence} confidence)
        </p>
      )}

      <label className="field-label">Title</label>
      <input value={title} onChange={e => setTitle(e.target.value)} className="field-input mb-3 w-full" />

      <label className="field-label">Category</label>
      <select value={category} onChange={e => setCategory(e.target.value as DocumentCategory)} className="field-input mb-3 w-full">
        {Object.entries(DOCUMENT_CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>

      <label className="field-label">Property</label>
      <select value={propertyId} onChange={e => setPropertyId(e.target.value)} className="field-input mb-4 w-full">
        <option value="">— None (generic Documents) —</option>
        {properties.map(p => <option key={p.id} value={p.id}>{p.nickname || p.address}</option>)}
      </select>

      <div className="flex gap-2">
        <button onClick={onBack} className="btn-ghost px-4 py-2 text-sm">Back</button>
        <button disabled={!title || saving} onClick={onSave} className="btn-primary px-4 py-2 text-sm disabled:opacity-50">
          {saving ? 'Saving…' : 'Save document'}
        </button>
      </div>
    </div>
  );
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = url;
  });
}
