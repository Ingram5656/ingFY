import type { VinylLook } from "./settings";

export const VINYL_LOOKS: { id: VinylLook | "random"; name: string }[] = [
  { id: "classic", name: "经典黑胶" },
  { id: "color", name: "彩胶" },
  { id: "splatter", name: "墨水飞溅" },
  { id: "spots", name: "不规则斑点" },
  { id: "split", name: "双色拼接" },
  { id: "swirl", name: "漩涡渐变" },
  { id: "random", name: "随机" },
];

export const LOOK_IDS: VinylLook[] = ["classic", "color", "splatter", "spots", "split", "swirl"];

export const VINYL_PRESETS = [
  { id: "mint", name: "薄荷", a: "#4BF0B5", b: "#2F5BFF" },
  { id: "sunset", name: "落日", a: "#FFB547", b: "#FF4F7B" },
  { id: "grape", name: "葡萄", a: "#B07BFF", b: "#3B1E7A" },
  { id: "sakura", name: "樱花", a: "#FFC1D6", b: "#FF5FA2" },
  { id: "mono", name: "黑白", a: "#F4EFE6", b: "#151320" },
];

export const LABEL_COLORS = [
  { c: "#F4EFE6", name: "奶白" },
  { c: "#151320", name: "墨黑" },
  { c: "#FF6F91", name: "樱粉" },
  { c: "#FFD166", name: "明黄" },
  { c: "#4C7BD9", name: "钴蓝" },
  { c: "#4BF0B5", name: "薄荷" },
];

export interface Spot {
  /** 圆心位置、直径，都是唱片直径的百分比 */
  x: number;
  y: number;
  s: number;
  c: string;
  /** 模糊程度，乘以唱片直径的 1% */
  blur: number;
  radius: string;
  rot: number;
}

export interface DiscLook {
  bg: string;
  spots: Spot[];
  /** 沟槽纹的深浅 */
  groove: number;
}

/** 可复现的伪随机数：同一个种子每次生成的斑点完全一样，唱片转着不会变样 */
function rng(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** 从字符串得到一个稳定的种子（同一首歌每次是同一张唱片） */
export function seedFrom(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function blobRadius(r: () => number) {
  const p = () => `${Math.round(30 + r() * 40)}%`;
  return `${p()} ${p()} ${p()} ${p()} / ${p()} ${p()} ${p()} ${p()}`;
}

/** 生成一种唱片外观：底色 + 斑点（位置、大小由种子决定） */
export function discLook(look: VinylLook, seed: number, a: string, b: string): DiscLook {
  const r = rng(seed * 9973 + 17);
  const spot = (s: number, c: string, blur: number, round: boolean): Spot => ({
    x: Math.round(8 + r() * 84),
    y: Math.round(8 + r() * 84),
    s,
    c,
    blur,
    radius: round ? "50%" : blobRadius(r),
    rot: Math.round(r() * 360),
  });

  switch (look) {
    case "color":
      return {
        bg: `radial-gradient(circle at 50% 50%, ${a} 0%, color-mix(in srgb, ${a} 60%, ${b}) 70%, ${b} 100%)`,
        spots: [],
        groove: 0.16,
      };
    case "splatter": {
      // 墨水飞溅：几团不规则的大墨点，每团周围甩出一圈大小不一的小墨滴
      const spots: Spot[] = [];
      const inks = [a, b, "#151320"];
      for (let i = 0; i < 6; i++) {
        const c = inks[i % 3];
        const main = spot(Math.round(10 + r() * 16), c, 0, false);
        spots.push(main);
        const drops = 4 + Math.floor(r() * 5);
        for (let k = 0; k < drops; k++) {
          const ang = r() * Math.PI * 2;
          const dist = main.s * (0.6 + r() * 0.9);
          const s = Math.round((0.8 + r() * 2.6) * 10) / 10;
          spots.push({ x: Math.round(main.x + Math.cos(ang) * dist), y: Math.round(main.y + Math.sin(ang) * dist), s, c, blur: 0, radius: "50%", rot: 0 });
        }
      }
      return { bg: "#EFE8DA", spots, groove: 0.1 };
    }
    case "spots": {
      const spots: Spot[] = [];
      for (let i = 0; i < 10; i++) spots.push(spot(Math.round(16 + r() * 26), i % 3 === 2 ? "#FFFFFF" : b, 1.2, false));
      return { bg: a, spots, groove: 0.14 };
    }
    case "split":
      return { bg: `conic-gradient(from ${Math.round(r() * 360)}deg, ${a} 0deg 180deg, ${b} 180deg 360deg)`, spots: [], groove: 0.16 };
    case "swirl":
      return { bg: `conic-gradient(from ${Math.round(r() * 360)}deg, ${a}, ${b}, #FFD166, ${a})`, spots: [], groove: 0.14 };
    default:
      return { bg: "#141218", spots: [], groove: 0.55 };
  }
}

// ---------- 唱臂几何 ----------
// 坐标都是全屏界面 1440×900 设计尺寸下的像素

export const PIVOT = { x: 1040, y: 160 }; // 唱臂转轴
export const CENTER = { x: 560, y: 470 }; // 唱片圆心
export const ARM_LEN = 560; // 转轴到唱针

/** 唱针要落在离唱片圆心 r 的位置时，唱臂（初始朝正下方）需要转的角度 */
export function armAngleFor(r: number): number {
  const P = PIVOT;
  const C = CENTER;
  const L = ARM_LEN;
  const dx = C.x - P.x;
  const dy = C.y - P.y;
  const d = Math.hypot(dx, dy);
  const a = (L * L - r * r + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, L * L - a * a));
  const mx = P.x + (a * dx) / d;
  const my = P.y + (a * dy) / d;
  const n1 = { x: mx + (h * dy) / d, y: my - (h * dx) / d };
  const n2 = { x: mx - (h * dy) / d, y: my + (h * dx) / d };
  const n = n1.y > n2.y ? n1 : n2; // 真实唱机唱针所在的那一侧
  return (Math.atan2(-(n.x - P.x), n.y - P.y) * 180) / Math.PI;
}

export const ARM_OUTER = armAngleFor(312); // 最外圈：歌曲开头
export const ARM_INNER = armAngleFor(132); // 靠近标签：歌曲结尾
export const ARM_REST = ARM_OUTER - 24; // 休息位：唱片外面

/** 记录用户是按了"上一首"还是"下一首"，决定换唱片时往哪边滑 */
let lastDir = 1;
let lastDirAt = 0;
export function markDirection(dir: 1 | -1) {
  lastDir = dir;
  lastDirAt = Date.now();
}
export function takeDirection(): 1 | -1 {
  const d = Date.now() - lastDirAt < 4000 ? lastDir : 1;
  lastDir = 1;
  return d as 1 | -1;
}
