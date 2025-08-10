import React, { useEffect, useMemo, useRef, useState } from "react";

// PixelArt Fixer - single file React app
// - Upload any image that is a scaled pixel-art
// - Detects pixel scale and grid offset along X and Y
// - Reconstructs the original low-res sprite by averaging blocks
// - Shows before-after with a reveal slider
// - Lets you tweak scale and offset, posterize, and export
// Styling: TailwindCSS utility classes. No external UI libs required.

// Helper types
interface DetectResult {
  sX: number;
  sY: number;
  dX: number;
  dY: number;
  ratioX: number;
  ratioY: number;
}

interface BuildResult {
  baseImageData: ImageData; // the reconstructed low-res sprite
  crop: { x0: number; y0: number; wCrop: number; hCrop: number; wOut: number; hOut: number };
}

// Compute per-column and per-row differences to detect block boundaries
function computeDiffs(imgData: ImageData) {
  const { width: w, height: h, data } = imgData;
  const diffX = new Float64Array(w - 1); // sum of abs RGB diffs between x and x+1 across all rows
  const diffY = new Float64Array(h - 1); // sum of abs RGB diffs between y and y+1 across all cols

  // X diffs
  for (let y = 0; y < h; y++) {
    let rowIdx = y * w * 4;
    for (let x = 0; x < w - 1; x++) {
      const i = rowIdx + x * 4;
      const j = i + 4;
      const dr = Math.abs(data[i] - data[j]);
      const dg = Math.abs(data[i + 1] - data[j + 1]);
      const db = Math.abs(data[i + 2] - data[j + 2]);
      diffX[x] += dr + dg + db;
    }
  }

  // Y diffs
  for (let y = 0; y < h - 1; y++) {
    let rowIdx = y * w * 4;
    let nextRowIdx = (y + 1) * w * 4;
    for (let x = 0; x < w; x++) {
      const i = rowIdx + x * 4;
      const j = nextRowIdx + x * 4;
      const dr = Math.abs(data[i] - data[j]);
      const dg = Math.abs(data[i + 1] - data[j + 1]);
      const db = Math.abs(data[i + 2] - data[j + 2]);
      diffY[y] += dr + dg + db;
    }
  }

  // Normalize by number of rows or cols for scale invariance
  for (let x = 0; x < diffX.length; x++) diffX[x] /= h;
  for (let y = 0; y < diffY.length; y++) diffY[y] /= w;

  return { diffX, diffY };
}

// Evaluate a given scale s and offset d on a 1D difference signal
// We want non-boundary differences low and boundary differences high.
// Score is ratio = nonBoundaryMean / (boundaryMean + eps). Lower is better.
function evaluateScaleOffset1D(diff: Float64Array, s: number, d: number) {
  const n = diff.length;
  let nonSum = 0, nonCount = 0;
  let bSum = 0, bCount = 0;
  const boundaryVal = s - 1; // boundary between i and i+1 when (i - d) % s == s-1
  for (let i = 0; i < n; i++) {
    if (((i - d) % s + s) % s === boundaryVal) {
      bSum += diff[i];
      bCount++;
    } else {
      nonSum += diff[i];
      nonCount++;
    }
  }
  const nonMean = nonCount ? nonSum / nonCount : Number.POSITIVE_INFINITY;
  const bMean = bCount ? bSum / bCount : 1e-6;
  const ratio = nonMean / (bMean + 1e-6);
  return { ratio, nonMean, bMean };
}

// Search best scale and offset for a given 1D diff signal
function detectAxis(diff: Float64Array, maxS: number) {
  // We skip s=1 since that means no scaling. Typical pixel-art scale is 2..64.
  let best = { s: 1, d: 0, ratio: Number.POSITIVE_INFINITY, non: 0, bound: 0 };
  for (let s = 2; s <= maxS; s++) {
    for (let d = 0; d < s; d++) {
      const { ratio, nonMean, bMean } = evaluateScaleOffset1D(diff, s, d);
      // Strong boundary contrast helps confidence. Prefer lower ratio and higher bMean.
      // We combine using a tiebreaker weight.
      const score = ratio - 0.05 * Math.log(1 + bMean);
      if (score < (best.ratio - 0.05 * Math.log(1 + best.bound))) {
        best = { s, d, ratio, non: nonMean, bound: bMean };
      }
    }
  }
  return best;
}

// Build the low-res base image by averaging blocks of size sX x sY starting at dX, dY
function rebuildBase(imgData: ImageData, sX: number, sY: number, dX: number, dY: number): BuildResult {
  const { width: w, height: h, data } = imgData;
  // Crop to full blocks
  const x0 = dX;
  const y0 = dY;
  const wBlocks = Math.floor((w - x0) / sX);
  const hBlocks = Math.floor((h - y0) / sY);
  const wCrop = wBlocks * sX;
  const hCrop = hBlocks * sY;
  const wOut = wBlocks;
  const hOut = hBlocks;

  const out = new ImageData(wOut, hOut);
  const outData = out.data;

  // Average each block. This is O(n). For 1920x1080 with s >= 2 this is fine.
  for (let by = 0; by < hBlocks; by++) {
    for (let bx = 0; bx < wBlocks; bx++) {
      let rSum = 0, gSum = 0, bSum = 0, aSum = 0, count = 0;
      const startX = x0 + bx * sX;
      const startY = y0 + by * sY;
      for (let yy = 0; yy < sY; yy++) {
        const yIdx = (startY + yy) * w * 4;
        for (let xx = 0; xx < sX; xx++) {
          const i = yIdx + (startX + xx) * 4;
          rSum += data[i];
          gSum += data[i + 1];
          bSum += data[i + 2];
          aSum += data[i + 3];
          count++;
        }
      }
      const o = (by * wOut + bx) * 4;
      outData[o] = Math.round(rSum / count);
      outData[o + 1] = Math.round(gSum / count);
      outData[o + 2] = Math.round(bSum / count);
      outData[o + 3] = Math.round(aSum / count);
    }
  }

  return { baseImageData: out, crop: { x0, y0, wCrop, hCrop, wOut, hOut } };
}

// Posterize color channels down to given bits per channel (2..8)
function posterize(img: ImageData, bits: number): ImageData {
  if (bits >= 8) return img;
  const out = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  const shift = 8 - bits; // 8->0, 7->1 etc
  const data = out.data;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = (data[i] >> shift) << shift;
    data[i + 1] = (data[i + 1] >> shift) << shift;
    data[i + 2] = (data[i + 2] >> shift) << shift;
    // alpha unchanged
  }
  return out;
}

// Draw image data to a canvas with optional upscale and pixelated rendering
function drawToCanvas(canvas: HTMLCanvasElement, img: ImageData, scale = 1, targetW?: number, targetH?: number) {
  const ctx = canvas.getContext("2d")!;
  const w = targetW ?? img.width * scale;
  const h = targetH ?? img.height * scale;
  canvas.width = w;
  canvas.height = h;
  // Put original size to an offscreen then scale
  const off = document.createElement("canvas");
  off.width = img.width;
  off.height = img.height;
  const octx = off.getContext("2d")!;
  octx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(off, 0, 0, w, h);
}

// Draw grid overlay that marks the detected block boundaries
function drawGridOverlay(canvas: HTMLCanvasElement, w: number, h: number, sX: number, sY: number, dX: number, dY: number) {
  const ctx = canvas.getContext("2d")!;
  canvas.width = w;
  canvas.height = h;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(0, 200, 255, 0.6)";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);

  // Vertical lines
  const startX = dX;
  for (let x = startX; x <= w; x += sX) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, h);
    ctx.stroke();
  }
  // Horizontal lines
  const startY = dY;
  for (let y = startY; y <= h; y += sY) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(w, y + 0.5);
    ctx.stroke();
  }
}

// Convert a canvas to a downloadable PNG
function downloadCanvasPNG(canvas: HTMLCanvasElement, filename: string) {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });
}

// Convert ImageData to downloadable PNG directly
function downloadImageDataPNG(img: ImageData, filename: string) {
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d")!;
  c.width = img.width;
  c.height = img.height;
  ctx.putImageData(img, 0, 0);
  downloadCanvasPNG(c, filename);
}

// Fixed color palette (ordered)
const FULL_PALETTE = [
  "#000000","#3c3c3c","#787878","#aaaaaa","#d2d2d2","#ffffff",
  "#600018","#a50e1e","#ed1c24","#fa8072",
  "#e45c1a","#ff7f27","#f6aa09","#f9dd3b","#fffabc",
  "#9c8431","#c5ad31","#e8d45f",
  "#4a6b3a","#5a944a","#84c573","#0eb968","#13e67b","#87ff5e",
  "#0c816e","#10aea6","#13e1be","#0f799f","#60f7f2","#bbfaf2",
  "#28509e","#4093e4","#7dc7ff",
  "#4d31b8","#6b50f6","#99b1fb",
  "#4a4284","#7a71c4","#b5aef1",
  "#780c99","#aa38b9","#e09ff9",
  "#cb007a","#ec1f80","#f38da9",
  "#9b5249","#d18078","#fab6a4",
  "#684634","#95682a","#dba463",
  "#7b6352","#9c846b","#d6b594",
  "#d18051","#f8b277","#ffc5a5",
  "#6d643f","#948c6b","#cdc59e",
  "#333941","#6d758d","#b3b9d1"
];
// Free colors subset
const FREE_COLORS = [
  "#000000","#3c3c3c","#787878","#d2d2d2","#ffffff",
  "#600018","#ed1c24","#ff7f27","#f6aa09","#f9dd3b","#fffabc",
  "#0eb968","#13e67b","#87ff5e","#0c816e","#10aea6","#13e1be",
  "#28509e","#4093e4","#60f7f2","#6b50f6","#99b1fb",
  "#780c99","#aa38b9","#e09ff9","#cb007a","#ec1f80","#f38da9",
  "#684634","#95682a","#f8b277"
];
const FREE_COLOR_SET = new Set(FREE_COLORS);

function hexToRGB(hex: string) {
  const h = hex.replace('#','');
  const r = parseInt(h.substring(0,2),16);
  const g = parseInt(h.substring(2,4),16);
  const b = parseInt(h.substring(4,6),16);
  return { r, g, b };
}

function quantizeToPalette(img: ImageData, palette: {r:number;g:number;b:number;}[]) {
  if (!palette.length) return img;
  const out = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  const data = out.data;
  for (let i = 0; i < data.length; i += 4) {
    let br = data[i], bg = data[i+1], bb = data[i+2];
    let bestIdx = 0; let bestDist = Infinity;
    for (let p = 0; p < palette.length; p++) {
      const pr = palette[p].r, pg = palette[p].g, pb = palette[p].b;
      const dr = br - pr; const dg = bg - pg; const db = bb - pb;
      const dist = dr*dr + dg*dg + db*db;
      if (dist < bestDist) { bestDist = dist; bestIdx = p; }
    }
    const best = palette[bestIdx];
    data[i] = best.r; data[i+1] = best.g; data[i+2] = best.b; // alpha unchanged
  }
  return out;
}

export default function PixelArtFixer() {
  const [imageURL, setImageURL] = useState<string | null>(null);
  const [imgEl, setImgEl] = useState<HTMLImageElement | null>(null);
  const [imgData, setImgData] = useState<ImageData | null>(null);
  const [diffs, setDiffs] = useState<{ diffX: Float64Array; diffY: Float64Array } | null>(null);

  const [autoMaxScale, setAutoMaxScale] = useState(64);
  const [detected, setDetected] = useState<DetectResult | null>(null);

  const [sX, setSX] = useState(8);
  const [sY, setSY] = useState(8);
  const [dX, setDX] = useState(0);
  const [dY, setDY] = useState(0);

  const [posterizeBits, setPosterizeBits] = useState(8);
  const [overlayGrid, setOverlayGrid] = useState(true);
  const [reveal, setReveal] = useState(50); // percent for before-after reveal

  // Palette state
  const [usePalette, setUsePalette] = useState(true);
  const [enabledColors, setEnabledColors] = useState<boolean[]>(() => FULL_PALETTE.map(() => true));

  const toggleColor = (idx: number) => {
    setEnabledColors(prev => prev.map((v,i)=> i===idx ? !v : v));
  };
  const enableAllColors = () => setEnabledColors(FULL_PALETTE.map(() => true));
  const applyFreeColors = () => setEnabledColors(FULL_PALETTE.map(c => FREE_COLOR_SET.has(c)));
  const disableAll = () => setEnabledColors(FULL_PALETTE.map(() => false));

  const activePaletteRGB = useMemo(() => {
    if (!usePalette) return [] as {r:number;g:number;b:number;}[];
    return FULL_PALETTE.filter((_,i)=>enabledColors[i]).map(hexToRGB);
  }, [usePalette, enabledColors]);

  const originalRef = useRef<HTMLDivElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null); // grid overlay on original
  const afterCanvasRef = useRef<HTMLCanvasElement>(null); // processed and scaled to original size for reveal overlay
  const baseCanvasRef = useRef<HTMLCanvasElement>(null); // the low-res base canvas for preview

  const [build, setBuild] = useState<BuildResult | null>(null);

  // Load file
  const onFile = (file: File) => {
    const url = URL.createObjectURL(file);
    setImageURL(url);
  };

  // On imageURL change, create HTMLImageElement
  useEffect(() => {
    if (!imageURL) return;
    const img = new Image();
    img.onload = () => {
      setImgEl(img);
    };
    img.onerror = () => {
      alert("Failed to load image");
      setImageURL(null);
    };
    img.src = imageURL;
    return () => {
      URL.revokeObjectURL(imageURL);
    };
  }, [imageURL]);

  // Draw image to canvas and capture ImageData
  useEffect(() => {
    if (!imgEl) return;
    const c = document.createElement("canvas");
    c.width = imgEl.naturalWidth;
    c.height = imgEl.naturalHeight;
    const ctx = c.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(imgEl, 0, 0);
    const data = ctx.getImageData(0, 0, c.width, c.height);
    setImgData(data);
    setBuild(null);
    setDetected(null);
  }, [imgEl]);

  // Compute diffs when we have imgData
  useEffect(() => {
    if (!imgData) return;
    setDiffs(computeDiffs(imgData));
  }, [imgData]);

  // Auto detect when diffs ready
  useEffect(() => {
    if (!diffs || !imgData) return;
    const w = imgData.width;
    const h = imgData.height;
    const maxS = Math.min(autoMaxScale, Math.max(2, Math.floor(Math.min(w, h) / 4)));
    const bx = detectAxis(diffs.diffX, maxS);
    const by = detectAxis(diffs.diffY, maxS);
    const result: DetectResult = { sX: bx.s, sY: by.s, dX: bx.d, dY: by.d, ratioX: bx.ratio, ratioY: by.ratio } as any;
    setDetected(result);
    setSX(result.sX);
    setSY(result.sY);
    setDX(result.dX);
    setDY(result.dY);
  }, [diffs, imgData, autoMaxScale]);

  // Build low-res base whenever params change
  useEffect(() => {
    if (!imgData) return;
    const built = rebuildBase(imgData, sX, sY, dX, dY);
    setBuild(built);
  }, [imgData, sX, sY, dX, dY]);

  // Memo processed base (posterize + palette)
  const processedBase: ImageData | null = useMemo(() => {
    if (!build) return null;
    let img = posterizeBits < 8 ? posterize(build.baseImageData, posterizeBits) : build.baseImageData;
    if (activePaletteRGB.length) {
      img = quantizeToPalette(img, activePaletteRGB);
    }
    return img;
  }, [build, posterizeBits, activePaletteRGB]);

  // Build a full-size pixelated overlay (fills margins by extending edge colors) so original is not visible underneath
  const fullPixelated: ImageData | null = useMemo(() => {
    if (!processedBase || !imgData || !build) return null;
    const { width: fullW, height: fullH } = imgData;
    const { x0, y0, wOut, hOut } = build.crop;
    const out = new ImageData(fullW, fullH);
    const baseData = processedBase.data;
    const outData = out.data;
    for (let y = 0; y < fullH; y++) {
      let localY = y - y0;
      if (localY < 0) localY = 0; else if (localY >= hOut * sY) localY = hOut * sY - 1;
      const by = Math.floor(localY / sY);
      for (let x = 0; x < fullW; x++) {
        let localX = x - x0;
        if (localX < 0) localX = 0; else if (localX >= wOut * sX) localX = wOut * sX - 1;
        const bx = Math.floor(localX / sX);
        const bi = (by * wOut + bx) * 4;
        const oi = (y * fullW + x) * 4;
        outData[oi] = baseData[bi];
        outData[oi + 1] = baseData[bi + 1];
        outData[oi + 2] = baseData[bi + 2];
        outData[oi + 3] = 255; // opaque
      }
    }
    return out;
  }, [processedBase, imgData, build, sX, sY]);

  // Draw grid overlay on original and draw processed result scaled to original size for reveal
  useEffect(() => {
    if (!imgEl || !build || !fullPixelated) return;
    const w = imgEl.naturalWidth;
    const h = imgEl.naturalHeight;

    if (overlayCanvasRef.current) {
      if (overlayGrid) drawGridOverlay(overlayCanvasRef.current, w, h, sX, sY, dX, dY);
      else {
        const c = overlayCanvasRef.current;
        c.width = w; c.height = h; c.getContext("2d")!.clearRect(0,0,w,h);
      }
    }

    if (afterCanvasRef.current) {
      const canvas = afterCanvasRef.current;
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d")!;
      ctx.clearRect(0,0,w,h);
      ctx.imageSmoothingEnabled = false;
      const off = document.createElement("canvas");
      off.width = fullPixelated.width; off.height = fullPixelated.height;
      off.getContext("2d")!.putImageData(fullPixelated,0,0);
      ctx.drawImage(off, 0,0);
    }
  }, [imgEl, build, fullPixelated, sX, sY, dX, dY, overlayGrid]);

  // Draw low-res base to its own preview canvas at a friendly scale
  useEffect(() => {
    if (!processedBase || !baseCanvasRef.current) return;
    const previewScale = Math.max(2, Math.floor(512 / Math.max(processedBase.width, processedBase.height)));
    drawToCanvas(baseCanvasRef.current, processedBase, previewScale);
  }, [processedBase]);

  const handleExportBase = () => {
    if (!processedBase) return;
    downloadImageDataPNG(processedBase, `pixelart_base_${processedBase.width}x${processedBase.height}.png`);
  };

  const handleExportUpscaled = () => {
    if (!afterCanvasRef.current) return;
    downloadCanvasPNG(afterCanvasRef.current, `pixelart_upscaled_${imgEl?.naturalWidth}x${imgEl?.naturalHeight}.png`);
  };

  // File drop handling
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) onFile(file);
  };

  const onSelectFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onFile(file);
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="sticky top-0 z-10 backdrop-blur bg-zinc-950/70 border-b border-zinc-800">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">PixelArt Fixer</h1>
          <div className="text-xs sm:text-sm text-zinc-400">Auto-detect scale - rebuild clean pixels - export</div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 grid gap-6">
        {/* Upload area */}
        {!imageURL && (
          <div
            onDrop={onDrop}
            onDragOver={(e) => e.preventDefault()}
            className="border-2 border-dashed border-zinc-700 rounded-2xl p-10 text-center grid place-items-center bg-zinc-900/40"
          >
            <div className="space-y-4">
              <div className="text-lg">Drop an image here</div>
              <div className="text-zinc-400 text-sm">Or click to choose a file</div>
              <label className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 cursor-pointer">
                <input type="file" accept="image/*" className="hidden" onChange={onSelectFile} />
                <span>Choose image</span>
              </label>
              <p className="text-xs text-zinc-500">Tip: works best if the source was scaled with nearest-neighbor</p>
            </div>
          </div>
        )}

        {imageURL && imgEl && imgData && (
          <>
            {/* Controls */}
            <div className="grid gap-4 md:grid-cols-3">
              <div className="rounded-2xl border border-zinc-800 p-4 bg-zinc-900/40">
                <h2 className="font-medium mb-3">Detection</h2>
                <div className="grid sm:grid-cols-2 gap-3 text-sm">
                  <div>
                    <label className="text-zinc-400">Max scale to search</label>
                    <input
                      type="range"
                      min={8}
                      max={128}
                      value={autoMaxScale}
                      onChange={(e) => setAutoMaxScale(parseInt(e.target.value))}
                      className="w-full"
                    />
                    <div className="text-zinc-400">{autoMaxScale} px</div>
                  </div>
                  <div className="flex items-end">
                    <button
                      onClick={() => {
                        if (!diffs || !imgData) return;
                        const w = imgData.width;
                        const h = imgData.height;
                        const maxS = Math.min(autoMaxScale, Math.max(2, Math.floor(Math.min(w, h) / 4)));
                        const bx = detectAxis(diffs.diffX, maxS);
                        const by = detectAxis(diffs.diffY, maxS);
                        const result: DetectResult = { sX: bx.s, sY: by.s, dX: bx.d, dY: by.d, ratioX: bx.ratio, ratioY: by.ratio } as any;
                        setDetected(result);
                        setSX(result.sX);
                        setSY(result.sY);
                        setDX(result.dX);
                        setDY(result.dY);
                      }}
                      className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500"
                    >
                      Re-detect
                    </button>
                  </div>
                </div>
                {detected && (
                  <div className="mt-3 text-xs text-zinc-400">
                    Auto: sX {detected.sX}, dX {detected.dX}, sY {detected.sY}, dY {detected.dY}
                  </div>
                )}
              </div>

              <div className="rounded-2xl border border-zinc-800 p-4 bg-zinc-900/40">
                <h2 className="font-medium mb-3">Tweak</h2>
                <div className="grid sm:grid-cols-2 gap-4 text-sm">
                  <div>
                    <label className="text-zinc-400">Scale X (px)</label>
                    <input type="range" min={1} max={128} value={sX} onChange={(e) => setSX(parseInt(e.target.value))} className="w-full" />
                    <div className="text-zinc-400">{sX}</div>
                  </div>
                  <div>
                    <label className="text-zinc-400">Offset X</label>
                    <input type="range" min={0} max={Math.max(0, sX - 1)} value={dX} onChange={(e) => setDX(parseInt(e.target.value))} className="w-full" />
                    <div className="text-zinc-400">{dX}</div>
                  </div>
                  <div>
                    <label className="text-zinc-400">Scale Y (px)</label>
                    <input type="range" min={1} max={128} value={sY} onChange={(e) => setSY(parseInt(e.target.value))} className="w-full" />
                    <div className="text-zinc-400">{sY}</div>
                  </div>
                  <div>
                    <label className="text-zinc-400">Offset Y</label>
                    <input type="range" min={0} max={Math.max(0, sY - 1)} value={dY} onChange={(e) => setDY(parseInt(e.target.value))} className="w-full" />
                    <div className="text-zinc-400">{dY}</div>
                  </div>
                  <div>
                    <label className="text-zinc-400">Posterize (bits per channel)</label>
                    <input
                      type="range"
                      min={2}
                      max={8}
                      value={posterizeBits}
                      onChange={(e) => setPosterizeBits(parseInt(e.target.value))}
                      className="w-full"
                    />
                    <div className="text-zinc-400">{posterizeBits} bits</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <input id="grid" type="checkbox" className="accent-blue-600" checked={overlayGrid} onChange={(e) => setOverlayGrid(e.target.checked)} />
                    <label htmlFor="grid" className="text-zinc-200">Show grid overlay</label>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-zinc-800 p-4 bg-zinc-900/40 overflow-hidden">
                <h2 className="font-medium mb-3">Palette</h2>
                <div className="flex flex-wrap items-center gap-2 mb-3 text-xs">
                  <label className="flex items-center gap-1 cursor-pointer select-none">
                    <input type="checkbox" className="accent-blue-600" checked={usePalette} onChange={e=>setUsePalette(e.target.checked)} />
                    <span className="text-zinc-300">Use palette</span>
                  </label>
                  <button onClick={applyFreeColors} className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700" title="Enable only free colors">Only free colors</button>
                  <button onClick={enableAllColors} className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700" title="Enable all colors">Use all colors</button>
                  <button onClick={disableAll} className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700" title="Disable all colors">None</button>
                </div>
                <div className="grid grid-cols-8 gap-2">
                  {FULL_PALETTE.map((hex, i) => {
                    const enabled = enabledColors[i];
                    return (
                      <button
                        key={i}
                        onClick={()=>toggleColor(i)}
                        className={`w-6 h-6 rounded border border-zinc-700 relative group ${enabled ? '' : 'opacity-30 grayscale'} focus:outline-none focus:ring-2 focus:ring-blue-500`}
                        style={{ backgroundColor: hex }}
                        title={hex + (enabled ? '' : ' (disabled)')}
                      >
                        {!enabled && <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-zinc-200">×</span>}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-3 text-[10px] leading-snug text-zinc-400">Click colors to enable/disable them. Only enabled colors are used when building the pixelated version.</p>
              </div>
            </div>

            {/* Before-after viewer */}
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 overflow-hidden">
              <div className="p-3 flex items-center justify-between text-sm text-zinc-300">
                <div>Before - Original</div>
                <div>After - Rebuilt</div>
              </div>
              <div className="relative">
                {/* The original image */}
                <div ref={originalRef} className="w-full overflow-auto">
                  <div className="relative inline-block">
                    <img src={imageURL} alt="original" className="block max-w-full h-auto select-none" draggable={false} />
                    {/* Grid overlay canvas positioned over the image, same pixel size */}
                    <canvas
                      ref={overlayCanvasRef}
                      className="absolute inset-0 w-full h-full"
                      style={{ imageRendering: "pixelated" as any }}
                    />
                  </div>
                </div>

                {/* After overlay canvas with reveal */}
                <div className="pointer-events-none absolute inset-0">
                  <div className="relative w-full h-full">
                    <canvas
                      ref={afterCanvasRef}
                      className="absolute top-0 left-0"
                      style={{
                        width: imgEl.naturalWidth + "px",
                        height: imgEl.naturalHeight + "px",
                        imageRendering: "pixelated" as any,
                        clipPath: `inset(0 ${100 - reveal}% 0 0)` // reveal from left to right
                      }}
                    />
                  </div>
                </div>

                {/* Reveal slider */}
                <div className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-zinc-900/80 backdrop-blur px-3 py-2 rounded-xl border border-zinc-800">
                  <div className="flex items-center gap-2 text-xs text-zinc-300">
                    <span>Reveal</span>
                    <input type="range" min={0} max={100} value={reveal} onChange={(e) => setReveal(parseInt(e.target.value))} />
                    <span>{reveal}%</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Low-res base preview and exports */}
            <div className="grid md:grid-cols-2 gap-4">
              <div className="rounded-2xl border border-zinc-800 p-4 bg-zinc-900/40">
                <h2 className="font-medium mb-3">Recovered base ({build?.baseImageData.width} x {build?.baseImageData.height})</h2>
                <canvas ref={baseCanvasRef} className="block rounded-xl border border-zinc-800 mx-auto" style={{ imageRendering: "pixelated" as any }} />
              </div>

              <div className="rounded-2xl border border-zinc-800 p-4 bg-zinc-900/40 grid content-start gap-3">
                <h2 className="font-medium">Export</h2>
                <div className="flex flex-wrap gap-3">
                  <button onClick={handleExportBase} className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500">Download base PNG</button>
                  <button onClick={handleExportUpscaled} className="px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500">Download upscaled overlay PNG</button>
                </div>
                <p className="text-xs text-zinc-400">
                  The base PNG is the clean pixel-art at 1x scale. The upscaled overlay PNG matches the original dimensions and uses nearest-neighbor.
                  {usePalette && ` Palette constraint (${activePaletteRGB.length} colors enabled).`}
                </p>
              </div>
            </div>
          </>
        )}

        {/* Footer */}
        <div className="text-center text-xs text-zinc-500 py-6">
          Made for reconstructing pixel-art from scaled images. Works best with crisp nearest-neighbor sources.
        </div>
      </main>
    </div>
  );
}
