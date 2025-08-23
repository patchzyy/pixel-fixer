import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FULL_PALETTE, FREE_COLOR_SET, hexToRGB } from './palette';
import type { BuildResult, DetectResult } from './imageUtils';
import { computeDiffs, detectAxis, rebuildBase, posterize, drawGridOverlay, drawToCanvas, downloadCanvasPNG, downloadImageDataPNG, quantizeToPaletteAdvancedFast, unsharpMask, addNoise } from './imageUtils';

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

// Helper function to format time in human-readable units
const formatTime = (totalSeconds: number): string => {
  if (totalSeconds < 60) {
    return `${Math.round(totalSeconds)} second${totalSeconds === 1 ? '' : 's'}`;
  } else if (totalSeconds < 3600) { // Less than 1 hour
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.round(totalSeconds % 60);
    return `${minutes} minute${minutes === 1 ? '' : 's'}${seconds > 0 ? ` and ${seconds} second${seconds === 1 ? '' : 's'}` : ''}`;
  } else if (totalSeconds < 86400) { // Less than 1 day
    const hours = Math.floor(totalSeconds / 3600);
    const remainingMinutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.round(totalSeconds % 60);
    let result = `${hours} hour${hours === 1 ? '' : 's'}`;
    if (remainingMinutes > 0) {
      result += ` and ${remainingMinutes} minute${remainingMinutes === 1 ? '' : 's'}`;
    }
    if (seconds > 0 && remainingMinutes === 0) {
      result += ` and ${seconds} second${seconds === 1 ? '' : 's'}`;
    }
    return result;
  } else { // Days or more
    const days = Math.floor(totalSeconds / 86400);
    const remainingHours = Math.floor((totalSeconds % 86400) / 3600);
    const remainingMinutes = Math.floor((totalSeconds % 3600) / 60);
    let result = `${days} day${days === 1 ? '' : 's'}`;
    if (remainingHours > 0) {
      result += ` and ${remainingHours} hour${remainingHours === 1 ? '' : 's'}`;
    }
    if (remainingMinutes > 0 && remainingHours === 0) {
      result += ` and ${remainingMinutes} minute${remainingMinutes === 1 ? '' : 's'}`;
    }
    return result;
  }
};

export default function PixelArtRecoverer(){
  const [imageURL, setImageURL] = useState<string | null>(null);
  const [imgEl, setImgEl] = useState<HTMLImageElement | null>(null);
  const [imgData, setImgData] = useState<ImageData | null>(null);
  const [diffs, setDiffs] = useState<{ diffX: Float64Array; diffY: Float64Array } | null>(null);
  const [autoMaxScale, setAutoMaxScale] = useState(64);
  const [detected, setDetected] = useState<DetectResult | null>(null);
  const [sX, setSX] = useState(8); const [sY, setSY] = useState(8); const [dX, setDX] = useState(0); const [dY, setDY] = useState(0);
  const [posterizeBits, setPosterizeBits] = useState(8);
  const [overlayGrid, setOverlayGrid] = useState(true);
  const [reveal, setReveal] = useState(50);

  // New adjustments similar to PixelArtCreator
  const [saturation, setSaturation] = useState(100); // 0-200
  const [contrast, setContrast] = useState(100); // 0-200

  // Advanced settings
  const [dither, setDither] = useState<'none'|'floyd-steinberg'|'ordered4'|'ordered8'|'atkinson'>('none');
  const [ditherAmount, setDitherAmount] = useState(100);
  const [mode, setMode] = useState<'artwork'|'photo'>('artwork');
  const [distance, setDistance] = useState<'rgb'|'oklab'>('oklab');
  const [orderedStrength, setOrderedStrength] = useState(50);
  const [serpentine, setSerpentine] = useState(true);
  const [gamma, setGamma] = useState(100);
  const [sharpenAmt, setSharpenAmt] = useState(0);
  const [sharpenRadius, setSharpenRadius] = useState(1);
  const [noiseAmt, setNoiseAmt] = useState(0);

  const [usePalette, setUsePalette] = useState(true);
  const [enabledColors, setEnabledColors] = useState<boolean[]>(() => FULL_PALETTE.map(()=>true));
  const toggleColor = (i:number)=> setEnabledColors(p=>p.map((v,idx)=> idx===i? !v : v));
  const enableAllColors = () => setEnabledColors(FULL_PALETTE.map(()=>true));
  const applyFreeColors = () => setEnabledColors(FULL_PALETTE.map(c=>FREE_COLOR_SET.has(c)));
  const disableAll = () => setEnabledColors(FULL_PALETTE.map(()=>false));
  const activePaletteRGB = useMemo(()=>{ if(!usePalette) return [] as {r:number;g:number;b:number;}[]; return FULL_PALETTE.filter((_,i)=>enabledColors[i]).map(hexToRGB); },[usePalette, enabledColors]);
  const originalRef = useRef<HTMLDivElement>(null); const overlayCanvasRef = useRef<HTMLCanvasElement>(null); const afterCanvasRef = useRef<HTMLCanvasElement>(null); const baseCanvasRef = useRef<HTMLCanvasElement>(null);
  const [build, setBuild] = useState<BuildResult | null>(null);

  // Handler for mode change
  const handleModeChange = (newMode: 'artwork'|'photo') => {
    setMode(newMode);
    if (newMode === 'artwork') setDither('none');
    else setDither('floyd-steinberg');
  };

  const onFile = (file:File) => { const url = URL.createObjectURL(file); setImageURL(url); };

  // Listen for paste (Ctrl+V) to accept images from clipboard when no image is loaded.
  useEffect(() => {
    const handlePaste = async (e: any) => {
      try {
        if (imageURL) return; // ignore paste if an image is already loaded
        const clipboardData = e.clipboardData || (window as any).clipboardData;
        if (clipboardData && clipboardData.items) {
          for (let i = 0; i < clipboardData.items.length; i++) {
            const item = clipboardData.items[i];
            if (item && item.type && item.type.indexOf('image') === 0) {
              const blob = item.getAsFile();
              if (blob) {
                onFile(blob);
                e.preventDefault();
                return;
              }
            }
          }
        }
        // Fallback: try async clipboard API (may require permissions)
        if (navigator.clipboard && (navigator.clipboard as any).read) {
          try {
            const items = await (navigator.clipboard as any).read();
            for (const ci of items) {
              for (const type of ci.types) {
                if ((type as string).startsWith('image/')) {
                  const blob = await ci.getType(type);
                  onFile(new File([blob], 'pasted_image.' + (blob.type.split('/')[1] || 'png'), { type: blob.type }));
                  return;
                }
              }
            }
          } catch (err) {
            // ignore permission or read errors
          }
        }
      } catch (err) {
        // ignore
      }
    };
    window.addEventListener('paste', handlePaste as any);
    return () => window.removeEventListener('paste', handlePaste as any);
  }, [imageURL]);
  useEffect(()=>{ if(!imageURL) return; const img = new Image(); img.onload=()=>setImgEl(img); img.onerror=()=>{ alert('Failed to load image'); setImageURL(null); }; img.src = imageURL; return ()=>{ URL.revokeObjectURL(imageURL); }; },[imageURL]);
  useEffect(()=>{ if(!imgEl) return; const c=document.createElement('canvas'); c.width=imgEl.naturalWidth; c.height=imgEl.naturalHeight; const ctx=c.getContext('2d')!; ctx.imageSmoothingEnabled=false; ctx.drawImage(imgEl,0,0); const data=ctx.getImageData(0,0,c.width,c.height); setImgData(data); setBuild(null); setDetected(null); },[imgEl]);
  useEffect(()=>{ if(!imgData) return; setDiffs(computeDiffs(imgData)); },[imgData]);
  useEffect(()=>{ if(!diffs || !imgData) return; const w=imgData.width; const h=imgData.height; const maxS=Math.min(autoMaxScale, Math.max(2, Math.floor(Math.min(w,h)/4))); const bx=detectAxis(diffs.diffX, maxS); const by=detectAxis(diffs.diffY, maxS); const result: DetectResult = { sX: bx.s, sY: by.s, dX: bx.d, dY: by.d, ratioX: bx.ratio, ratioY: by.ratio } as any; setDetected(result); setSX(result.sX); setSY(result.sY); setDX(result.dX); setDY(result.dY); },[diffs,imgData,autoMaxScale]);
  useEffect(()=>{ if(!imgData) return; const built = rebuildBase(imgData, sX, sY, dX, dY); setBuild(built); },[imgData,sX,sY,dX,dY]);

  // Async fast path with workers and advanced processing
  const [processedBase, setProcessedBase] = useState<ImageData | null>(null);
  useEffect(()=>{
    let alive = true; (async ()=>{
      if(!build){ setProcessedBase(null); return; }
      let img = posterizeBits < 8 ? posterize(build.baseImageData, posterizeBits) : build.baseImageData;
      img = applySaturationContrast(img, saturation, contrast);
      // Gamma adjust before quantization (perceptual brightness shaping)
      if(gamma !== 100){
        const g = Math.max(10, Math.min(300, gamma)) / 100; // 0.1..3.0
        const lut = new Uint8ClampedArray(256);
        for(let i=0;i<256;i++){ const n=i/255; lut[i]=Math.max(0, Math.min(255, Math.round(Math.pow(n, 1/g)*255))); }
        const d = new Uint8ClampedArray(img.data);
        for(let i=0;i<d.length;i+=4){ d[i]=lut[d[i]]; d[i+1]=lut[d[i+1]]; d[i+2]=lut[d[i+2]]; }
        img = new ImageData(d, img.width, img.height);
      }
      // Optional pre-quantization sharpening
      if(sharpenAmt>0){ img = unsharpMask(img, sharpenRadius, sharpenAmt/100*2); }
      if(activePaletteRGB.length){
        const opts = { dithering: dither, distance, orderedStrength: orderedStrength/100, serpentine, ditherAmount: Math.max(0, Math.min(1, ditherAmount/100)) } as const;
        img = await quantizeToPaletteAdvancedFast(img, activePaletteRGB, opts);
      }
      // Optional post-quantization film grain
      if(noiseAmt>0){ img = addNoise(img, noiseAmt, activePaletteRGB); }
      if(alive) setProcessedBase(img);
    })();
    return ()=>{ alive = false; };
  }, [build, posterizeBits, activePaletteRGB, saturation, contrast, dither, distance, orderedStrength, serpentine, ditherAmount, gamma, sharpenAmt, sharpenRadius, noiseAmt]);
  const fullPixelated = useMemo(()=>{ if(!processedBase || !imgData || !build) return null; const { width:fullW, height:fullH } = imgData; const { x0,y0,wOut,hOut } = build.crop; const out=new ImageData(fullW,fullH); const baseData=processedBase.data; const outData=out.data; for(let y=0;y<fullH;y++){ let localY=y-y0; if(localY<0) localY=0; else if(localY>=hOut*sY) localY=hOut*sY-1; const by=Math.floor(localY/sY); for(let x=0;x<fullW;x++){ let localX=x-x0; if(localX<0) localX=0; else if(localX>=wOut*sX) localX=wOut*sX-1; const bx=Math.floor(localX/sX); const bi=(by*wOut+bx)*4; const oi=(y*fullW+x)*4; outData[oi]=baseData[bi]; outData[oi+1]=baseData[bi+1]; outData[oi+2]=baseData[bi+2]; outData[oi+3]=255; }} return out; },[processedBase,imgData,build,sX,sY]);
  useEffect(()=>{ if(!imgEl || !build || !fullPixelated) return; const w=imgEl.naturalWidth; const h=imgEl.naturalHeight; if(overlayCanvasRef.current){ if(overlayGrid) drawGridOverlay(overlayCanvasRef.current,w,h,sX,sY,dX,dY); else { const c=overlayCanvasRef.current; c.width=w; c.height=h; c.getContext('2d')!.clearRect(0,0,w,h); } } if(afterCanvasRef.current){ const canvas=afterCanvasRef.current; canvas.width=w; canvas.height=h; const ctx=canvas.getContext('2d')!; ctx.clearRect(0,0,w,h); ctx.imageSmoothingEnabled=false; const off=document.createElement('canvas'); off.width=fullPixelated.width; off.height=fullPixelated.height; off.getContext('2d')!.putImageData(fullPixelated,0,0); ctx.drawImage(off,0,0); } },[imgEl,build,fullPixelated,sX,sY,dX,dY,overlayGrid]);
  useEffect(()=>{ if(!processedBase || !baseCanvasRef.current) return; const previewScale=Math.max(2, Math.floor(512 / Math.max(processedBase.width, processedBase.height))); drawToCanvas(baseCanvasRef.current, processedBase, previewScale); },[processedBase]);
  const handleExportBase = () => { if(!processedBase) return; downloadImageDataPNG(processedBase, `pixelart_base_${processedBase.width}x${processedBase.height}.png`); };
  const handleExportUpscaled = () => { if(!afterCanvasRef.current) return; downloadCanvasPNG(afterCanvasRef.current, `pixelart_upscaled_${imgEl?.naturalWidth}x${imgEl?.naturalHeight}.png`); };
  const onDrop = (e:React.DragEvent) => { e.preventDefault(); const file=e.dataTransfer.files?.[0]; if(file) onFile(file); };
  const onSelectFile = (e:React.ChangeEvent<HTMLInputElement>) => { const file=e.target.files?.[0]; if(file) onFile(file); };

  // Collapsible panel states
  const [isDetectionCollapsed, setIsDetectionCollapsed] = useState(false);
  const [isTweakCollapsed, setIsTweakCollapsed] = useState(false);
  const [isPaletteCollapsed, setIsPaletteCollapsed] = useState(false);
  const [isAdvancedCollapsed, setIsAdvancedCollapsed] = useState(false);

  const toggleCollapse = (section: 'detection' | 'tweak' | 'palette' | 'advanced') => {
    if (section === 'detection') setIsDetectionCollapsed(!isDetectionCollapsed);
    if (section === 'tweak') setIsTweakCollapsed(!isTweakCollapsed);
    if (section === 'palette') setIsPaletteCollapsed(!isPaletteCollapsed);
    if (section === 'advanced') setIsAdvancedCollapsed(!isAdvancedCollapsed);
  };

  return (
    <main className="max-w-7xl mx-auto px-4 py-6 grid gap-6">
      {!imageURL && (
        <div onDrop={onDrop} onDragOver={(e)=>e.preventDefault()} className="border-2 border-dashed border-zinc-700 rounded-2xl p-10 text-center grid place-items-center bg-zinc-900/40">
          <div className="space-y-4">
            <div className="text-lg">Drop an image here</div>
            <div className="text-zinc-400 text-sm">Or click to choose a file or press Ctrl+V to paste from clipboard</div>
            <label className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 cursor-pointer">
              <input type="file" accept="image/*" className="hidden" onChange={onSelectFile}/>
              <span>Choose image</span>
            </label>
            <p className="text-xs text-zinc-500">Tip: works best if the source was scaled with nearest-neighbor</p>
          </div>
        </div>
      )}{imageURL && imgEl && imgData && (<><div className="grid gap-4 md:grid-cols-3"><div className="rounded-2xl border border-zinc-800 p-4 bg-zinc-900/40"><h2 className="font-medium mb-3">Detection</h2><div className="grid sm:grid-cols-2 gap-3 text-sm"><div><label className="text-zinc-400">Max scale to search</label><input type="range" min={2} max={128} value={autoMaxScale} onChange={e=>setAutoMaxScale(parseInt(e.target.value))} className="w-full"/><div className="text-zinc-400">{autoMaxScale} px</div></div><div className="flex items-end"><button onClick={()=>{ if(!diffs || !imgData) return; const w=imgData.width; const h=imgData.height; const maxS=Math.min(autoMaxScale, Math.max(2, Math.floor(Math.min(w,h)/4))); const bx=detectAxis(diffs.diffX,maxS); const by=detectAxis(diffs.diffY,maxS); const result: DetectResult = { sX: bx.s, sY: by.s, dX: bx.d, dY: by.d, ratioX: bx.ratio, ratioY: by.ratio } as any; setDetected(result); setSX(result.sX); setSY(result.sY); setDX(result.dX); setDY(result.dY); }} className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500">Re-detect</button></div></div>{detected && <div className="mt-3 text-xs text-zinc-400">Auto: sX {detected.sX}, dX {detected.dX}, sY {detected.sY}, dY {detected.dY}</div>}</div><div className="rounded-2xl border border-zinc-800 p-4 bg-zinc-900/40"><h2 className="font-medium mb-3">Tweak</h2><div className="grid sm:grid-cols-2 gap-4 text-sm"><div><label className="text-zinc-400">Scale X (px)</label><input type="range" min={1} max={128} value={sX} onChange={e=>setSX(parseInt(e.target.value))} className="w-full"/><div className="text-zinc-400">{sX}</div></div><div><label className="text-zinc-400">Offset X</label><input type="range" min={0} max={Math.max(0, sX-1)} value={dX} onChange={e=>setDX(parseInt(e.target.value))} className="w-full"/><div className="text-zinc-400">{dX}</div></div><div><label className="text-zinc-400">Scale Y (px)</label><input type="range" min={1} max={128} value={sY} onChange={e=>setSY(parseInt(e.target.value))} className="w-full"/><div className="text-zinc-400">{sY}</div></div><div><label className="text-zinc-400">Offset Y</label><input type="range" min={0} max={Math.max(0, sY-1)} value={dY} onChange={e=>setDY(parseInt(e.target.value))} className="w-full"/><div className="text-zinc-400">{dY}</div></div><div><label className="text-zinc-400">Posterize (bits per channel)</label><input type="range" min={2} max={8} value={posterizeBits} onChange={e=>setPosterizeBits(parseInt(e.target.value))} className="w-full"/><div className="text-zinc-400">{posterizeBits} bits</div></div><div className="flex items-center gap-2"><input id="grid" type="checkbox" className="accent-blue-600" checked={overlayGrid} onChange={e=>setOverlayGrid(e.target.checked)}/><label htmlFor="grid" className="text-zinc-200">Show grid overlay</label></div></div></div><div className="rounded-2xl border border-zinc-800 p-4 bg-zinc-900/40 overflow-hidden"><h2 className="font-medium mb-3">Palette</h2><div className="flex flex-wrap items-center gap-2 mb-3 text-xs"><label className="flex items-center gap-1 cursor-pointer select-none"><input type="checkbox" className="accent-blue-600" checked={usePalette} onChange={e=>setUsePalette(e.target.checked)}/><span className="text-zinc-300">Use palette</span></label><button onClick={applyFreeColors} className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700" title="Enable only free colors">Only free colors</button><button onClick={enableAllColors} className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700" title="Enable all colors">Use all colors</button><button onClick={disableAll} className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700" title="Disable all colors">None</button></div><div className="grid grid-cols-8 gap-2">{FULL_PALETTE.map((hex,i)=>{ const enabled=enabledColors[i]; return (<button key={i} onClick={()=>toggleColor(i)} className={`w-6 h-6 rounded border border-zinc-700 relative group ${enabled ? '' : 'opacity-30 grayscale'} focus:outline-none focus:ring-2 focus:ring-blue-500`} style={{backgroundColor:hex}} title={hex + (enabled ? '' : ' (disabled)')}>{!enabled && <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-zinc-200">×</span>}</button>); })}</div><p className="mt-3 text-[10px] leading-snug text-zinc-400">Click colors to enable/disable them. Only enabled colors are used when building the pixelated version.</p></div></div><div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 overflow-hidden"><div className="p-3 flex items-center justify-between text-sm text-zinc-300"><div>Before - Original</div><div>After - Rebuilt</div></div><div className="relative"><div ref={originalRef} className="w-full overflow-auto"><div className="relative inline-block w-full" style={{ aspectRatio: imgEl!.naturalWidth + ' / ' + imgEl!.naturalHeight }}><img src={imageURL} alt="original" className="block w-full h-auto select-none" draggable={false}/><canvas ref={overlayCanvasRef} className="absolute inset-0 w-full h-full" style={{ imageRendering: 'pixelated' as any }}/></div></div><div className="pointer-events-none absolute inset-0"><div className="relative w-full h-full"><canvas ref={afterCanvasRef} className="absolute top-0 left-0" style={{ width: '100%', height: '100%', imageRendering: 'pixelated' as any, clipPath: `inset(0 ${100 - reveal}% 0 0)` }}/></div></div><div className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-zinc-900/80 backdrop-blur px-3 py-2 rounded-xl border border-zinc-800"><div className="flex items-center gap-2 text-xs text-zinc-300"><span>Reveal</span><input type="range" min={0} max={100} value={reveal} onChange={e=>setReveal(parseInt(e.target.value))}/><span>{reveal}%</span></div></div></div></div><div className="grid md:grid-cols-2 gap-4"><div className="rounded-2xl border border-zinc-800 p-4 bg-zinc-900/40"><h2 className="font-medium mb-3">Recovered base ({build?.baseImageData.width} x {build?.baseImageData.height})</h2><canvas ref={baseCanvasRef} className="block rounded-xl border border-zinc-800 mx-auto" style={{ imageRendering: 'pixelated' as any }}/></div><div className="rounded-2xl border border-zinc-800 p-4 bg-zinc-900/40 grid content-start gap-3"><h2 className="font-medium">Export</h2><div className="flex flex-wrap gap-3"><button onClick={handleExportBase} className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500">Download base PNG</button><button onClick={handleExportUpscaled} className="px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500">Download upscaled overlay PNG</button></div><p className="text-xs text-zinc-400">The base PNG is the clean pixel-art at 1x scale. The upscaled overlay PNG matches the original dimensions and uses nearest-neighbor.{usePalette && ` Palette constraint (${activePaletteRGB.length} colors enabled).`}</p></div></div></>)}</main>
  );
}
