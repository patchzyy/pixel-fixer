/*
  Web Worker for fast palette quantization and dithering.
  Modes:
    - none: nearest palette only (parallelizable by strips)
    - ordered4 / ordered8: ordered dithering (parallelizable by strips)
    - floyd-steinberg / atkinson: error diffusion (single-worker full frame)
*/

export type DitherMode = 'none' | 'floyd-steinberg' | 'ordered4' | 'ordered8' | 'atkinson';
export type DistanceMode = 'rgb' | 'oklab';

export interface QuantizeJob {
  width: number;
  height: number;
  src: ArrayBuffer; // Uint8ClampedArray RGBA
  palette: Uint8Array; // flat [r,g,b,...]
  mode: DitherMode;
  distance: DistanceMode;
  orderedStrength: number; // 0..1
  serpentine: boolean;
  // For parallel modes we can process a strip to increase throughput
  yStart?: number;
  yEnd?: number; // exclusive
  // Cache resolution for nearest lookup LUT: 5 => 32^3 entries
  cacheBits?: number;
}

export interface QuantizeResult {
  yStart: number;
  yEnd: number;
  out: ArrayBuffer; // Uint8ClampedArray RGBA strip (or full image)
}

function srgbToLinear(c:number){ c/=255; return c<=0.04045? c/12.92 : Math.pow((c+0.055)/1.055,2.4); }
function rgbToOklab(r:number,g:number,b:number){
  const rl = srgbToLinear(r), gl = srgbToLinear(g), bl = srgbToLinear(b);
  const l = 0.4122214708*rl + 0.5363325363*gl + 0.0514459929*bl;
  const m = 0.2119034982*rl + 0.6806995451*gl + 0.1073969566*bl;
  const s = 0.0883024619*rl + 0.2817188376*gl + 0.6299787005*bl;
  const l_ = Math.cbrt(l); const m_ = Math.cbrt(m); const s_ = Math.cbrt(s);
  const L = 0.2104542553*l_ + 0.7936177850*m_ - 0.0040720468*s_;
  const a = 1.9779984951*l_ - 2.4285922050*m_ + 0.4505937099*s_;
  const b2 = 0.0259040371*l_ + 0.7827717662*m_ - 0.8086757660*s_;
  return [L,a,b2] as [number,number,number];
}

function clamp255(x:number){ return x<0?0:x>255?255:x; }

function buildPalettePrepared(pFlat: Uint8Array, distance: DistanceMode){
  const n = Math.floor(pFlat.length/3);
  const pr = new Uint8Array(n), pg = new Uint8Array(n), pb = new Uint8Array(n);
  for(let i=0;i<n;i++){ pr[i]=pFlat[i*3]; pg[i]=pFlat[i*3+1]; pb[i]=pFlat[i*3+2]; }
  let pL: Float32Array|undefined, pA: Float32Array|undefined, pB: Float32Array|undefined;
  if(distance==='oklab'){
    pL = new Float32Array(n); pA = new Float32Array(n); pB = new Float32Array(n);
    for(let i=0;i<n;i++){ const [L,a,b] = rgbToOklab(pr[i],pg[i],pb[i]); pL[i]=L; pA[i]=a; pB[i]=b; }
  }
  return { pr, pg, pb, pL, pA, pB, n };
}

// Quantized cache for nearest-color lookup to avoid recomputing distances
function makeLUT(bits:number){
  const lutSize = 1 << (bits*3); // e.g., 5 bits -> 32768 entries
  const lut = new Int32Array(lutSize);
  for(let i=0;i<lutSize;i++) lut[i] = -1;
  const shift = 8 - bits;
  const key = (r:number,g:number,b:number)=> ((r>>shift)<< (bits*2)) | ((g>>shift)<< bits) | (b>>shift);
  return { lut, key, bits, shift };
}

function nearestIdx(r:number,g:number,b:number, prep: ReturnType<typeof buildPalettePrepared>, distance: DistanceMode, lut?: ReturnType<typeof makeLUT>){
  if(lut){ const k = lut.key(r,g,b); const cached = lut.lut[k]; if(cached>=0) return cached; }
  let best = 0; let bestDist = Infinity;
  if(distance==='rgb'){
    const { pr, pg, pb, n } = prep;
    for(let i=0;i<n;i++){
      const dr = r - pr[i]; const dg = g - pg[i]; const db = b - pb[i];
      const d = dr*dr + dg*dg + db*db;
      if(d < bestDist){ bestDist = d; best = i; }
    }
  }else{
    const { pL, pA, pB, n } = prep;
    const [L1,a1,b1] = rgbToOklab(r,g,b);
    const pLl = pL as Float32Array, pAl = pA as Float32Array, pBl = pB as Float32Array;
    for(let i=0;i<n;i++){
      const dL = L1 - pLl[i]; const da = a1 - pAl[i]; const db2 = b1 - pBl[i];
      const d = dL*dL + da*da + db2*db2;
      if(d < bestDist){ bestDist = d; best = i; }
    }
  }
  if(lut){ const k = lut.key(r,g,b); lut.lut[k] = best; }
  return best;
}

function doNoneOrOrdered(job: QuantizeJob){
  const { width:w, height:h, palette, distance, mode, orderedStrength, src } = job;
  const y0 = job.yStart ?? 0; const y1 = job.yEnd ?? h;
  const srcArr = new Uint8ClampedArray(src);
  const outStrip = new Uint8ClampedArray((y1 - y0) * w * 4);
  const prep = buildPalettePrepared(palette, distance);
  const lut = makeLUT(job.cacheBits ?? 5);
  const size = mode==='ordered4'? 4 : 8;
  const denom = size===4? 16 : 64;
  const M4 = [
    [0, 8, 2,10],
    [12,4,14,6],
    [3,11,1, 9],
    [15,7,13,5]
  ];
  const M8 = [
    [0,32,8,40,2,34,10,42],
    [48,16,56,24,50,18,58,26],
    [12,44,4,36,14,46,6,38],
    [60,28,52,20,62,30,54,22],
    [3,35,11,43,1,33,9,41],
    [51,19,59,27,49,17,57,25],
    [15,47,7,39,13,45,5,37],
    [63,31,55,23,61,29,53,21]
  ];
  const M = mode==='ordered4'? M4 : M8;
  const strength = clamp255(255 * (orderedStrength ?? 0.5));
  for(let y=y0;y<y1;y++){
    for(let x=0;x<w;x++){
  const j = ((y - y0)*w + x) * 4; // strip-local index for source slice
  let r = srcArr[j], g = srcArr[j+1], b = srcArr[j+2];
      if(mode==='ordered4' || mode==='ordered8'){
        const t = ((M[y%size][x%size] / denom) - 0.5) * (strength);
        r = clamp255(r + t); g = clamp255(g + t); b = clamp255(b + t);
      }
      const idx = nearestIdx(r,g,b, prep, distance, lut);
      const o = ((y - y0)*w + x) * 4;
      outStrip[o]   = prep.pr[idx];
      outStrip[o+1] = prep.pg[idx];
      outStrip[o+2] = prep.pb[idx];
      outStrip[o+3] = 255;
    }
  }
  return outStrip.buffer;
}

function doDiffusion(job: QuantizeJob){
  const { width:w, height:h, palette, distance, mode, serpentine, src } = job;
  const srcArr = new Uint8ClampedArray(src);
  const out = new Uint8ClampedArray(w*h*4);
  const prep = buildPalettePrepared(palette, distance);
  const lut = makeLUT(job.cacheBits ?? 5);
  const buf = new Float32Array(w*h*3);
  const weightsFS = [ [1,0,7/16], [-1,1,3/16], [0,1,5/16], [1,1,1/16] ] as const;
  const weightsAtk = [ [1,0,1/8], [2,0,1/8], [-1,1,1/8], [0,1,1/8], [1,1,1/8], [0,2,1/8] ] as const;
  const weights = mode==='atkinson'? weightsAtk : weightsFS;
  for(let y=0;y<h;y++){
    const dir = (serpentine && (y%2===1))? -1 : 1;
    const xStart = dir===1? 0 : w-1; const xEnd = dir===1? w : -1;
    for(let x=xStart; x!==xEnd; x+=dir){
      const idx = y*w + x; const i = idx*4; const bIdx = idx*3;
      let r = srcArr[i]   + buf[bIdx];
      let g = srcArr[i+1] + buf[bIdx+1];
      let b = srcArr[i+2] + buf[bIdx+2];
      r = clamp255(r); g = clamp255(g); b = clamp255(b);
      const pi = nearestIdx(r,g,b, prep, distance, lut);
      out[i] = prep.pr[pi]; out[i+1] = prep.pg[pi]; out[i+2] = prep.pb[pi]; out[i+3]=255;
      const er = r - prep.pr[pi]; const eg = g - prep.pg[pi]; const eb = b - prep.pb[pi];
      for(const [dx,dy,f] of weights){
        const nx = x + dx*dir; const ny = y + dy; if(nx<0||nx>=w||ny<0||ny>=h) continue;
        const n = (ny*w + nx) * 3; buf[n]   += er*f; buf[n+1] += eg*f; buf[n+2] += eb*f;
      }
    }
  }
  return out.buffer;
}

self.onmessage = (e: MessageEvent<QuantizeJob>) => {
  const job = e.data;
  try{
    let outBuf: ArrayBuffer;
    if(job.mode==='none' || job.mode==='ordered4' || job.mode==='ordered8'){
      outBuf = doNoneOrOrdered(job);
    } else {
      outBuf = doDiffusion(job);
    }
    const yStart = job.yStart ?? 0; const yEnd = job.yEnd ?? job.height;
    const result: QuantizeResult = { yStart, yEnd, out: outBuf };
    (self as any).postMessage(result, [result.out]);
  }catch(err){
    (self as any).postMessage({ error: String(err) });
  }
};
