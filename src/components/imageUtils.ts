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
