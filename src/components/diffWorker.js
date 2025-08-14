// Web Worker script for parallel processing of computeDiffs
self.onmessage = function (event) {
  const imgData = event.data;
  const { width: w, height: h, data } = imgData;
  const diffX = new Float64Array(w - 1);
  const diffY = new Float64Array(h - 1);

  for (let y = 0; y < h; y++) {
    let rowIdx = y * w * 4;
    for (let x = 0; x < w - 1; x++) {
      const i = rowIdx + x * 4;
      const j = i + 4;
      diffX[x] += Math.abs(data[i] - data[j]) + Math.abs(data[i + 1] - data[j + 1]) + Math.abs(data[i + 2] - data[j + 2]);
    }
  }

  for (let y = 0; y < h - 1; y++) {
    let rowIdx = y * w * 4;
    let nextRowIdx = (y + 1) * w * 4;
    for (let x = 0; x < w; x++) {
      const i = rowIdx + x * 4;
      const j = nextRowIdx + x * 4;
      diffY[y] += Math.abs(data[i] - data[j]) + Math.abs(data[i + 1] - data[j + 1]) + Math.abs(data[i + 2] - data[j + 2]);
    }
  }

  for (let x = 0; x < diffX.length; x++) diffX[x] /= h;
  for (let y = 0; y < diffY.length; y++) diffY[y] /= w;

  self.postMessage({ diffX, diffY });
};
