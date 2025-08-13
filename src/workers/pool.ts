// Lightweight worker pool for quantization jobs
import type { QuantizeJob, QuantizeResult } from './quantWorker.ts';

export interface PoolOptions { size?: number }

export class QuantPool {
  private workers: Worker[] = [];
  private idle: number[] = [];
  private queue: { job: QuantizeJob; resolve: (r:QuantizeResult)=>void; reject:(e:any)=>void }[] = [];

  constructor(size = Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2))){
    for(let i=0;i<size;i++){
      // Vite supports new URL('...', import.meta.url) worker loading
      const w = new Worker(new URL('./quantWorker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent) => {
        const payload = e.data as QuantizeResult & { error?: string };
        const task = this.current?.get(w);
        this.current?.delete(w);
        this.idle.push(this.workers.indexOf(w));
        if(!task) return;
        if((payload as any).error){ task.reject(new Error((payload as any).error)); }
        else task.resolve(payload);
        this.pump();
      };
      w.onerror = (e) => {
        const task = this.current?.get(w);
        this.current?.delete(w);
        this.idle.push(this.workers.indexOf(w));
        task?.reject(e);
        this.pump();
      };
      this.workers.push(w);
      this.idle.push(i);
    }
  }

  get size(){ return this.workers.length; }

  private current: Map<Worker, { job: QuantizeJob; resolve: (r:QuantizeResult)=>void; reject:(e:any)=>void }> = new Map();

  destroy(){ this.workers.forEach(w=>w.terminate()); this.workers = []; this.idle = []; this.queue=[]; this.current.clear(); }

  submit(job: QuantizeJob){
    return new Promise<QuantizeResult>((resolve,reject)=>{
      this.queue.push({ job, resolve, reject });
      this.pump();
    });
  }

  private pump(){
    while(this.idle.length && this.queue.length){
      const idx = this.idle.pop()!; const w = this.workers[idx];
      const t = this.queue.shift()!;
      this.current.set(w, t);
      // Transfer the src buffer to move data zero-copy
      const transfers: Transferable[] = [t.job.src];
      (w as any).postMessage(t.job, transfers);
    }
  }
}

export function paletteToFlat(palette: {r:number;g:number;b:number;}[]){
  const arr = new Uint8Array(palette.length*3);
  for(let i=0;i<palette.length;i++){ const p=palette[i]; const k=i*3; arr[k]=p.r; arr[k+1]=p.g; arr[k+2]=p.b; }
  return arr;
}
