// Shared image / pixel processing utilities
export interface DetectResult { sX:number; sY:number; dX:number; dY:number; ratioX:number; ratioY:number; }
export interface BuildResult { baseImageData: ImageData; crop:{ x0:number; y0:number; wCrop:number; hCrop:number; wOut:number; hOut:number }; }

export function computeDiffs(imgData: ImageData){
  const { width: w, height: h, data } = imgData;
  const diffX = new Float64Array(w - 1);
  const diffY = new Float64Array(h - 1);
  for (let y = 0; y < h; y++) {
    let rowIdx = y * w * 4;
    for (let x = 0; x < w - 1; x++) {
      const i = rowIdx + x * 4; const j = i + 4;
      const dr = Math.abs(data[i] - data[j]);
      const dg = Math.abs(data[i + 1] - data[j + 1]);
      const db = Math.abs(data[i + 2] - data[j + 2]);
      diffX[x] += dr + dg + db;
    }
  }
  for (let y = 0; y < h - 1; y++) {
    let rowIdx = y * w * 4; let nextRowIdx = (y + 1) * w * 4;
    for (let x = 0; x < w; x++) {
      const i = rowIdx + x * 4; const j = nextRowIdx + x * 4;
      const dr = Math.abs(data[i] - data[j]);
      const dg = Math.abs(data[i + 1] - data[j + 1]);
      const db = Math.abs(data[i + 2] - data[j + 2]);
      diffY[y] += dr + dg + db;
    }
  }
  for (let x = 0; x < diffX.length; x++) diffX[x] /= h;
  for (let y = 0; y < diffY.length; y++) diffY[y] /= w;
  return { diffX, diffY };
}

function evaluateScaleOffset1D(diff: Float64Array, s:number, d:number){
  const n = diff.length; let nonSum=0, nonCount=0, bSum=0, bCount=0; const boundaryVal = s - 1;
  for(let i=0;i<n;i++){
    if (((i - d) % s + s) % s === boundaryVal) { bSum += diff[i]; bCount++; }
    else { nonSum += diff[i]; nonCount++; }
  }
  const nonMean = nonCount ? nonSum / nonCount : Number.POSITIVE_INFINITY;
  const bMean = bCount ? bSum / bCount : 1e-6;
  const ratio = nonMean / (bMean + 1e-6);
  return { ratio, nonMean, bMean };
}

export function detectAxis(diff: Float64Array, maxS:number){
  let best = { s:1, d:0, ratio: Number.POSITIVE_INFINITY, non:0, bound:0 };
  for (let s=2; s<=maxS; s++) {
    for (let d=0; d<s; d++) {
      const { ratio, nonMean, bMean } = evaluateScaleOffset1D(diff, s, d);
      const score = ratio - 0.05 * Math.log(1 + bMean);
      if (score < (best.ratio - 0.05 * Math.log(1 + best.bound))) {
        best = { s, d, ratio, non: nonMean, bound: bMean };
      }
    }
  }
  return best;
}

export function rebuildBase(imgData: ImageData, sX:number, sY:number, dX:number, dY:number): BuildResult {
  const { width: w, height: h, data } = imgData;
  const x0 = dX; const y0 = dY;
  const wBlocks = Math.floor((w - x0) / sX);
  const hBlocks = Math.floor((h - y0) / sY);
  const wCrop = wBlocks * sX; const hCrop = hBlocks * sY;
  const wOut = wBlocks; const hOut = hBlocks;
  const out = new ImageData(wOut, hOut); const outData = out.data;
  for (let by=0; by<hBlocks; by++) {
    for (let bx=0; bx<wBlocks; bx++) {
      let rSum=0,gSum=0,bSum=0,aSum=0,count=0; const startX = x0 + bx * sX; const startY = y0 + by * sY;
      for (let yy=0; yy<sY; yy++) { const yIdx = (startY + yy) * w * 4; for (let xx=0; xx<sX; xx++) { const i = yIdx + (startX + xx) * 4; rSum+=data[i]; gSum+=data[i+1]; bSum+=data[i+2]; aSum+=data[i+3]; count++; }}
      const o = (by * wOut + bx) * 4; outData[o] = Math.round(rSum/count); outData[o+1] = Math.round(gSum/count); outData[o+2] = Math.round(bSum/count); outData[o+3] = Math.round(aSum/count);
    }
  }
  return { baseImageData: out, crop: { x0, y0, wCrop, hCrop, wOut, hOut } };
}

export function posterize(img: ImageData, bits:number){
  if(bits>=8) return img; const out = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height); const shift = 8 - bits; const data = out.data; for(let i=0;i<data.length;i+=4){ data[i] = (data[i]>>shift)<<shift; data[i+1] = (data[i+1]>>shift)<<shift; data[i+2] = (data[i+2]>>shift)<<shift; } return out;
}

export function drawToCanvas(canvas: HTMLCanvasElement, img: ImageData, scale=1, targetW?:number, targetH?:number){
  const ctx = canvas.getContext('2d')!; const w = targetW ?? img.width * scale; const h = targetH ?? img.height * scale; canvas.width = w; canvas.height = h; const off = document.createElement('canvas'); off.width = img.width; off.height = img.height; off.getContext('2d')!.putImageData(img,0,0); ctx.imageSmoothingEnabled = false; ctx.clearRect(0,0,w,h); ctx.drawImage(off,0,0,w,h);
}

export function drawGridOverlay(canvas: HTMLCanvasElement, w:number, h:number, sX:number, sY:number, dX:number, dY:number){
  const ctx = canvas.getContext('2d')!; canvas.width = w; canvas.height = h; ctx.clearRect(0,0,w,h); ctx.strokeStyle = 'rgba(0, 200, 255, 0.6)'; ctx.lineWidth = 1; ctx.setLineDash([4,4]); const startX = dX; for(let x=startX; x<=w; x+=sX){ ctx.beginPath(); ctx.moveTo(x+0.5,0); ctx.lineTo(x+0.5,h); ctx.stroke(); } const startY = dY; for(let y=startY; y<=h; y+=sY){ ctx.beginPath(); ctx.moveTo(0,y+0.5); ctx.lineTo(w,y+0.5); ctx.stroke(); }
}

export function downloadCanvasPNG(canvas: HTMLCanvasElement, filename:string){
  canvas.toBlob(blob=>{ if(!blob) return; const url = URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=filename; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url); });
}

export function downloadImageDataPNG(img: ImageData, filename:string){
  const c = document.createElement('canvas'); const ctx = c.getContext('2d')!; c.width = img.width; c.height = img.height; ctx.putImageData(img,0,0); downloadCanvasPNG(c, filename);
}

export function quantizeToPalette(img: ImageData, palette:{r:number;g:number;b:number;}[]){
  if(!palette.length) return img; const out = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height); const data = out.data; for(let i=0;i<data.length;i+=4){ let br=data[i], bg=data[i+1], bb=data[i+2]; let bestIdx=0, bestDist=Infinity; for(let p=0;p<palette.length;p++){ const pr=palette[p].r, pg=palette[p].g, pb=palette[p].b; const dr=br-pr, dg=bg-pg, db=bb-pb; const dist=dr*dr+dg*dg+db*db; if(dist<bestDist){ bestDist=dist; bestIdx=p; } } const best = palette[bestIdx]; data[i]=best.r; data[i+1]=best.g; data[i+2]=best.b; } return out;
}

// ---------------- Advanced quantization with dithering ----------------
// Perceptual distance using OKLab (good compromise for palette matching)
function srgbToLinear(c:number){ c/=255; return c<=0.04045? c/12.92 : Math.pow((c+0.055)/1.055,2.4); }
function rgbToOklab(r:number,g:number,b:number){
  // Convert sRGB to linear RGB
  const rl = srgbToLinear(r), gl = srgbToLinear(g), bl = srgbToLinear(b);
  // Linear RGB -> LMS
  const l = 0.4122214708*rl + 0.5363325363*gl + 0.0514459929*bl;
  const m = 0.2119034982*rl + 0.6806995451*gl + 0.1073969566*bl;
  const s = 0.0883024619*rl + 0.2817188376*gl + 0.6299787005*bl;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  const L = 0.2104542553*l_ + 0.7936177850*m_ - 0.0040720468*s_;
  const a = 1.9779984951*l_ - 2.4285922050*m_ + 0.4505937099*s_;
  const b2 = 0.0259040371*l_ + 0.7827717662*m_ - 0.8086757660*s_;
  return [L,a,b2] as [number,number,number];
}

function colorDistance(aR:number,aG:number,aB:number, bR:number,bG:number,bB:number, mode:'rgb'|'oklab'='oklab'){
  if(mode==='rgb'){ const dr=aR-bR, dg=aG-bG, db=aB-bB; return dr*dr+dg*dg+db*db; }
  const [L1,a1,b1] = rgbToOklab(aR,aG,aB); const [L2,a2,b2] = rgbToOklab(bR,bG,bB); const dL=L1-L2, da=a1-a2, db=b1-b2; return dL*dL+da*da+db*db;
}

function nearestPaletteColor(r:number,g:number,b:number, palette:{r:number;g:number;b:number;}[], distance:'rgb'|'oklab'){
  let bestIdx=0, bestDist=Infinity; for(let i=0;i<palette.length;i++){ const p=palette[i]; const d=colorDistance(r,g,b,p.r,p.g,p.b,distance); if(d<bestDist){ bestDist=d; bestIdx=i; } } return palette[bestIdx];
}

function clamp255(x:number){ return x<0?0:x>255?255:x; }

export type DitherMode = 'none'|'floyd-steinberg'|'ordered4'|'ordered8'|'atkinson';
export interface QuantizeAdvancedOptions{
  distance?: 'rgb'|'oklab';
  dithering?: DitherMode;
  orderedStrength?: number; // 0..1 applies to ordered modes
  serpentine?: boolean;     // for error-diffusion
}

// Exported helper: palette-aware quantization with optional dithering
export function quantizeToPaletteAdvanced(img: ImageData, palette:{r:number;g:number;b:number;}[], opts: QuantizeAdvancedOptions = {}){
  if(!palette.length) return img;
  const { distance='oklab', dithering='none', orderedStrength=0.5, serpentine=true } = opts;
  if(dithering==='none'){
    const out = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
    const d = out.data;
    for(let i=0;i<d.length;i+=4){ const c = nearestPaletteColor(d[i], d[i+1], d[i+2], palette, distance); d[i]=c.r; d[i+1]=c.g; d[i+2]=c.b; }
    return out;
  }
  if(dithering==='ordered4' || dithering==='ordered8'){
    const size = dithering==='ordered4'? 4 : 8;
    // Generate Bayer matrix normalized to 0..1
    const bayer4 = [
      [0, 8, 2,10],
      [12,4,14,6],
      [3,11,1, 9],
      [15,7,13,5]
    ];
    const bayer8 = [
      [0,32,8,40,2,34,10,42],
      [48,16,56,24,50,18,58,26],
      [12,44,4,36,14,46,6,38],
      [60,28,52,20,62,30,54,22],
      [3,35,11,43,1,33,9,41],
      [51,19,59,27,49,17,57,25],
      [15,47,7,39,13,45,5,37],
      [63,31,55,23,61,29,53,21]
    ];
    const M = size===4? bayer4 : bayer8;
    const denom = size===4? 16 : 64;
    const out = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
    const d = out.data; const w=out.width, h=out.height;
    for(let y=0;y<h;y++){
      for(let x=0;x<w;x++){
        const i=(y*w+x)*4; const t=(M[y%size][x%size]/denom - 0.5) * 255 * (orderedStrength ?? 0.5);
        const r = clamp255(d[i] + t), g = clamp255(d[i+1] + t), b = clamp255(d[i+2] + t);
        const c = nearestPaletteColor(r,g,b,palette,distance);
        d[i]=c.r; d[i+1]=c.g; d[i+2]=c.b;
      }
    }
    return out;
  }
  // Error diffusion (Floyd-Steinberg or Atkinson)
  const w = img.width, h = img.height; const out = new ImageData(w,h); const od = out.data;
  // Work buffer as floats for accumulated error
  const buf = new Float32Array(w*h*3);
  const src = img.data;
  const weightsFS = [
    // [dx, dy, factor]
    [1,0,7/16], [-1,1,3/16], [0,1,5/16], [1,1,1/16]
  ] as const;
  const weightsAtk = [
    [1,0,1/8], [2,0,1/8], [-1,1,1/8], [0,1,1/8], [1,1,1/8], [0,2,1/8]
  ] as const;
  const weights = dithering==='atkinson'? weightsAtk : weightsFS;
  for(let y=0;y<h;y++){
    const dir = (serpentine && (y%2===1))? -1 : 1;
    const xStart = dir===1? 0 : w-1; const xEnd = dir===1? w : -1;
    for(let x=xStart; x!==xEnd; x+=dir){
      const idx = y*w+x; const i = idx*4; const bIdx = idx*3;
      let r = src[i]   + buf[bIdx];
      let g = src[i+1] + buf[bIdx+1];
      let b = src[i+2] + buf[bIdx+2];
      r = clamp255(r); g = clamp255(g); b = clamp255(b);
      const c = nearestPaletteColor(r,g,b,palette,distance);
      od[i]=c.r; od[i+1]=c.g; od[i+2]=c.b; od[i+3]=255;
      const er = r - c.r, eg = g - c.g, eb = b - c.b;
      for(const [dx,dy,f] of weights){
        const nx = x + dx*dir; const ny = y + dy; if(nx<0||nx>=w||ny<0||ny>=h) continue; const n = (ny*w+nx)*3; buf[n]   += er*f; buf[n+1] += eg*f; buf[n+2] += eb*f; }
    }
  }
  return out;
}

// -------- Worker-accelerated path --------
// Dynamically import pool to avoid including in SSR and let Vite split code
export async function quantizeToPaletteAdvancedFast(img: ImageData, palette:{r:number;g:number;b:number;}[], opts: QuantizeAdvancedOptions = {}){
  if(!palette.length) return img;
  const { distance='oklab', dithering='none', orderedStrength=0.5, serpentine=true } = opts;
  const { QuantPool, paletteToFlat } = await import('../workers/pool.ts');
  const w = img.width, h = img.height;
  const pool = new QuantPool();
  const flat = paletteToFlat(palette);
  const src = new Uint8ClampedArray(img.data); // copy because we'll transfer
  const canParallel = (dithering==='none' || dithering==='ordered4' || dithering==='ordered8');
  const cacheBits = distance==='oklab' ? 5 : 6; // OKLab a bit heavier
  if(canParallel){
    const strips = Math.min((pool as any).size ?? 1, h);
    const jobs = [] as Promise<any>[];
    const out = new Uint8ClampedArray(w*h*4);
    const rowsPer = Math.ceil(h / strips);
    for(let s=0;s<strips;s++){
      const yStart = s*rowsPer; if(yStart>=h) break; const yEnd = Math.min(h, yStart+rowsPer);
      const slice = src.slice(yStart*w*4, yEnd*w*4);
      const job = pool.submit({ width:w, height:h, src: slice.buffer, palette: flat, mode: dithering, distance, orderedStrength, serpentine, yStart, yEnd, cacheBits });
      jobs.push(job.then((res)=>{ const strip = new Uint8ClampedArray(res.out); out.set(strip, yStart*w*4); }));
    }
    await Promise.all(jobs);
    pool.destroy();
    return new ImageData(out, w, h);
  } else {
    // Single worker full-frame diffusion
    const job = await pool.submit({ width:w, height:h, src: src.buffer, palette: flat, mode: dithering, distance, orderedStrength, serpentine, cacheBits });
    pool.destroy();
    return new ImageData(new Uint8ClampedArray(job.out), w, h);
  }
}
