import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FULL_PALETTE, FREE_COLOR_SET, hexToRGB } from './palette';
import type { BuildResult } from './imageUtils';
import { rebuildBase, posterize, drawToCanvas, downloadCanvasPNG, downloadImageDataPNG, quantizeToPaletteAdvancedFast } from './imageUtils';

// Utility to adjust saturation and contrast (percent values where 100 = unchanged)
function applySaturationContrast(img: ImageData, saturationPct: number, contrastPct: number){
  if(saturationPct === 100 && contrastPct === 100) return img; // no change
  const out = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  const data = out.data;
  const satFactor = saturationPct / 100; // 0 = grayscale, 2 = 200%
  const contrastFactor = contrastPct / 100; // 1 = unchanged
  for(let i=0;i<data.length;i+=4){
    let r=data[i], g=data[i+1], b=data[i+2];
    // Saturation: interpolate from luminance
    const gray = 0.299*r + 0.587*g + 0.114*b;
    r = gray + (r - gray) * satFactor;
    g = gray + (g - gray) * satFactor;
    b = gray + (b - gray) * satFactor;
    // Contrast around mid-point 128
    r = (r - 128) * contrastFactor + 128;
    g = (g - 128) * contrastFactor + 128;
    b = (b - 128) * contrastFactor + 128;
    // Clamp
    data[i] = r < 0 ? 0 : r > 255 ? 255 : r;
    data[i+1] = g < 0 ? 0 : g > 255 ? 255 : g;
    data[i+2] = b < 0 ? 0 : b > 255 ? 255 : b;
  }
  return out;
}

export default function PixelArtCreator(){
  const [imageURL, setImageURL] = useState<string | null>(null);
  const [imgEl, setImgEl] = useState<HTMLImageElement | null>(null);
  const [imgData, setImgData] = useState<ImageData | null>(null);
  const [pixelSize, setPixelSize] = useState(8);
  const [posterizeBits, setPosterizeBits] = useState(8);
  const [reveal, setReveal] = useState(50);
  // New adjustments
  const [saturation, setSaturation] = useState(100); // 0-200
  const [contrast, setContrast] = useState(100); // 0-200
  const [usePalette, setUsePalette] = useState(true);
  const [enabledColors, setEnabledColors] = useState<boolean[]>(() => FULL_PALETTE.map(()=>true));
  const toggleColor = (i:number)=> setEnabledColors(p=>p.map((v,idx)=> idx===i? !v : v));
  const enableAllColors = () => setEnabledColors(FULL_PALETTE.map(()=>true));
  const applyFreeColors = () => setEnabledColors(FULL_PALETTE.map(c=>FREE_COLOR_SET.has(c)));
  const disableAll = () => setEnabledColors(FULL_PALETTE.map(()=>false));
  const activePaletteRGB = useMemo(()=>{ if(!usePalette) return [] as {r:number;g:number;b:number;}[]; return FULL_PALETTE.filter((_,i)=>enabledColors[i]).map(hexToRGB); },[usePalette, enabledColors]);
  const afterCanvasRef = useRef<HTMLCanvasElement>(null); const baseCanvasRef = useRef<HTMLCanvasElement>(null);
  const [build, setBuild] = useState<BuildResult | null>(null);
  // Dithering controls (now in a dedicated tab)
  const [dither, setDither] = useState<'none'|'floyd-steinberg'|'ordered4'|'ordered8'|'atkinson'>('floyd-steinberg');
  const [distance, setDistance] = useState<'rgb'|'oklab'>('oklab');
  const [orderedStrength, setOrderedStrength] = useState(50); // 0..100
  const [serpentine, setSerpentine] = useState(true);
  const onFile = (file:File) => { const url = URL.createObjectURL(file); setImageURL(url); };
  useEffect(()=>{ if(!imageURL) return; const img=new Image(); img.onload=()=>setImgEl(img); img.onerror=()=>{ alert('Failed to load image'); setImageURL(null); }; img.src=imageURL; return ()=>{ URL.revokeObjectURL(imageURL); }; },[imageURL]);
  useEffect(()=>{ if(!imgEl) return; const c=document.createElement('canvas'); c.width=imgEl.naturalWidth; c.height=imgEl.naturalHeight; const ctx=c.getContext('2d')!; ctx.imageSmoothingEnabled=false; ctx.drawImage(imgEl,0,0); const data=ctx.getImageData(0,0,c.width,c.height); setImgData(data); setBuild(null); },[imgEl]);
  useEffect(()=>{ if(!imgData) return; const p=Math.max(1,pixelSize); const built=rebuildBase(imgData,p,p,0,0); setBuild(built); },[imgData,pixelSize]);
  // Async fast path with workers
  const [processedBase, setProcessedBase] = useState<ImageData | null>(null);
  useEffect(()=>{
    let alive = true; (async ()=>{
      if(!build){ setProcessedBase(null); return; }
      let img = posterizeBits < 8 ? posterize(build.baseImageData, posterizeBits) : build.baseImageData;
      img = applySaturationContrast(img, saturation, contrast);
      if(activePaletteRGB.length){
        const opts = { dithering: dither, distance, orderedStrength: orderedStrength/100, serpentine } as const;
        // Use workers for all modes; it's faster and non-blocking
        img = await quantizeToPaletteAdvancedFast(img, activePaletteRGB, opts);
      }
      if(alive) setProcessedBase(img);
    })();
    return ()=>{ alive = false; };
  }, [build, posterizeBits, activePaletteRGB, saturation, contrast, dither, distance, orderedStrength, serpentine]);
  const fullPixelated = useMemo(()=>{ if(!processedBase || !imgData || !build) return null; const { width: fullW, height: fullH } = imgData; const { wOut, hOut } = build.crop; const out=new ImageData(fullW, fullH); const baseData=processedBase.data; const outData=out.data; for(let y=0;y<fullH;y++){ const by=Math.min(hOut-1, Math.floor(y / pixelSize)); for(let x=0;x<fullW;x++){ const bx=Math.min(wOut-1, Math.floor(x / pixelSize)); const bi=(by*wOut+bx)*4; const oi=(y*fullW+x)*4; outData[oi]=baseData[bi]; outData[oi+1]=baseData[bi+1]; outData[oi+2]=baseData[bi+2]; outData[oi+3]=255; }} return out; },[processedBase,imgData,build,pixelSize]);
  useEffect(()=>{ if(!imgEl || !fullPixelated) return; const w=imgEl.naturalWidth; const h=imgEl.naturalHeight; if(afterCanvasRef.current){ const canvas=afterCanvasRef.current; canvas.width=w; canvas.height=h; const ctx=canvas.getContext('2d')!; ctx.clearRect(0,0,w,h); ctx.imageSmoothingEnabled=false; const off=document.createElement('canvas'); off.width=fullPixelated.width; off.height=fullPixelated.height; off.getContext('2d')!.putImageData(fullPixelated,0,0); ctx.drawImage(off,0,0); } },[imgEl,fullPixelated]);
  useEffect(()=>{ if(!processedBase || !baseCanvasRef.current) return; 
    // Compute a scale that only upsizes small pixel grids, never forces a minimum 2x.
    // If the pixel base is larger than the preview target, we render at 1x (no extra enlargement).
    const maxPreview = 512; // target max dimension in CSS pixels for upscaling small bases
    const maxDim = Math.max(processedBase.width, processedBase.height);
    let scale = Math.floor(maxPreview / maxDim); // integer upscale factor for small images
    if (scale < 1) scale = 1; // never downscale here; rely on CSS to fit large images
    if (scale > 16) scale = 16; // cap excessive enlargement
    drawToCanvas(baseCanvasRef.current, processedBase, scale);
  },[processedBase]);
  const handleExportBase = () => { if(!processedBase) return; downloadImageDataPNG(processedBase, `pixelcreator_base_${processedBase.width}x${processedBase.height}.png`); };
  const handleExportUpscaled = () => { if(!afterCanvasRef.current) return; downloadCanvasPNG(afterCanvasRef.current, `pixelcreator_upscaled_${imgEl?.naturalWidth}x${imgEl?.naturalHeight}.png`); };
  const onDrop = (e:React.DragEvent) => { e.preventDefault(); const file=e.dataTransfer.files?.[0]; if(file) onFile(file); };
  const onSelectFile = (e:React.ChangeEvent<HTMLInputElement>) => { const file=e.target.files?.[0]; if(file) onFile(file); };
  return (
    <main className="max-w-7xl mx-auto px-4 py-6 grid gap-6">
      {!imageURL && (
        <div onDrop={onDrop} onDragOver={(e)=>e.preventDefault()} className="border-2 border-dashed border-zinc-700 rounded-2xl p-10 text-center grid place-items-center bg-zinc-900/40">
          <div className="space-y-4">
            <div className="text-lg">Drop an image here</div>
            <div className="text-zinc-400 text-sm">Or click to choose a file</div>
            <label className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 cursor-pointer">
              <input type="file" accept="image/*" className="hidden" onChange={onSelectFile}/>
              <span>Choose image</span>
            </label>
            <p className="text-xs text-zinc-500">Adjust Pixel Size slider to pixelate your image.</p>
          </div>
        </div>
      )}
      {imageURL && imgEl && imgData && (
        <div className="flex flex-col md:flex-row gap-6">
          {/* Left control column */}
          <aside className="md:w-80 flex-shrink-0 space-y-4 md:sticky md:top-4 self-start">
            {/* Pixelate panel */}
            <div className="rounded-2xl border border-zinc-800 p-4 bg-zinc-900/40">
              <h2 className="font-medium mb-3">Pixelate</h2>
              <div className="text-sm space-y-4">
                <div>
                  <label className="text-zinc-400 block">Pixel size (block px)</label>
                  <input type="range" min={1} max={128} value={pixelSize} onChange={e=>setPixelSize(parseInt(e.target.value))} className="w-full"/>
                  <div className="text-zinc-400">{pixelSize} px</div>
                </div>
                <div>
                  <label className="text-zinc-400 block">Posterize (bits / channel)</label>
                  <input type="range" min={2} max={8} value={posterizeBits} onChange={e=>setPosterizeBits(parseInt(e.target.value))} className="w-full"/>
                  <div className="text-zinc-400">{posterizeBits} bits</div>
                </div>
                <div>
                  <label className="text-zinc-400 block">Saturation</label>
                  <input type="range" min={0} max={200} value={saturation} onChange={e=>setSaturation(parseInt(e.target.value))} className="w-full"/>
                  <div className="text-zinc-400">{saturation}%</div>
                </div>
                <div>
                  <label className="text-zinc-400 block">Contrast</label>
                  <input type="range" min={0} max={200} value={contrast} onChange={e=>setContrast(parseInt(e.target.value))} className="w-full"/>
                  <div className="text-zinc-400">{contrast}%</div>
                </div>
                <div className="flex items-center gap-2 text-xs pt-2 border-t border-zinc-800/60">
                  <label className="flex items-center gap-1 cursor-pointer select-none">
                    <input type="checkbox" className="accent-blue-600" checked={usePalette} onChange={e=>setUsePalette(e.target.checked)}/>
                    <span className="text-zinc-300">Use palette</span>
                  </label>
                </div>
              </div>
            </div>
            {/* Palette panel */}
            <div className="rounded-2xl border border-zinc-800 p-4 bg-zinc-900/40 overflow-hidden">
              <h2 className="font-medium mb-3">Palette</h2>
              <div className="flex flex-wrap items-center gap-2 mb-3 text-xs">
                <button onClick={applyFreeColors} className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700" title="Enable only free colors">Only free</button>
                <button onClick={enableAllColors} className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700" title="Enable all colors">All</button>
                <button onClick={disableAll} className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700" title="Disable all colors">None</button>
              </div>
              <div className="grid grid-cols-8 gap-2">
                {FULL_PALETTE.map((hex,i)=>{ const enabled=enabledColors[i]; return (
                  <button key={i} onClick={()=>toggleColor(i)} className={`w-6 h-6 rounded border border-zinc-700 relative ${enabled ? '' : 'opacity-30 grayscale'} focus:outline-none focus:ring-2 focus:ring-blue-500`} style={{backgroundColor:hex}} title={hex + (enabled ? '' : ' (disabled)')}>
                    {!enabled && <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-zinc-200">×</span>}
                  </button>
                ); })}
              </div>
              <p className="mt-3 text-[10px] leading-snug text-zinc-400">Toggle colors to constrain quantization. Only enabled colors are used.</p>
            </div>
            {/* Dithering panel */}
            <div className="rounded-2xl border border-zinc-800 p-4 bg-zinc-900/40 overflow-hidden">
              <h2 className="font-medium mb-3">Dithering</h2>
              <div className="space-y-4 text-sm">
                <div>
                  <label className="text-zinc-400 block mb-1">Dithering method</label>
                  <select value={dither} onChange={e=>setDither(e.target.value as any)} className="w-full bg-zinc-800 rounded px-2 py-1">
                    <option value="floyd-steinberg">Floyd–Steinberg</option>
                    <option value="atkinson">Atkinson</option>
                    <option value="ordered4">Ordered 4×4</option>
                    <option value="ordered8">Ordered 8×8</option>
                    <option value="none">None</option>
                  </select>
                </div>
                <div>
                  <label className="text-zinc-400 block mb-1">Perceptual distance</label>
                  <select value={distance} onChange={e=>setDistance(e.target.value as any)} className="w-full bg-zinc-800 rounded px-2 py-1">
                    <option value="oklab">OKLab (recommended)</option>
                    <option value="rgb">RGB</option>
                  </select>
                </div>
                {(dither==='ordered4'||dither==='ordered8') && (
                  <div>
                    <label className="text-zinc-400 block">Ordered strength</label>
                    <input type="range" min={0} max={100} value={orderedStrength} onChange={e=>setOrderedStrength(parseInt(e.target.value))} className="w-full"/>
                    <div className="text-zinc-400">{orderedStrength}%</div>
                  </div>
                )}
                {(dither==='floyd-steinberg'||dither==='atkinson') && (
                  <div className="flex items-center gap-2 text-xs pt-2 border-t border-zinc-800/60">
                    <label className="flex items-center gap-1 cursor-pointer select-none">
                      <input type="checkbox" className="accent-blue-600" checked={serpentine} onChange={e=>setSerpentine(e.target.checked)}/>
                      <span className="text-zinc-300">Serpentine scan</span>
                    </label>
                  </div>
                )}
                <p className="text-[10px] leading-snug text-zinc-400">Dithering and quantization are applied to the palette step. Floyd–Steinberg is recommended for smooth gradients; Ordered for crisp pixel patterns.</p>
              </div>
            </div>
            {/* Export panel */}
            <div className="rounded-2xl border border-zinc-800 p-4 bg-zinc-900/40 grid content-start gap-3">
              <h2 className="font-medium">Export</h2>
              <div className="flex flex-wrap gap-3">
                <button onClick={handleExportBase} className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-sm">Base PNG</button>
                <button onClick={handleExportUpscaled} className="px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-sm">Pixelated PNG</button>
              </div>
              <p className="text-xs text-zinc-400">Base = native pixel grid. Upscaled = original size. {usePalette && `Palette (${activePaletteRGB.length} colors).`}</p>
            </div>
          </aside>
          {/* Right preview column */}
          <section className="flex-1 space-y-6">
            {/* Before / After viewer */}
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 overflow-hidden">
              <div className="p-3 flex items-center justify-between text-sm text-zinc-300">
                <div>Original</div>
                <div>Pixelated</div>
              </div>
              <div className="relative">
                <div className="w-full overflow-auto">
                  <div className="relative inline-block w-full" style={{ aspectRatio: imgEl!.naturalWidth + ' / ' + imgEl!.naturalHeight }}>
                    <img src={imageURL} alt="original" className="block w-full h-auto select-none" draggable={false}/>
                  </div>
                </div>
                <div className="pointer-events-none absolute inset-0">
                  <div className="relative w-full h-full">
                    <canvas ref={afterCanvasRef} className="absolute top-0 left-0" style={{ width: '100%', height: '100%', imageRendering: 'pixelated' as any, clipPath: `inset(0 ${100 - reveal}% 0 0)` }}/>
                  </div>
                </div>
                <div className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-zinc-900/80 backdrop-blur px-3 py-2 rounded-xl border border-zinc-800">
                  <div className="flex items-center gap-2 text-xs text-zinc-300">
                    <span>Reveal</span>
                    <input type="range" min={0} max={100} value={reveal} onChange={e=>setReveal(parseInt(e.target.value))}/>
                    <span>{reveal}%</span>
                  </div>
                </div>
              </div>
            </div>
            {/* Base canvas preview */}
            <div className="rounded-2xl border border-zinc-800 p-4 bg-zinc-900/40">
              <h2 className="font-medium mb-3">Pixel base ({build?.baseImageData.width} x {build?.baseImageData.height})</h2>
              <canvas ref={baseCanvasRef} className="block rounded-xl border border-zinc-800 mx-auto" style={{ imageRendering: 'pixelated' as any, width:'100%', height:'auto' }}/>
            </div>
          </section>
        </div>
      )}
      <div className="text-center text-xs text-zinc-500 py-6">Create pixel-art by pixelating any image.</div>
    </main>
  );
}
