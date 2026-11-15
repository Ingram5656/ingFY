import { useEffect, useRef } from "react";

const rnd = (s: number) => {
  const x = Math.sin(s * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/**
 * 水墨滤镜：去色 → 把明暗归成几层墨色 → 轮廓处勾一道线 → 加一点宣纸的颗粒 → 四边不规则地洇开。
 * 亮的地方直接透出底下的纸，所以放在宣纸上像是画上去的，不是贴了一张卡片。
 */
function inkWash(img: HTMLImageElement, cv: HTMLCanvasElement) {
  const n = 680;
  cv.width = cv.height = n;
  const g = cv.getContext("2d", { willReadFrequently: true });
  if (!g) return;
  // 封面不一定是正方形：居中裁成方的
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  g.filter = `blur(${(n / 300).toFixed(1)}px)`;
  g.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, n, n);
  g.filter = "none";
  const im = g.getImageData(0, 0, n, n);
  const d = im.data;
  const L = new Float32Array(n * n);
  let lo = 1;
  let hi = 0;
  for (let i = 0; i < n * n; i++) {
    const l = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) / 255;
    L[i] = l;
    if (l < lo) lo = l;
    if (l > hi) hi = l;
  }
  const sm = (a: number, b: number, x: number) => {
    const u = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return u * u * (3 - 2 * u);
  };
  const at = (x: number, y: number) => L[Math.max(0, Math.min(n - 1, y)) * n + Math.max(0, Math.min(n - 1, x))];
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      let l = (L[i] - lo) / Math.max(0.01, hi - lo);
      l = l * l * (3 - 2 * l);
      l += (Math.round(l * 4) / 4 - l) * 0.5;
      const e = Math.min(1, Math.hypot(at(x + 2, y) - at(x - 2, y), at(x, y + 2) - at(x, y - 2)) * 9);
      const dark = Math.max(0, Math.min(1, Math.pow(1 - l, 1.8) * 0.95 + 0.5 * e * (0.35 + 0.65 * l) + (rnd(i * 0.37) - 0.5) * 0.035));
      const wob = 0.03 * (Math.sin(x * 0.011 + 1.3) * Math.sin(y * 0.009 + 0.4) + 0.7 * Math.sin(x * 0.023 + y * 0.019) + 0.25 * Math.sin(x * 0.047 - y * 0.041));
      const edge = sm(0.02, 0.17, Math.min(x, n - 1 - x, y, n - 1 - y) / n + wob);
      // 浓处是焦墨 #1b1d1c，淡处是灰绿的淡墨 #47524c
      d[i * 4] = 71 + (27 - 71) * dark;
      d[i * 4 + 1] = 82 + (29 - 82) * dark;
      d[i * 4 + 2] = 76 + (28 - 76) * dark;
      d[i * 4 + 3] = 255 * Math.pow(dark, 0.85) * 0.92 * edge;
    }
  g.clearRect(0, 0, n, n);
  g.putImageData(im, 0, 0);
}

/** 墨晕里的专辑封面：过一遍水墨滤镜再显示 */
export function InkCover({ src, className }: { src: string; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    let alive = true;
    const img = new Image();
    img.onload = () => {
      if (alive) inkWash(img, cv);
    };
    img.src = src;
    return () => {
      alive = false;
    };
  }, [src]);
  return <canvas ref={ref} className={className} role="img" aria-label="" />;
}
