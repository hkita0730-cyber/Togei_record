import React, { useState, useEffect, useRef, useCallback, type CSSProperties } from 'react';
import { indexedDbAdapter as storage, describeStorageError } from './storage/indexedDbAdapter';
import {
  type Piece, type Idea, type SizeValue, type StageKey, type SaveStatus, type BackupPayload,
  SCHEMA_VERSION,
} from './types';

const THEME = {
  bg: '#E7DFCB',
  surface: '#F3EEDF',
  surfaceRaised: '#EAE2CC',
  border: '#D2C4A0',
  borderLight: '#BFAF88',
  text: '#3B2F20',
  textMuted: '#7C6B4E',
  textFaint: '#A5977B',
  clay: '#B67F3E',
  bisque: '#A15C3E',
  decoration: '#4C5F82',
  glaze: '#5B7A54',
  glazeLight: '#4A6644',
  danger: '#A63B2C',
  dangerBg: '#F3DAD2',
  onAccent: '#FBF7EE',
};

const FONT_DISPLAY = "'Yomogi', sans-serif";
const FONT_BODY = "'Zen Maru Gothic', sans-serif";
const FONT_MONO = "'JetBrains Mono', monospace";

const BASE_TECHNIQUES = ['鎬', 'いっちん', '掻き落とし', '象嵌(ミシマ)', 'スタンプ', 'ステンシル', '下絵付け', '撥水'];
const SAVE_DEBOUNCE_MS = 700;
const FIRST_VISIT_KEY = 'seenIntroTip';

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function todayISO() {
  // local (device) date, not UTC — avoids the date rolling back a day during
  // late-night/early-morning hours if we used toISOString().
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function fmtDate(d: string) {
  if (!d) return '';
  const [y, m, day] = d.split('-');
  return `${y}.${m}.${day}`;
}
function emptySize(): SizeValue { return { w: '', d: '', h: '' }; }
function repDate(p: Piece) { return p.final.date || p.decoration.date || p.bisque.date || p.form.date || ''; }
function stageOf(p: Piece): StageKey {
  if (p.final.date) return 'final';
  if (p.decoration.date) return 'decoration';
  if (p.bisque.date) return 'bisque';
  return 'form';
}

function emptyPiece(name?: string): Piece {
  return {
    id: uid(),
    name: name || '無題',
    createdAt: todayISO(),
    form: { date: todayISO(), clay: '', size: emptySize(), innerSize: emptySize(), photos: [] },
    bisque: { date: '', size: emptySize(), innerSize: emptySize() },
    decoration: { date: '', techniques: [], glazes: [], method: '', photos: [] },
    final: { date: '', size: emptySize(), innerSize: emptySize(), kilnTemp: '', photos: [] },
    comment: '',
  };
}

function normalizePiece(raw: any): Piece {
  const base = emptyPiece(raw?.name);
  const p: any = { ...base, ...raw, id: raw?.id || base.id };

  p.form = { ...base.form, ...(raw?.form || {}) };
  p.form.size = { ...base.form.size, ...((raw?.form && typeof raw.form.size === 'object') ? raw.form.size : {}) };
  p.form.innerSize = { ...base.form.innerSize, ...((raw?.form && typeof raw.form.innerSize === 'object') ? raw.form.innerSize : {}) };
  p.form.photos = Array.isArray(raw?.form?.photos) ? raw.form.photos : (raw?.form?.photo ? [raw.form.photo] : []);

  p.bisque = { ...base.bisque, ...(raw?.bisque || {}) };
  p.bisque.size = { ...base.bisque.size, ...((raw?.bisque && typeof raw.bisque.size === 'object') ? raw.bisque.size : {}) };
  p.bisque.innerSize = { ...base.bisque.innerSize, ...((raw?.bisque && typeof raw.bisque.innerSize === 'object') ? raw.bisque.innerSize : {}) };
  delete p.bisque.glazes;
  delete p.bisque.method;

  p.decoration = { ...base.decoration, ...(raw?.decoration || {}) };
  p.decoration.techniques = Array.isArray(raw?.decoration?.techniques) ? raw.decoration.techniques : [];
  p.decoration.photos = Array.isArray(raw?.decoration?.photos) ? raw.decoration.photos : [];
  const rawDecoGlazes = Array.isArray(raw?.decoration?.glazes) ? raw.decoration.glazes : null;
  const rawBisqueGlazes = Array.isArray(raw?.bisque?.glazes) ? raw.bisque.glazes : null;
  p.decoration.glazes = (rawDecoGlazes && rawDecoGlazes.length) ? rawDecoGlazes : (rawBisqueGlazes || []);
  const rawDecoMethod = typeof raw?.decoration?.method === 'string' ? raw.decoration.method : '';
  const rawBisqueMethod = typeof raw?.bisque?.method === 'string' ? raw.bisque.method : '';
  p.decoration.method = rawDecoMethod || rawBisqueMethod || '';

  p.final = { ...base.final, ...(raw?.final || {}) };
  p.final.size = { ...base.final.size, ...((raw?.final && typeof raw.final.size === 'object') ? raw.final.size : {}) };
  p.final.innerSize = { ...base.final.innerSize, ...((raw?.final && typeof raw.final.innerSize === 'object') ? raw.final.innerSize : {}) };
  p.final.kilnTemp = typeof raw?.final?.kilnTemp === 'string' ? raw.final.kilnTemp : '';
  p.final.photos = Array.isArray(raw?.final?.photos) ? raw.final.photos : (raw?.final?.photo ? [raw.final.photo] : []);

  return p as Piece;
}

function emptyIdea(): Idea { return { id: uid(), createdAt: todayISO(), images: [], url: '', memo: '' }; }
function normalizeIdea(raw: any): Idea {
  const base = emptyIdea();
  return { ...base, ...raw, id: raw?.id || base.id, images: Array.isArray(raw?.images) ? raw.images : [] };
}

// Decodes the file with EXIF orientation explicitly applied by the browser's
// own decoder (imageOrientation: 'from-image'), so photos taken in portrait
// on iPhone/iPad come out right-side-up before we ever touch a canvas.
async function loadOrientedBitmap(file: File): Promise<ImageBitmap | null> {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions); }
    catch {
      try { return await createImageBitmap(file); } catch { /* fall through */ }
    }
  }
  return null;
}

function compressImage(file: File, maxDim = 900, quality = 0.75): Promise<string> {
  return new Promise((resolve, reject) => {
    (async () => {
      const bitmap = await loadOrientedBitmap(file);
      if (bitmap) {
        let w = bitmap.width, h = bitmap.height;
        if (w > h && w > maxDim) { h = Math.round(h * (maxDim / w)); w = maxDim; }
        else if (h >= w && h > maxDim) { w = Math.round(w * (maxDim / h)); h = maxDim; }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
        if ('close' in bitmap) bitmap.close();
        resolve(canvas.toDataURL('image/jpeg', quality));
        return;
      }
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          let w = img.width, h = img.height;
          if (w > h && w > maxDim) { h = Math.round(h * (maxDim / w)); w = maxDim; }
          else if (h >= w && h > maxDim) { w = Math.round(w * (maxDim / h)); h = maxDim; }
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = () => reject(new Error('image decode failed'));
        img.src = e.target?.result as string;
      };
      reader.onerror = () => reject(new Error('file read failed'));
      reader.readAsDataURL(file);
    })();
  });
}

// ---- shared style fragments -------------------------------------------

const inputStyle: CSSProperties = {
  width: '100%', boxSizing: 'border-box', background: THEME.surface,
  border: `1px solid ${THEME.border}`, borderRadius: 8, color: THEME.text,
  padding: '10px 12px', fontFamily: FONT_BODY, fontSize: 15, outline: 'none',
};
const dashedAddBtnStyle: CSSProperties = {
  width: '100%', background: 'transparent', border: `1px dashed ${THEME.borderLight}`,
  borderRadius: 8, color: THEME.textMuted, padding: '12px', fontFamily: FONT_BODY,
  fontSize: 14, cursor: 'pointer',
};
const neutralBtnStyle: CSSProperties = {
  background: 'none', border: `1px solid ${THEME.border}`, color: THEME.textMuted,
  borderRadius: 6, padding: '9px 16px', fontFamily: FONT_BODY, fontSize: 13, cursor: 'pointer',
};
const iconBtnStyle: CSSProperties = {
  background: 'rgba(243,238,223,0.12)', border: '1px solid rgba(243,238,223,0.45)', color: '#F3EEDF',
  borderRadius: '50%', width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center',
  cursor: 'pointer', padding: 0, flexShrink: 0,
};

// ---- icons -------------------------------------------------------------

function CropIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M6 2v14a2 2 0 0 0 2 2h14" />
      <path d="M18 22V8a2 2 0 0 0-2-2H2" />
    </svg>
  );
}
function DownloadIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v12" /><path d="M7 10l5 5 5-5" /><path d="M4 21h16" />
    </svg>
  );
}
function TrashIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" />
    </svg>
  );
}
function ChevronIcon({ open }: { open: boolean }) {
  return (
    <span style={{ display: 'inline-block', fontFamily: FONT_MONO, fontSize: 12, color: THEME.textFaint, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▶</span>
  );
}

// ---- small UI atoms -------------------------------------------------

function StampBadge({ piece, size = 34 }: { piece: Piece; size?: number }) {
  const dots = [
    { on: !!piece.form?.date, color: THEME.clay },
    { on: !!piece.bisque?.date, color: THEME.bisque },
    { on: !!piece.decoration?.date, color: THEME.decoration },
    { on: !!piece.final?.date, color: THEME.glaze },
  ];
  const r = size / 2;
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%', border: `1.5px solid ${THEME.borderLight}`,
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: Math.max(1.5, size * 0.045),
      flexShrink: 0, background: THEME.surface,
    }} title="工程の進み具合">
      {dots.map((d, i) => (
        <span key={i} style={{
          width: r * 0.26, height: r * 0.26, borderRadius: '50%',
          background: d.on ? d.color : 'transparent',
          border: `1px solid ${d.on ? d.color : THEME.textFaint}`,
        }} />
      ))}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block', marginBottom: 14 }}>
      <span style={{ display: 'block', fontFamily: FONT_MONO, fontSize: 11, letterSpacing: '0.06em', color: THEME.textMuted, marginBottom: 6, textTransform: 'uppercase' }}>{label}</span>
      {children}
    </label>
  );
}
function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} style={{ ...inputStyle, ...(props.style || {}) }} />;
}

function SizeFields({ label, value, onChange }: { label: string; value: SizeValue; onChange: (v: SizeValue) => void }) {
  const dims: { key: keyof SizeValue; label: string }[] = [{ key: 'w', label: '幅 W' }, { key: 'd', label: '奥行 D' }, { key: 'h', label: '高さ H' }];
  return (
    <div style={{ marginBottom: 14 }}>
      <span style={{ display: 'block', fontFamily: FONT_MONO, fontSize: 11, letterSpacing: '0.06em', color: THEME.textMuted, marginBottom: 6, textTransform: 'uppercase' }}>{label}</span>
      <div style={{ display: 'flex', gap: 8 }}>
        {dims.map((d) => (
          <div key={d.key} style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontFamily: FONT_MONO, fontSize: 10, color: THEME.textFaint, marginBottom: 4 }}>{d.label}</span>
            <TextInput value={value?.[d.key] || ''} onChange={(e) => onChange({ ...value, [d.key]: e.target.value })} placeholder="cm" style={{ padding: '9px 8px', fontSize: 14 }} />
          </div>
        ))}
      </div>
    </div>
  );
}

function MultiPhotoField({ photos, onChange, onView }: { photos: string[]; onChange: (p: string[]) => void; onView: (idx: number) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const handleFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    setBusy(true);
    try {
      const compressed = await Promise.all(files.map((f) => compressImage(f)));
      onChange([...(photos || []), ...compressed]);
    } catch (err) { console.error(err); } finally { setBusy(false); }
  };
  return (
    <div>
      {photos && photos.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 8 }}>
          {photos.map((p, i) => (
            <img key={i} src={p} alt="" onClick={() => onView(i)} style={{ width: '100%', height: 90, objectFit: 'cover', borderRadius: 8, border: `1px solid ${THEME.border}`, display: 'block', cursor: 'pointer' }} />
          ))}
        </div>
      )}
      <button type="button" onClick={() => inputRef.current?.click()} disabled={busy} style={dashedAddBtnStyle}>{busy ? '読み込み中…' : '写真を追加(複数選択可)'}</button>
      <input ref={inputRef} type="file" accept="image/*" multiple onChange={handleFiles} style={{ display: 'none' }} />
    </div>
  );
}

function IdeaPhotoField({ photos, onChange, onView }: { photos: string[]; onChange: (p: string[]) => void; onView: (idx: number) => void }) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const handleFiles = async (fileList: FileList | null) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setBusy(true);
    try {
      const compressed = await Promise.all(files.map((f) => compressImage(f)));
      onChange([...(photos || []), ...compressed]);
    } catch (err) { console.error(err); } finally { setBusy(false); }
  };
  return (
    <div>
      {photos && photos.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 8 }}>
          {photos.map((p, i) => (
            <img key={i} src={p} alt="" onClick={() => onView(i)} style={{ width: '100%', height: 90, objectFit: 'cover', borderRadius: 8, border: `1px solid ${THEME.border}`, display: 'block', cursor: 'pointer' }} />
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" onClick={() => cameraRef.current?.click()} disabled={busy} style={{ ...dashedAddBtnStyle, flex: 1 }}>📷 撮影</button>
        <button type="button" onClick={() => fileRef.current?.click()} disabled={busy} style={{ ...dashedAddBtnStyle, flex: 1 }}>🖼 選択</button>
      </div>
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" onChange={(e) => { handleFiles(e.target.files); e.target.value = ''; }} style={{ display: 'none' }} />
      <input ref={fileRef} type="file" accept="image/*" multiple onChange={(e) => { handleFiles(e.target.files); e.target.value = ''; }} style={{ display: 'none' }} />
    </div>
  );
}

function TechniquePicker({ selected, onChange, customTechniques, onAddCustom }: {
  selected: string[]; onChange: (t: string[]) => void; customTechniques: string[]; onAddCustom: (name: string) => void;
}) {
  const [addingCustom, setAddingCustom] = useState(false);
  const [customInput, setCustomInput] = useState('');
  const all = [...BASE_TECHNIQUES, ...customTechniques.filter((c) => !BASE_TECHNIQUES.includes(c))];
  const toggle = (t: string) => onChange(selected.includes(t) ? selected.filter((s) => s !== t) : [...selected, t]);
  const submitCustom = () => {
    const v = customInput.trim();
    setAddingCustom(false); setCustomInput('');
    if (!v) return;
    onAddCustom(v);
    if (!selected.includes(v)) onChange([...selected, v]);
  };
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {all.map((t) => {
          const on = selected.includes(t);
          return (
            <button type="button" key={t} onClick={() => toggle(t)} style={{
              padding: '7px 13px', borderRadius: 999, fontSize: 13, fontFamily: FONT_BODY, cursor: 'pointer',
              border: `1px solid ${on ? THEME.decoration : THEME.border}`,
              background: on ? THEME.decoration : 'transparent', color: on ? THEME.onAccent : THEME.text,
            }}>{t}</button>
          );
        })}
        <button type="button" onClick={() => setAddingCustom(true)} style={{ padding: '7px 13px', borderRadius: 999, fontSize: 13, fontFamily: FONT_BODY, cursor: 'pointer', border: `1px dashed ${THEME.borderLight}`, background: 'transparent', color: THEME.textMuted }}>＋カスタム</button>
      </div>
      {addingCustom && (
        <div style={{ display: 'flex', gap: 8 }}>
          <TextInput autoFocus value={customInput} onChange={(e) => setCustomInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submitCustom(); } if (e.key === 'Escape') setAddingCustom(false); }} placeholder="技法名を入力" />
          <button type="button" onClick={submitCustom} style={{ background: THEME.surfaceRaised, border: `1px solid ${THEME.border}`, color: THEME.text, borderRadius: 8, padding: '0 16px', fontFamily: FONT_BODY, cursor: 'pointer' }}>追加</button>
        </div>
      )}
    </div>
  );
}

function GlazeChips({ glazes, onChange }: { glazes: string[]; onChange: (g: string[]) => void }) {
  const [draftVal, setDraftVal] = useState('');
  const add = () => {
    const v = draftVal.trim();
    if (!v) return;
    onChange([...(glazes || []), v]);
    setDraftVal('');
  };
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: glazes?.length ? 8 : 0 }}>
        {(glazes || []).map((g, i) => (
          <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: THEME.surfaceRaised, border: `1px solid ${THEME.border}`, borderRadius: 999, padding: '5px 10px 5px 12px', fontSize: 13, fontFamily: FONT_BODY, color: THEME.text }}>
            {g}
            <span onClick={() => onChange(glazes.filter((_, idx) => idx !== i))} style={{ cursor: 'pointer', color: THEME.textMuted, fontFamily: FONT_MONO }}>×</span>
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <TextInput value={draftVal} onChange={(e) => setDraftVal(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} placeholder="釉薬名を入力して追加(例: 織部釉)" />
        <button type="button" onClick={add} style={{ background: THEME.surfaceRaised, border: `1px solid ${THEME.border}`, color: THEME.text, borderRadius: 8, padding: '0 16px', fontFamily: FONT_BODY, cursor: 'pointer' }}>追加</button>
      </div>
    </div>
  );
}

function StageSection({ number, title, accent, open, onToggle, children, last }: {
  number: string; title: string; accent: string; open: boolean; onToggle: () => void; children: React.ReactNode; last?: boolean;
}) {
  return (
    <div style={{ position: 'relative', paddingLeft: 34, marginBottom: open ? 30 : 16 }}>
      <div style={{ position: 'absolute', left: 0, top: 2, width: 24, height: 24, borderRadius: '50%', background: THEME.bg, border: `2px solid ${accent}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: FONT_MONO, fontSize: 11, color: accent, fontWeight: 600 }}>{number}</div>
      {!last && <div style={{ position: 'absolute', left: 11, top: 28, bottom: open ? -30 : -16, width: 1, background: THEME.border }} />}
      <button type="button" onClick={onToggle} style={{ display: 'flex', alignItems: 'center', width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', padding: '2px 0', textAlign: 'left', marginBottom: open ? 14 : 0 }}>
        <h3 style={{ fontFamily: FONT_DISPLAY, fontSize: 19, fontWeight: 500, color: THEME.text, margin: 0, letterSpacing: '0.02em', flex: 1 }}>{title}</h3>
        <ChevronIcon open={open} />
      </button>
      {open && children}
    </div>
  );
}

function GroupLabel({ title, count, accent }: { title: string; count: number; accent: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, borderBottom: `1px solid ${THEME.border}`, padding: '10px 2px', marginTop: 4 }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: accent, flexShrink: 0 }} />
      <span style={{ fontFamily: FONT_DISPLAY, fontSize: 16, color: THEME.text, flex: 1 }}>{title}</span>
      <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: THEME.textMuted }}>{count}件</span>
    </div>
  );
}

function PieceCard({ piece, onOpen }: { piece: Piece; onOpen: () => void }) {
  const thumb = piece.final.photos[0] || piece.decoration.photos[0] || piece.form.photos[0];
  const latestDate = repDate(piece);
  return (
    <div onClick={onOpen} style={{ display: 'flex', alignItems: 'center', gap: 12, background: THEME.surface, border: `1px solid ${THEME.border}`, borderRadius: 10, padding: 12, cursor: 'pointer' }}>
      <StampBadge piece={piece} />
      {thumb && <img src={thumb} alt="" style={{ width: 44, height: 44, borderRadius: 8, objectFit: 'cover', flexShrink: 0, border: `1px solid ${THEME.border}` }} />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: FONT_DISPLAY, fontSize: 18, fontWeight: 500, color: THEME.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{piece.name}</div>
        <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: THEME.textMuted, marginTop: 2 }}>{piece.form.clay || '土未記入'}{latestDate ? ` · ${fmtDate(latestDate)}` : ''}</div>
      </div>
    </div>
  );
}

// ---- photo lightbox + crop --------------------------------------------

function Cropper({ src, onCancel, onApply }: { src: string; onCancel: () => void; onApply: (dataUrl: string) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [rect, setRect] = useState({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
  const dragRef = useRef<{ mode: 'move' | 'resize'; startX: number; startY: number; rect: typeof rect; box: DOMRect } | null>(null);

  const start = (mode: 'move' | 'resize') => (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    const box = containerRef.current!.getBoundingClientRect();
    dragRef.current = { mode, startX: e.clientX, startY: e.clientY, rect: { ...rect }, box };
  };
  const move = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const { mode, startX, startY, rect: r0, box } = dragRef.current;
    const dx = (e.clientX - startX) / box.width;
    const dy = (e.clientY - startY) / box.height;
    if (mode === 'move') {
      const x = Math.min(Math.max(r0.x + dx, 0), 1 - r0.w);
      const y = Math.min(Math.max(r0.y + dy, 0), 1 - r0.h);
      setRect({ ...r0, x, y });
    } else {
      const w = Math.min(Math.max(r0.w + dx, 0.12), 1 - r0.x);
      const h = Math.min(Math.max(r0.h + dy, 0.12), 1 - r0.y);
      setRect({ ...r0, w, h });
    }
  };
  const end = () => { dragRef.current = null; };
  const apply = () => {
    const img = imgRef.current!;
    const nw = img.naturalWidth, nh = img.naturalHeight;
    const sx = rect.x * nw, sy = rect.y * nh, sw = rect.w * nw, sh = rect.h * nh;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sw));
    canvas.height = Math.max(1, Math.round(sh));
    canvas.getContext('2d')!.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    onApply(canvas.toDataURL('image/jpeg', 0.85));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, width: '100%' }}>
      <div ref={containerRef} onPointerMove={move} onPointerUp={end} onPointerLeave={end} style={{ position: 'relative', maxWidth: '100%', maxHeight: '58vh', touchAction: 'none', lineHeight: 0 }}>
        <img ref={imgRef} src={src} alt="" draggable={false} style={{ maxWidth: '100%', maxHeight: '58vh', display: 'block' }} />
        <div onPointerDown={start('move')} style={{ position: 'absolute', left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%`, border: '2px solid #F3EEDF', boxShadow: '0 0 0 1000px rgba(20,16,12,0.55)', cursor: 'move' }}>
          <div onPointerDown={start('resize')} style={{ position: 'absolute', right: -9, bottom: -9, width: 22, height: 22, borderRadius: '50%', background: '#F3EEDF', border: `2px solid ${THEME.decoration}`, cursor: 'nwse-resize' }} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <button type="button" onClick={onCancel} style={{ ...iconBtnStyle, borderRadius: 8, width: 'auto', padding: '9px 18px', color: '#F3EEDF' }}>キャンセル</button>
        <button type="button" onClick={apply} style={{ ...iconBtnStyle, borderRadius: 8, width: 'auto', padding: '9px 18px', background: THEME.decoration, borderColor: THEME.decoration, color: THEME.onAccent }}>切り抜きを適用</button>
      </div>
    </div>
  );
}

interface LightboxPhoto {
  src: string;
  onDelete?: () => void;
  onReplace: (newSrc: string) => void;
}

function Lightbox({ photo, onClose }: { photo: LightboxPhoto | null; onClose: () => void }) {
  const [mode, setMode] = useState<'view' | 'crop' | 'confirmDelete'>('view');
  useEffect(() => { setMode('view'); }, [photo]);
  if (!photo) return null;
  const handleDownload = () => {
    const a = document.createElement('a');
    a.href = photo.src; a.download = 'photo.jpg';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  };
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(20,16,12,0.94)', zIndex: 100, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: 14, flexWrap: 'wrap' }}>
        {mode === 'view' && (
          <>
            <button type="button" onClick={() => setMode('crop')} title="トリミング" style={iconBtnStyle}><CropIcon /></button>
            <button type="button" onClick={handleDownload} title="ダウンロード" style={iconBtnStyle}><DownloadIcon /></button>
            {photo.onDelete && <button type="button" onClick={() => setMode('confirmDelete')} title="削除" style={{ ...iconBtnStyle, color: '#F2B7A9', borderColor: THEME.danger }}><TrashIcon /></button>}
          </>
        )}
        <button type="button" onClick={onClose} title="閉じる" style={iconBtnStyle}>×</button>
      </div>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, minHeight: 0 }}>
        {mode === 'crop' ? (
          <Cropper src={photo.src} onCancel={() => setMode('view')} onApply={(newSrc) => { photo.onReplace(newSrc); setMode('view'); }} />
        ) : (
          <img src={photo.src} alt="" style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 10 }} />
        )}
      </div>
      {mode === 'confirmDelete' && (
        <div style={{ background: THEME.surface, margin: 16, borderRadius: 10, padding: 14, border: `1px solid ${THEME.danger}` }}>
          <div style={{ fontSize: 13, color: THEME.text, marginBottom: 10, fontFamily: FONT_BODY }}>この写真を削除します。よろしいですか?</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={() => { photo.onDelete?.(); onClose(); }} style={{ background: THEME.danger, border: 'none', color: THEME.onAccent, borderRadius: 6, padding: '9px 16px', fontFamily: FONT_BODY, fontSize: 13, cursor: 'pointer' }}>削除する</button>
            <button type="button" onClick={() => setMode('view')} style={neutralBtnStyle}>やめる</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- first-visit tip ---------------------------------------------------

function IntroTip({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div style={{ background: THEME.surfaceRaised, border: `1px solid ${THEME.border}`, borderRadius: 10, padding: 14, marginBottom: 18, fontSize: 13, lineHeight: 1.7, color: THEME.text }}>
      このアプリのデータは<b>この端末のこのブラウザの中だけ</b>に保存されます(どこにも送信されません)。
      他の端末に移したり、機種変更やブラウザのデータ削除に備えたりするには、下の「バックアップを書き出す」をときどき使ってください。
      <div style={{ marginTop: 10 }}>
        <button type="button" onClick={onDismiss} style={neutralBtnStyle}>わかりました</button>
      </div>
    </div>
  );
}

// ---- main app ---------------------------------------------------------

type PendingImport = { pieces: Piece[]; ideas: Idea[]; customTechniques: string[]; error?: boolean; futureSchema?: boolean } | null;

export default function App() {
  const [loading, setLoading] = useState(true);
  const [storageUnavailable, setStorageUnavailable] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'records' | 'ideas'>('records');
  const [showIntroTip, setShowIntroTip] = useState(false);

  const [pieces, setPieces] = useState<Piece[]>([]);
  const [customTechniques, setCustomTechniques] = useState<string[]>([]);
  const [view, setView] = useState<'list' | 'detail'>('list');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Piece | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [saveErrorMsg, setSaveErrorMsg] = useState<string>('');
  const [query, setQuery] = useState('');
  const [monthFilter, setMonthFilter] = useState('all');
  const [newName, setNewName] = useState('');
  const [showNewForm, setShowNewForm] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [openSections, setOpenSections] = useState<Record<StageKey, boolean>>({ form: true, bisque: true, decoration: true, final: true });
  const [lightbox, setLightbox] = useState<LightboxPhoto | null>(null);
  const [pendingImport, setPendingImport] = useState<PendingImport>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveRef = useRef<Piece | null>(null);
  const isSavingRef = useRef(false);
  const saveLoopPromiseRef = useRef<Promise<void> | null>(null);
  const skipNextSaveRef = useRef(false);

  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [ideaView, setIdeaView] = useState<'list' | 'detail'>('list');
  const [selectedIdeaId, setSelectedIdeaId] = useState<string | null>(null);
  const [ideaDraft, setIdeaDraft] = useState<Idea | null>(null);
  const [ideaSaveStatus, setIdeaSaveStatus] = useState<SaveStatus>('idle');
  const ideaSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingIdeaSaveRef = useRef<Idea | null>(null);
  const isIdeaSavingRef = useRef(false);
  const ideaSaveLoopPromiseRef = useRef<Promise<void> | null>(null);
  const skipNextIdeaSaveRef = useRef(false);
  const [showNewIdea, setShowNewIdea] = useState(false);
  const [newIdeaImages, setNewIdeaImages] = useState<string[]>([]);
  const [newIdeaUrl, setNewIdeaUrl] = useState('');
  const [newIdeaMemo, setNewIdeaMemo] = useState('');
  const [confirmIdeaDelete, setConfirmIdeaDelete] = useState(false);

  // Google Fonts is the one external network call this app makes (font files
  // only — no personal data is sent). If it fails (e.g. offline), the app
  // just falls back to the system font; nothing else breaks.
  useEffect(() => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Yomogi&family=Zen+Maru+Gothic:wght@400;500;700&family=JetBrains+Mono:wght@400;500&display=swap';
    document.head.appendChild(link);
    return () => { document.head.removeChild(link); };
  }, []);

  const loadAllByPrefix = async <T,>(prefix: string, normalize: (raw: any) => T): Promise<T[]> => {
    const keys = await storage.list(prefix).catch(() => [] as string[]);
    if (!keys.length) return [];
    const results = await Promise.allSettled(keys.map((k) => storage.get(k)));
    const items: T[] = [];
    results.forEach((r) => {
      if (r.status === 'fulfilled' && r.value) {
        try { items.push(normalize(JSON.parse(r.value))); } catch { /* skip corrupt entry */ }
      }
    });
    return items;
  };

  useEffect(() => {
    (async () => {
      try {
        let loadedPieces = await loadAllByPrefix('piece:', normalizePiece);
        if (loadedPieces.length === 0) {
          const old = await storage.get('pieces').catch(() => null);
          if (old) {
            const arr = (JSON.parse(old) || []).map(normalizePiece);
            if (arr.length) {
              await Promise.all(arr.map((p: Piece) => storage.set(`piece:${p.id}`, JSON.stringify(p))));
              await storage.delete('pieces').catch(() => {});
              loadedPieces = arr;
            }
          }
        }
        setPieces(loadedPieces);

        let loadedIdeas = await loadAllByPrefix('idea:', normalizeIdea);
        if (loadedIdeas.length === 0) {
          const old = await storage.get('ideas').catch(() => null);
          if (old) {
            const arr = (JSON.parse(old) || []).map(normalizeIdea);
            if (arr.length) {
              await Promise.all(arr.map((i: Idea) => storage.set(`idea:${i.id}`, JSON.stringify(i))));
              await storage.delete('ideas').catch(() => {});
              loadedIdeas = arr;
            }
          }
        }
        setIdeas(loadedIdeas);

        const techRaw = await storage.get('customTechniques').catch(() => null);
        if (techRaw) {
          const parsed = JSON.parse(techRaw);
          setCustomTechniques(Array.isArray(parsed) ? parsed : []);
        }

        const seenTip = await storage.get(FIRST_VISIT_KEY).catch(() => null);
        setShowIntroTip(!seenTip);
      } catch (err) {
        console.error(err);
        setStorageUnavailable(describeStorageError(err));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const dismissIntroTip = () => {
    setShowIntroTip(false);
    storage.set(FIRST_VISIT_KEY, '1').catch(() => {});
  };

  const savePieceToStorage = async (piece: Piece) => storage.set(`piece:${piece.id}`, JSON.stringify(piece));
  const deletePieceFromStorage = async (id: string) => storage.delete(`piece:${id}`);
  const saveIdeaToStorage = async (idea: Idea) => storage.set(`idea:${idea.id}`, JSON.stringify(idea));
  const deleteIdeaFromStorage = async (id: string) => storage.delete(`idea:${id}`);
  const persistCustomTechniques = useCallback(async (next: string[]) => {
    setCustomTechniques(next);
    await storage.set('customTechniques', JSON.stringify(next));
  }, []);
  const addCustomTechnique = (name: string) => {
    if (BASE_TECHNIQUES.includes(name) || customTechniques.includes(name)) return;
    persistCustomTechniques([...customTechniques, name]);
  };

  // ---- records: draft + debounced auto-save ----
  useEffect(() => {
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
    pendingSaveRef.current = null;
    if (selectedId) {
      const p = pieces.find((x) => x.id === selectedId);
      skipNextSaveRef.current = true;
      setDraft(p ? JSON.parse(JSON.stringify(p)) : null);
      setSaveStatus('idle');
      setOpenSections({ form: true, bisque: true, decoration: true, final: true });
    } else {
      setDraft(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const runSaveLoop = useCallback((): Promise<void> => {
    if (isSavingRef.current) return saveLoopPromiseRef.current || Promise.resolve();
    isSavingRef.current = true;
    setSaveStatus('saving');
    const p = (async () => {
      try {
        while (pendingSaveRef.current) {
          const toSave = pendingSaveRef.current;
          pendingSaveRef.current = null;
          let ok = false;
          try { ok = await savePieceToStorage(toSave); }
          catch (err) { setSaveErrorMsg(describeStorageError(err)); }
          setPieces((prev) => prev.map((p2) => (p2.id === toSave.id ? toSave : p2)));
          if (!ok) {
            if (!pendingSaveRef.current) pendingSaveRef.current = toSave;
            setSaveStatus('error');
            break;
          }
        }
        if (pendingSaveRef.current === null) setSaveStatus((s) => (s === 'error' ? s : 'saved'));
      } finally {
        isSavingRef.current = false;
        saveLoopPromiseRef.current = null;
      }
    })();
    saveLoopPromiseRef.current = p;
    return p;
  }, []);

  const scheduleSave = (nextPiece: Piece) => {
    pendingSaveRef.current = nextPiece;
    setSaveStatus('pending');
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => { saveTimerRef.current = null; runSaveLoop(); }, SAVE_DEBOUNCE_MS);
  };

  useEffect(() => {
    if (saveStatus === 'saved') {
      const t = setTimeout(() => setSaveStatus((s) => (s === 'saved' ? 'idle' : s)), 1600);
      return () => clearTimeout(t);
    }
  }, [saveStatus]);

  const updateDraft = (patch: Partial<Piece>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const updateDraftStage = <K extends StageKey>(stageKey: K, patch: Partial<Piece[K]>) =>
    setDraft((d) => (d ? { ...d, [stageKey]: { ...d[stageKey], ...patch } } : d));

  useEffect(() => {
    if (!draft) return;
    if (skipNextSaveRef.current) { skipNextSaveRef.current = false; return; }
    scheduleSave(draft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const goToList = () => { setView('list'); setSelectedId(null); setConfirmDelete(false); };
  const handleBack = async () => {
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
    if (draft) pendingSaveRef.current = draft;
    await runSaveLoop();
    goToList();
  };

  const addPiece = async () => {
    const name = newName.trim();
    if (!name) return;
    const piece = emptyPiece(name);
    setPieces([piece, ...pieces]);
    await savePieceToStorage(piece);
    setNewName(''); setShowNewForm(false); setSelectedId(piece.id); setView('detail');
  };
  const deletePiece = async () => {
    if (!draft) return;
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
    pendingSaveRef.current = null;
    setPieces(pieces.filter((p) => p.id !== draft.id));
    await deletePieceFromStorage(draft.id);
    setConfirmDelete(false);
    goToList();
  };

  const openPiecePhoto = (stageKey: StageKey, idx: number) => {
    if (!draft) return;
    setLightbox({
      src: (draft[stageKey] as any).photos[idx],
      onDelete: () => {
        setDraft((d) => {
          if (!d) return d;
          const stage: any = d[stageKey];
          return { ...d, [stageKey]: { ...stage, photos: stage.photos.filter((_: string, i: number) => i !== idx) } };
        });
      },
      onReplace: (newSrc: string) => {
        setDraft((d) => {
          if (!d) return d;
          const stage: any = d[stageKey];
          const photos = stage.photos.slice();
          photos[idx] = newSrc;
          return { ...d, [stageKey]: { ...stage, photos } };
        });
        setLightbox((l) => (l ? { ...l, src: newSrc } : l));
      },
    });
  };
  const toggleSection = (key: StageKey) => setOpenSections((s) => ({ ...s, [key]: !s[key] }));

  const monthOptions = Array.from(new Set(pieces.map((p) => repDate(p).slice(0, 7)).filter(Boolean))).sort().reverse();
  const filteredPieces = pieces
    .filter((p) => !query.trim() || p.name.toLowerCase().includes(query.trim().toLowerCase()))
    .filter((p) => monthFilter === 'all' || repDate(p).slice(0, 7) === monthFilter);
  const groups: Record<StageKey, Piece[]> = { form: [], bisque: [], decoration: [], final: [] };
  filteredPieces.forEach((p) => groups[stageOf(p)].push(p));
  (Object.keys(groups) as StageKey[]).forEach((k) => groups[k].sort((a, b) => repDate(b).localeCompare(repDate(a))));
  const GROUP_META: Record<StageKey, { title: string; accent: string }> = {
    form: { title: '成形', accent: THEME.clay },
    bisque: { title: '素焼き', accent: THEME.bisque },
    decoration: { title: '装飾', accent: THEME.decoration },
    final: { title: '本焼き', accent: THEME.glaze },
  };

  const exportData = () => {
    const payload: BackupPayload = { schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), pieces, ideas, customTechniques };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `陶芸記録_backup_${todayISO()}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (typeof data !== 'object' || data === null) throw new Error('invalid backup shape');
      setPendingImport({
        pieces: Array.isArray(data.pieces) ? data.pieces.map(normalizePiece) : [],
        ideas: Array.isArray(data.ideas) ? data.ideas.map(normalizeIdea) : [],
        customTechniques: Array.isArray(data.customTechniques) ? data.customTechniques : [],
        futureSchema: typeof data.schemaVersion === 'number' && data.schemaVersion > SCHEMA_VERSION,
      });
    } catch (err) { console.error(err); setPendingImport({ pieces: [], ideas: [], customTechniques: [], error: true }); }
  };
  const confirmImport = async () => {
    if (!pendingImport || pendingImport.error) { setPendingImport(null); return; }
    const oldPieceIds = pieces.map((p) => p.id);
    const newPieceIds = pendingImport.pieces.map((p) => p.id);
    await Promise.all(oldPieceIds.filter((id) => !newPieceIds.includes(id)).map(deletePieceFromStorage));
    await Promise.all(pendingImport.pieces.map(savePieceToStorage));
    setPieces(pendingImport.pieces);

    const oldIdeaIds = ideas.map((i) => i.id);
    const newIdeaIds = pendingImport.ideas.map((i) => i.id);
    await Promise.all(oldIdeaIds.filter((id) => !newIdeaIds.includes(id)).map(deleteIdeaFromStorage));
    await Promise.all(pendingImport.ideas.map(saveIdeaToStorage));
    setIdeas(pendingImport.ideas);

    await persistCustomTechniques(pendingImport.customTechniques);
    setPendingImport(null);
  };

  // ---- ideas: draft + debounced auto-save (same pattern as records above) ----
  useEffect(() => {
    if (ideaSaveTimerRef.current) { clearTimeout(ideaSaveTimerRef.current); ideaSaveTimerRef.current = null; }
    pendingIdeaSaveRef.current = null;
    if (selectedIdeaId) {
      const i = ideas.find((x) => x.id === selectedIdeaId);
      skipNextIdeaSaveRef.current = true;
      setIdeaDraft(i ? JSON.parse(JSON.stringify(i)) : null);
      setIdeaSaveStatus('idle');
    } else {
      setIdeaDraft(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIdeaId]);

  const runIdeaSaveLoop = useCallback((): Promise<void> => {
    if (isIdeaSavingRef.current) return ideaSaveLoopPromiseRef.current || Promise.resolve();
    isIdeaSavingRef.current = true;
    setIdeaSaveStatus('saving');
    const p = (async () => {
      try {
        while (pendingIdeaSaveRef.current) {
          const toSave = pendingIdeaSaveRef.current;
          pendingIdeaSaveRef.current = null;
          let ok = false;
          try { ok = await saveIdeaToStorage(toSave); }
          catch (err) { setSaveErrorMsg(describeStorageError(err)); }
          setIdeas((prev) => prev.map((i2) => (i2.id === toSave.id ? toSave : i2)));
          if (!ok) {
            if (!pendingIdeaSaveRef.current) pendingIdeaSaveRef.current = toSave;
            setIdeaSaveStatus('error');
            break;
          }
        }
        if (pendingIdeaSaveRef.current === null) setIdeaSaveStatus((s) => (s === 'error' ? s : 'saved'));
      } finally {
        isIdeaSavingRef.current = false;
        ideaSaveLoopPromiseRef.current = null;
      }
    })();
    ideaSaveLoopPromiseRef.current = p;
    return p;
  }, []);

  const scheduleIdeaSave = (nextIdea: Idea) => {
    pendingIdeaSaveRef.current = nextIdea;
    setIdeaSaveStatus('pending');
    if (ideaSaveTimerRef.current) clearTimeout(ideaSaveTimerRef.current);
    ideaSaveTimerRef.current = setTimeout(() => { ideaSaveTimerRef.current = null; runIdeaSaveLoop(); }, SAVE_DEBOUNCE_MS);
  };
  useEffect(() => {
    if (ideaSaveStatus === 'saved') {
      const t = setTimeout(() => setIdeaSaveStatus((s) => (s === 'saved' ? 'idle' : s)), 1600);
      return () => clearTimeout(t);
    }
  }, [ideaSaveStatus]);

  const updateIdeaDraft = (patch: Partial<Idea>) => setIdeaDraft((d) => (d ? { ...d, ...patch } : d));

  useEffect(() => {
    if (!ideaDraft) return;
    if (skipNextIdeaSaveRef.current) { skipNextIdeaSaveRef.current = false; return; }
    scheduleIdeaSave(ideaDraft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ideaDraft]);

  const handleIdeaBack = async () => {
    if (ideaSaveTimerRef.current) { clearTimeout(ideaSaveTimerRef.current); ideaSaveTimerRef.current = null; }
    if (ideaDraft) pendingIdeaSaveRef.current = ideaDraft;
    await runIdeaSaveLoop();
    setIdeaView('list'); setSelectedIdeaId(null); setConfirmIdeaDelete(false);
  };
  const addIdea = async () => {
    if (!newIdeaImages.length && !newIdeaUrl.trim() && !newIdeaMemo.trim()) return;
    const idea = { ...emptyIdea(), images: newIdeaImages, url: newIdeaUrl.trim(), memo: newIdeaMemo.trim() };
    setIdeas([idea, ...ideas]);
    await saveIdeaToStorage(idea);
    setNewIdeaImages([]); setNewIdeaUrl(''); setNewIdeaMemo(''); setShowNewIdea(false);
  };
  const deleteIdea = async () => {
    if (!ideaDraft) return;
    if (ideaSaveTimerRef.current) { clearTimeout(ideaSaveTimerRef.current); ideaSaveTimerRef.current = null; }
    pendingIdeaSaveRef.current = null;
    setIdeas(ideas.filter((i) => i.id !== ideaDraft.id));
    await deleteIdeaFromStorage(ideaDraft.id);
    setConfirmIdeaDelete(false); setSelectedIdeaId(null); setIdeaView('list');
  };
  const openIdeaPhoto = (idx: number) => {
    if (!ideaDraft) return;
    setLightbox({
      src: ideaDraft.images[idx],
      onDelete: () => {
        setIdeaDraft((d) => (d ? { ...d, images: d.images.filter((_, i) => i !== idx) } : d));
      },
      onReplace: (newSrc: string) => {
        setIdeaDraft((d) => {
          if (!d) return d;
          const images = d.images.slice();
          images[idx] = newSrc;
          return { ...d, images };
        });
        setLightbox((l) => (l ? { ...l, src: newSrc } : l));
      },
    });
  };

  const saveStatusLabel = (status: SaveStatus) =>
    (status === 'saving' || status === 'pending') ? '保存中…' : status === 'saved' ? '保存しました' : status === 'error' ? '保存できませんでした' : '';

  // ---- layout shell ----
  const pageStyle: CSSProperties = {
    minHeight: '100vh',
    background: `radial-gradient(ellipse 60% 40% at 15% 8%, rgba(178,156,112,0.22), transparent 60%), radial-gradient(ellipse 50% 35% at 88% 22%, rgba(148,122,86,0.18), transparent 55%), radial-gradient(ellipse 55% 45% at 25% 90%, rgba(168,146,104,0.16), transparent 60%), radial-gradient(ellipse 45% 35% at 92% 92%, rgba(138,116,80,0.14), transparent 55%), ${THEME.bg}`,
    color: THEME.text, fontFamily: FONT_BODY, WebkitFontSmoothing: 'antialiased',
  };
  const showTabs = (activeTab === 'records' && view === 'list') || (activeTab === 'ideas' && ideaView === 'list');
  const stickyBarStyle: CSSProperties = { position: 'sticky', top: 0, zIndex: 10, background: 'rgba(231,223,203,0.94)', backdropFilter: 'blur(6px)', paddingTop: 18, paddingBottom: 12, borderBottom: `1px solid ${THEME.border}` };

  let body: React.ReactNode = null;

  if (storageUnavailable) {
    body = (
      <div style={{ maxWidth: 480, margin: '0 auto', padding: '40px 18px' }}>
        <div style={{ background: THEME.dangerBg, border: `1px solid ${THEME.danger}`, borderRadius: 10, padding: 18, fontSize: 14, lineHeight: 1.8 }}>
          {storageUnavailable}
        </div>
      </div>
    );
  } else if (loading) {
    body = <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}><span style={{ color: THEME.textMuted, fontFamily: FONT_MONO, fontSize: 13 }}>読み込み中…</span></div>;
  } else if (activeTab === 'records' && view === 'detail' && draft) {
    body = (
      <div style={{ maxWidth: 480, margin: '0 auto' }}>
        <div style={{ ...stickyBarStyle, padding: '18px 18px 12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <button type="button" onClick={handleBack} style={{ background: 'none', border: 'none', color: THEME.textMuted, fontFamily: FONT_MONO, fontSize: 13, cursor: 'pointer', padding: 0 }}>← 一覧へ</button>
            <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: saveStatus === 'error' ? THEME.danger : THEME.textFaint }}>{saveStatusLabel(saveStatus)}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <StampBadge piece={draft} size={38} />
            <input value={draft.name} onChange={(e) => updateDraft({ name: e.target.value })} placeholder="作品名"
              style={{ flex: 1, background: 'transparent', border: 'none', borderBottom: `1px dashed ${THEME.border}`, color: THEME.text, fontFamily: FONT_DISPLAY, fontSize: 24, fontWeight: 500, outline: 'none', padding: '2px 0' }} />
          </div>
        </div>

        <div style={{ padding: '20px 18px 24px' }}>
          <div style={{ color: THEME.textFaint, fontFamily: FONT_MONO, fontSize: 11, marginBottom: 28 }}>記録開始 {fmtDate(draft.createdAt)}</div>

          <StageSection number="01" title="成形" accent={THEME.clay} open={openSections.form} onToggle={() => toggleSection('form')}>
            <Field label="日付"><TextInput type="date" value={draft.form.date || ''} onChange={(e) => updateDraftStage('form', { date: e.target.value })} /></Field>
            <Field label="土の名前"><TextInput value={draft.form.clay} onChange={(e) => updateDraftStage('form', { clay: e.target.value })} placeholder="例: 信楽土" /></Field>
            <SizeFields label="外寸" value={draft.form.size} onChange={(size) => updateDraftStage('form', { size })} />
            <SizeFields label="内寸" value={draft.form.innerSize} onChange={(innerSize) => updateDraftStage('form', { innerSize })} />
            <Field label="写真"><MultiPhotoField photos={draft.form.photos} onChange={(photos) => updateDraftStage('form', { photos })} onView={(idx) => openPiecePhoto('form', idx)} /></Field>
          </StageSection>

          <StageSection number="02" title="素焼き" accent={THEME.bisque} open={openSections.bisque} onToggle={() => toggleSection('bisque')}>
            <Field label="日付"><TextInput type="date" value={draft.bisque.date || ''} onChange={(e) => updateDraftStage('bisque', { date: e.target.value })} /></Field>
            <SizeFields label="外寸" value={draft.bisque.size} onChange={(size) => updateDraftStage('bisque', { size })} />
            <SizeFields label="内寸" value={draft.bisque.innerSize} onChange={(innerSize) => updateDraftStage('bisque', { innerSize })} />
          </StageSection>

          <StageSection number="03" title="装飾" accent={THEME.decoration} open={openSections.decoration} onToggle={() => toggleSection('decoration')}>
            <Field label="日付"><TextInput type="date" value={draft.decoration.date || ''} onChange={(e) => updateDraftStage('decoration', { date: e.target.value })} /></Field>
            <Field label="技法"><TechniquePicker selected={draft.decoration.techniques} onChange={(techniques) => updateDraftStage('decoration', { techniques })} customTechniques={customTechniques} onAddCustom={addCustomTechnique} /></Field>
            <Field label="釉薬名(複数可)"><GlazeChips glazes={draft.decoration.glazes} onChange={(glazes) => updateDraftStage('decoration', { glazes })} /></Field>
            <Field label="掛け方メモ"><TextInput value={draft.decoration.method} onChange={(e) => updateDraftStage('decoration', { method: e.target.value })} placeholder="例: 浸し掛け、口部は流し掛け" /></Field>
            <Field label="写真"><MultiPhotoField photos={draft.decoration.photos} onChange={(photos) => updateDraftStage('decoration', { photos })} onView={(idx) => openPiecePhoto('decoration', idx)} /></Field>
          </StageSection>

          <StageSection number="04" title="本焼き" accent={THEME.glaze} last open={openSections.final} onToggle={() => toggleSection('final')}>
            <Field label="日付"><TextInput type="date" value={draft.final.date || ''} onChange={(e) => updateDraftStage('final', { date: e.target.value })} /></Field>
            <Field label="窯温度(℃)"><TextInput value={draft.final.kilnTemp} onChange={(e) => updateDraftStage('final', { kilnTemp: e.target.value })} placeholder="例: 1230" /></Field>
            <SizeFields label="外寸" value={draft.final.size} onChange={(size) => updateDraftStage('final', { size })} />
            <SizeFields label="内寸" value={draft.final.innerSize} onChange={(innerSize) => updateDraftStage('final', { innerSize })} />
            <Field label="写真"><MultiPhotoField photos={draft.final.photos} onChange={(photos) => updateDraftStage('final', { photos })} onView={(idx) => openPiecePhoto('final', idx)} /></Field>
          </StageSection>

          <div style={{ marginTop: 8, marginBottom: 20 }}>
            <div style={{ fontFamily: FONT_MONO, fontSize: 11, letterSpacing: '0.06em', color: THEME.textMuted, textTransform: 'uppercase', marginBottom: 8 }}>メモ</div>
            <textarea value={draft.comment} onChange={(e) => updateDraft({ comment: e.target.value })} placeholder="仕上がりの感想、次回への改善点など(文字数制限なし)" rows={6} style={{ ...inputStyle, resize: 'vertical', fontFamily: FONT_BODY, lineHeight: 1.6 }} />
          </div>

          {saveStatus === 'error' && (
            <div style={{ fontSize: 12, color: THEME.danger, fontFamily: FONT_BODY, marginBottom: 12, lineHeight: 1.6 }}>{saveErrorMsg || '保存できませんでした。もう一度お試しください。'}</div>
          )}

          <div style={{ borderTop: `1px solid ${THEME.border}`, paddingTop: 20 }}>
            {!confirmDelete ? (
              <button type="button" onClick={() => setConfirmDelete(true)} style={neutralBtnStyle}>この作品を削除</button>
            ) : (
              <div style={{ background: THEME.dangerBg, border: `1px solid ${THEME.danger}`, borderRadius: 8, padding: 14 }}>
                <div style={{ fontSize: 13, marginBottom: 10 }}>「{draft.name}」を削除します。元に戻せません。</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={deletePiece} style={{ background: THEME.danger, border: 'none', color: THEME.onAccent, borderRadius: 6, padding: '9px 16px', fontFamily: FONT_BODY, fontSize: 13, cursor: 'pointer' }}>削除する</button>
                  <button type="button" onClick={() => setConfirmDelete(false)} style={neutralBtnStyle}>やめる</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  } else if (activeTab === 'records') {
    body = (
      <div style={{ maxWidth: 480, margin: '0 auto', padding: '8px 18px 60px' }}>
        {showIntroTip && <IntroTip onDismiss={dismissIntroTip} />}
        {pieces.length > 0 && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <TextInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="作品名で検索" style={{ flex: 1 }} />
            <select value={monthFilter} onChange={(e) => setMonthFilter(e.target.value)} style={{ ...inputStyle, width: 128, flexShrink: 0 }}>
              <option value="all">すべての年月</option>
              {monthOptions.map((m) => { const [y, mo] = m.split('-'); return <option key={m} value={m}>{y}年{parseInt(mo, 10)}月</option>; })}
            </select>
          </div>
        )}
        {showNewForm ? (
          <div style={{ background: THEME.surface, border: `1px solid ${THEME.border}`, borderRadius: 10, padding: 14, marginBottom: 18 }}>
            <TextInput autoFocus value={newName} onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addPiece(); if (e.key === 'Escape') setShowNewForm(false); }} placeholder="作品名(例: 灰釉六寸皿)" style={{ marginBottom: 10 }} />
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" onClick={addPiece} style={{ background: THEME.glaze, border: 'none', color: THEME.onAccent, borderRadius: 8, padding: '9px 18px', fontFamily: FONT_BODY, fontSize: 14, cursor: 'pointer' }}>記録を始める</button>
              <button type="button" onClick={() => { setShowNewForm(false); setNewName(''); }} style={neutralBtnStyle}>キャンセル</button>
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => setShowNewForm(true)} style={{ ...dashedAddBtnStyle, padding: '14px', fontSize: 15, marginBottom: 22, color: THEME.text }}>＋ 新しい作品を記録する</button>
        )}

        {filteredPieces.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '48px 20px', color: THEME.textFaint }}>
            <div style={{ fontFamily: FONT_DISPLAY, fontSize: 17, marginBottom: 6 }}>{pieces.length === 0 ? 'まだ作品が記録されていません' : '見つかりませんでした'}</div>
            {pieces.length === 0 && <div style={{ fontSize: 13, fontFamily: FONT_BODY }}>最初の一片を、ここに記録しましょう。</div>}
          </div>
        ) : (
          <>
            <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: THEME.textFaint, letterSpacing: '0.08em' }}>制作中</div>
            {(['form', 'bisque', 'decoration'] as StageKey[]).map((key) => groups[key].length > 0 && (
              <div key={key}>
                <GroupLabel title={GROUP_META[key].title} count={groups[key].length} accent={GROUP_META[key].accent} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 0' }}>{groups[key].map((p) => <PieceCard key={p.id} piece={p} onOpen={() => { setSelectedId(p.id); setView('detail'); }} />)}</div>
              </div>
            ))}
            <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: THEME.textFaint, letterSpacing: '0.08em', marginTop: 20 }}>完成</div>
            <GroupLabel title={GROUP_META.final.title} count={groups.final.length} accent={GROUP_META.final.accent} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 0' }}>{groups.final.map((p) => <PieceCard key={p.id} piece={p} onOpen={() => { setSelectedId(p.id); setView('detail'); }} />)}</div>
          </>
        )}

        <div style={{ marginTop: 34, paddingTop: 16, borderTop: `1px solid ${THEME.border}` }}>
          <div style={{ fontFamily: FONT_DISPLAY, fontSize: 16, marginBottom: 10 }}>バックアップ</div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <button type="button" onClick={exportData} style={{ ...neutralBtnStyle, flex: 1, textAlign: 'center' }}>バックアップを書き出す</button>
            <button type="button" onClick={() => importInputRef.current?.click()} style={{ ...neutralBtnStyle, flex: 1, textAlign: 'center' }}>復元する</button>
            <input ref={importInputRef} type="file" accept="application/json" onChange={handleImportFile} style={{ display: 'none' }} />
          </div>
          {pendingImport && (
            <div style={{ background: THEME.dangerBg, border: `1px solid ${THEME.danger}`, borderRadius: 8, padding: 14, marginBottom: 12 }}>
              {pendingImport.error ? (
                <>
                  <div style={{ fontSize: 13, marginBottom: 10 }}>このファイルは読み込めませんでした。破損しているか、このアプリのバックアップ形式ではない可能性があります。</div>
                  <button type="button" onClick={() => setPendingImport(null)} style={neutralBtnStyle}>閉じる</button>
                </>
              ) : (
                <>
                  {pendingImport.futureSchema && (
                    <div style={{ fontSize: 12, marginBottom: 8, color: THEME.danger }}>このバックアップは今より新しいバージョンのアプリで作られた可能性があります。一部の項目が読み込めないことがあります。</div>
                  )}
                  <div style={{ fontSize: 13, marginBottom: 10 }}>
                    復元すると現在のデータ(作品{pieces.length}件、アイディア{ideas.length}件)をバックアップの内容(作品{pendingImport.pieces.length}件、アイディア{pendingImport.ideas.length}件)で置き換えます。よろしいですか?
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button type="button" onClick={confirmImport} style={{ background: THEME.danger, border: 'none', color: THEME.onAccent, borderRadius: 6, padding: '9px 16px', fontFamily: FONT_BODY, fontSize: 13, cursor: 'pointer' }}>復元を実行</button>
                    <button type="button" onClick={() => setPendingImport(null)} style={neutralBtnStyle}>キャンセル</button>
                  </div>
                </>
              )}
            </div>
          )}
          <div style={{ fontSize: 11, fontFamily: FONT_MONO, color: THEME.textFaint, lineHeight: 1.7 }}>
            データはこの端末のブラウザ内だけに保存されます。ブラウザのデータを消去したり、別の端末・別のブラウザで開いたりすると記録は見えなくなるため、バックアップを他の場所にも保管しておくことをおすすめします。
          </div>
        </div>
      </div>
    );
  } else if (activeTab === 'ideas' && ideaView === 'detail' && ideaDraft) {
    body = (
      <div style={{ maxWidth: 480, margin: '0 auto' }}>
        <div style={{ ...stickyBarStyle, padding: '18px 18px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <button type="button" onClick={handleIdeaBack} style={{ background: 'none', border: 'none', color: THEME.textMuted, fontFamily: FONT_MONO, fontSize: 13, cursor: 'pointer', padding: 0 }}>← 一覧へ</button>
          <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: ideaSaveStatus === 'error' ? THEME.danger : THEME.textFaint }}>{saveStatusLabel(ideaSaveStatus)}</span>
        </div>
        <div style={{ padding: '20px 18px 24px' }}>
          <div style={{ color: THEME.textFaint, fontFamily: FONT_MONO, fontSize: 11, marginBottom: 20 }}>記録日 {fmtDate(ideaDraft.createdAt)}</div>
          <Field label="画像"><IdeaPhotoField photos={ideaDraft.images} onChange={(images) => updateIdeaDraft({ images })} onView={openIdeaPhoto} /></Field>
          <Field label="URL"><TextInput value={ideaDraft.url} onChange={(e) => updateIdeaDraft({ url: e.target.value })} placeholder="https://" /></Field>
          <Field label="メモ"><textarea value={ideaDraft.memo} onChange={(e) => updateIdeaDraft({ memo: e.target.value })} rows={6} placeholder="アイディアのメモ" style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.6 }} /></Field>

          <div style={{ borderTop: `1px solid ${THEME.border}`, paddingTop: 20, marginTop: 12 }}>
            {!confirmIdeaDelete ? (
              <button type="button" onClick={() => setConfirmIdeaDelete(true)} style={neutralBtnStyle}>このアイディアを削除</button>
            ) : (
              <div style={{ background: THEME.dangerBg, border: `1px solid ${THEME.danger}`, borderRadius: 8, padding: 14 }}>
                <div style={{ fontSize: 13, marginBottom: 10 }}>削除します。元に戻せません。</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={deleteIdea} style={{ background: THEME.danger, border: 'none', color: THEME.onAccent, borderRadius: 6, padding: '9px 16px', fontFamily: FONT_BODY, fontSize: 13, cursor: 'pointer' }}>削除する</button>
                  <button type="button" onClick={() => setConfirmIdeaDelete(false)} style={neutralBtnStyle}>やめる</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  } else if (activeTab === 'ideas') {
    body = (
      <div style={{ maxWidth: 480, margin: '0 auto', padding: '8px 18px 60px' }}>
        {showNewIdea ? (
          <div style={{ background: THEME.surface, border: `1px solid ${THEME.border}`, borderRadius: 10, padding: 14, marginBottom: 18 }}>
            <Field label="画像"><IdeaPhotoField photos={newIdeaImages} onChange={setNewIdeaImages} onView={(idx) => setLightbox({ src: newIdeaImages[idx], onDelete: () => setNewIdeaImages(newIdeaImages.filter((_, i) => i !== idx)), onReplace: (s) => setNewIdeaImages(newIdeaImages.map((p, i) => (i === idx ? s : p))) })} /></Field>
            <Field label="URL"><TextInput value={newIdeaUrl} onChange={(e) => setNewIdeaUrl(e.target.value)} placeholder="https://" /></Field>
            <Field label="メモ"><textarea value={newIdeaMemo} onChange={(e) => setNewIdeaMemo(e.target.value)} rows={4} placeholder="アイディアのメモ" style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.6 }} /></Field>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" onClick={addIdea} style={{ background: THEME.decoration, border: 'none', color: THEME.onAccent, borderRadius: 8, padding: '9px 18px', fontFamily: FONT_BODY, fontSize: 14, cursor: 'pointer' }}>追加</button>
              <button type="button" onClick={() => { setShowNewIdea(false); setNewIdeaImages([]); setNewIdeaUrl(''); setNewIdeaMemo(''); }} style={neutralBtnStyle}>キャンセル</button>
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => setShowNewIdea(true)} style={{ ...dashedAddBtnStyle, padding: '14px', fontSize: 15, marginBottom: 22, color: THEME.text }}>＋ アイディアを追加</button>
        )}
        {ideas.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '48px 20px', color: THEME.textFaint }}>
            <div style={{ fontFamily: FONT_DISPLAY, fontSize: 17, marginBottom: 6 }}>まだアイディアがありません</div>
            <div style={{ fontSize: 13, fontFamily: FONT_BODY }}>気になった作品や技法を、ここに残しておきましょう。</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {ideas.map((idea) => (
              <div key={idea.id} onClick={() => { setSelectedIdeaId(idea.id); setIdeaView('detail'); }} style={{ display: 'flex', alignItems: 'center', gap: 12, background: THEME.surface, border: `1px solid ${THEME.border}`, borderRadius: 10, padding: 12, cursor: 'pointer' }}>
                {idea.images[0] ? (
                  <img src={idea.images[0]} alt="" style={{ width: 48, height: 48, borderRadius: 8, objectFit: 'cover', flexShrink: 0, border: `1px solid ${THEME.border}` }} />
                ) : (
                  <div style={{ width: 48, height: 48, borderRadius: 8, flexShrink: 0, background: THEME.surfaceRaised, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, color: THEME.textFaint }}>{idea.url ? '🔗' : '✎'}</div>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: FONT_BODY, fontSize: 14, color: THEME.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{idea.memo ? idea.memo.slice(0, 40) : (idea.url || '(メモなし)')}</div>
                  <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: THEME.textMuted, marginTop: 2 }}>{fmtDate(idea.createdAt)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={pageStyle}>
      {showTabs && (
        <div style={{ maxWidth: 480, margin: '0 auto', padding: '28px 18px 0' }}>
          <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: THEME.textFaint, letterSpacing: '0.12em', marginBottom: 4 }}>TOUGEI · KIROKU</div>
          <h1 style={{ fontFamily: FONT_DISPLAY, fontSize: 32, fontWeight: 500, margin: '0 0 18px 0', letterSpacing: '0.02em' }}>陶芸記録</h1>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8, background: THEME.surfaceRaised, borderRadius: 10, padding: 4 }}>
            {(['records', 'ideas'] as const).map((key) => (
              <button type="button" key={key} onClick={() => setActiveTab(key)} style={{ flex: 1, padding: '9px 0', borderRadius: 8, border: 'none', cursor: 'pointer', fontFamily: FONT_BODY, fontSize: 14, fontWeight: activeTab === key ? 700 : 400, background: activeTab === key ? THEME.surface : 'transparent', color: activeTab === key ? THEME.text : THEME.textMuted }}>{key === 'records' ? '制作記録' : 'アイディア'}</button>
            ))}
          </div>
        </div>
      )}
      {body}
      <Lightbox photo={lightbox} onClose={() => setLightbox(null)} />
    </div>
  );
}
