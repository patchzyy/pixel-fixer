// Shared palette constants and helpers
export const FULL_PALETTE = [
  '#000000','#3c3c3c','#787878','#aaaaaa','#d2d2d2','#ffffff',
  '#600018','#a50e1e','#ed1c24','#fa8072',
  '#e45c1a','#ff7f27','#f6aa09','#f9dd3b','#fffabc',
  '#9c8431','#c5ad31','#e8d45f',
  '#4a6b3a','#5a944a','#84c573','#0eb968','#13e67b','#87ff5e',
  '#0c816e','#10aea6','#13e1be','#0f799f','#60f7f2','#bbfaf2',
  '#28509e','#4093e4','#7dc7ff',
  '#4d31b8','#6b50f6','#99b1fb',
  '#4a4284','#7a71c4','#b5aef1',
  '#780c99','#aa38b9','#e09ff9',
  '#cb007a','#ec1f80','#f38da9',
  '#9b5249','#d18078','#fab6a4',
  '#684634','#95682a','#dba463',
  '#7b6352','#9c846b','#d6b594',
  '#d18051','#f8b277','#ffc5a5',
  '#6d643f','#948c6b','#cdc59e',
  '#333941','#6d758d','#b3b9d1'
];

export const FREE_COLORS = [
  '#000000','#3c3c3c','#787878','#d2d2d2','#ffffff',
  '#600018','#ed1c24','#ff7f27','#f6aa09','#f9dd3b','#fffabc',
  '#0eb968','#13e67b','#87ff5e','#0c816e','#10aea6','#13e1be',
  '#28509e','#4093e4','#60f7f2','#6b50f6','#99b1fb',
  '#780c99','#aa38b9','#e09ff9','#cb007a','#ec1f80','#f38da9',
  '#684634','#95682a','#f8b277'
];

export const FREE_COLOR_SET = new Set(FREE_COLORS);

export function hexToRGB(hex: string) { const h = hex.replace('#',''); return { r: parseInt(h.substring(0,2),16), g: parseInt(h.substring(2,4),16), b: parseInt(h.substring(4,6),16) }; }
