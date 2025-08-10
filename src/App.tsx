import { useState } from 'react';
import PixelArtRecoverer from './components/PixelArtRecoverer';
import PixelArtCreator from './components/PixelArtCreator';

function App(){
  const [mode, setMode] = useState<'recover' | 'create' | null>(null);
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="sticky top-0 z-10 backdrop-blur bg-zinc-950/70 border-b border-zinc-800">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            {mode && <button onClick={()=>setMode(null)} className="px-3 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-sm">Back</button>}
            <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">PixelArt Toolkit</h1>
          </div>
          <div className="text-xs sm:text-sm text-zinc-400">{mode === 'recover' ? 'Recoverer' : mode === 'create' ? 'Creator' : 'Choose a tool'}</div>
        </div>
      </header>
      {!mode && (
        <main className="max-w-4xl mx-auto px-4 py-16">
          <div className="grid gap-10 text-center">
            <h2 className="text-2xl font-semibold mb-2">Select a tool</h2>
            <div className="grid sm:grid-cols-2 gap-8">
              <button onClick={()=>setMode('create')} className="group rounded-2xl border border-zinc-800 bg-zinc-900/40 p-8 hover:border-blue-600 transition text-left">
                <div className="text-lg font-medium mb-2">Pixelart Creator</div>
                <p className="text-sm text-zinc-400">Pixelate any image with adjustable pixel size, posterize & palette.</p>
              </button>
              <button onClick={()=>setMode('recover')} className="group rounded-2xl border border-zinc-800 bg-zinc-900/40 p-8 hover:border-blue-600 transition text-left">
                <div className="text-lg font-medium mb-2">Pixelart Recoverer</div>
                <p className="text-sm text-zinc-400">Detect scale & offsets from a scaled pixel-art image and reconstruct the original.</p>
              </button>
            </div>
            <p className="text-xs text-zinc-500">Both tools share palette & export features.</p>
          </div>
        </main>
      )}
      {mode === 'recover' && <PixelArtRecoverer />}
      {mode === 'create' && <PixelArtCreator />}
    </div>
  );
}

export default App;
