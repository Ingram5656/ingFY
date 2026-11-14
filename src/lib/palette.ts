// 从专辑封面里提取主色，用于拾音灯、背景色块、进度条和歌词。

export const FALLBACK_PALETTE = ["#FF9BB3", "#FF6F91", "#E3579E", "#C34A9F", "#9B47B4", "#6F48C6"];

type RGB = [number, number, number];

function rgbToHsl([r, g, b]: RGB): RGB {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToHex([h, s, l]: RGB): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const hex = (x: number) => Math.round(x * 255).toString(16).padStart(2, "0");
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`.toUpperCase();
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/** k-means 取 k 个主色，调亮调饱和让它们适合发光，再按色相排序方便做渐变 */
export async function extractPalette(dataUrl: string, k = 6): Promise<string[]> {
  const img = await loadImage(dataUrl);
  const size = 48;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return FALLBACK_PALETTE;
  ctx.drawImage(img, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size).data;

  const pixels: RGB[] = [];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    pixels.push([data[i], data[i + 1], data[i + 2]]);
  }
  if (pixels.length < k) return FALLBACK_PALETTE;

  // 初始中心：均匀取样
  let centers: RGB[] = Array.from({ length: k }, (_, i) => [...pixels[Math.floor((i * pixels.length) / k)]] as RGB);
  let counts = new Array(k).fill(0);
  for (let iter = 0; iter < 10; iter++) {
    const sums: RGB[] = Array.from({ length: k }, () => [0, 0, 0]);
    counts = new Array(k).fill(0);
    for (const p of pixels) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const d = (p[0] - centers[c][0]) ** 2 + (p[1] - centers[c][1]) ** 2 + (p[2] - centers[c][2]) ** 2;
        if (d < bestD) { bestD = d; best = c; }
      }
      sums[best][0] += p[0]; sums[best][1] += p[1]; sums[best][2] += p[2];
      counts[best]++;
    }
    centers = centers.map((c, i) => (counts[i] ? [sums[i][0] / counts[i], sums[i][1] / counts[i], sums[i][2] / counts[i]] : c)) as RGB[];
  }

  const colors = centers
    .map((c, i) => ({ hsl: rgbToHsl(c), n: counts[i] }))
    .filter((c) => c.n > 0)
    .map(({ hsl: [h, s, l] }) => {
      // 发光色：亮度拉到 0.55~0.75，灰色封面保留低饱和，但不会全黑
      const sat = s < 0.12 ? s : Math.min(1, Math.max(0.55, s * 1.25));
      const light = Math.min(0.75, Math.max(0.55, l));
      return { h, hex: hslToHex([h, sat, light]) };
    })
    .sort((a, b) => a.h - b.h)
    .map((c) => c.hex);

  return colors.length ? colors : FALLBACK_PALETTE;
}

/** 在调色板上按比例取色，让一排灯从左到右平滑过渡 */
export function pickGradient(palette: string[], i: number, n: number): string {
  if (palette.length === 0) return "#FFFFFF";
  const idx = Math.round((i / Math.max(n - 1, 1)) * (palette.length - 1));
  return palette[idx];
}

/** 两色之间均匀插值出 n 个颜色，用于自定义拾音灯和唱片配色 */
export function mixPalette(a: string, b: string, n = 6): string[] {
  const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const A = hex(a);
  const B = hex(b);
  return Array.from({ length: n }, (_, k) => {
    const t = n === 1 ? 0 : k / (n - 1);
    return "#" + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, "0")).join("").toUpperCase();
  });
}

/** 预设配色主题（拾音灯和唱片共用） */
export const COLOR_PRESETS = [
  { id: "neon", name: "霓虹", a: "#FF5FA2", b: "#7B5CFF" },
  { id: "ocean", name: "海洋", a: "#3DE8FF", b: "#2F5BFF" },
  { id: "sunset", name: "落日", a: "#FFB547", b: "#FF4F7B" },
  { id: "aurora", name: "极光", a: "#4BF0B5", b: "#9B7BFF" },
  { id: "mono", name: "纯白", a: "#FFFFFF", b: "#C9C4E8" },
];
