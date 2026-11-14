import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { LyricLine, NowPlaying } from "../lib/types";
import { Sheet } from "./Sheet";
import { t, tMsg } from "../lib/i18n";

interface Props {
  now: NowPlaying;
  lines: LyricLine[];
  /** 当前唱到的那句，默认选中它 */
  index: number;
  artworkUrl: string | null;
  palette: string[];
  onClose: () => void;
}

const MAX_LINES = 4;
const W = 1080;
const H = 1350;

/**
 * 分享歌词：选 1~4 句，生成一张 1080×1350 的卡片（封面取色背景 + 封面 + 歌词 + 歌名），
 * 可以复制到剪贴板直接粘贴，或者保存到"图片\ingfy"。
 */
export function ShareSheet({ now, lines, index, artworkUrl, palette, onClose }: Props) {
  const usable = useMemo(() => lines.map((l, i) => ({ ...l, i })).filter((l) => l.text.trim()), [lines]);
  const [picked, setPicked] = useState<number[]>(() => {
    const start = index >= 0 && lines[index]?.text.trim() ? index : usable[0]?.i ?? 0;
    return [start];
  });
  const [url, setUrl] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; path?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const chosen = useMemo(() => [...picked].sort((a, b) => a - b).map((i) => lines[i]?.text ?? ""), [picked, lines]);

  useEffect(() => {
    let alive = true;
    void renderCard({ title: now.title, artist: now.artist, lines: chosen, artworkUrl, palette }).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [chosen, now.title, now.artist, artworkUrl, palette]);

  const toggle = (i: number) => {
    setMsg(null);
    setPicked((cur) => {
      if (cur.includes(i)) return cur.length > 1 ? cur.filter((x) => x !== i) : cur;
      if (cur.length >= MAX_LINES) return [...cur.slice(1), i];
      return [...cur, i];
    });
  };

  const copy = async () => {
    if (!url) return;
    setBusy(true);
    try {
      const blob = await (await fetch(url)).blob();
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      setMsg({ text: t("已复制，可以直接粘贴到聊天里") });
    } catch {
      setMsg({ text: t("复制失败，试试保存图片") });
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (!url) return;
    setBusy(true);
    try {
      const path = await invoke<string>("save_share_image", { pngBase64: url });
      setMsg({ text: t("已保存到 图片\\ingfy"), path });
    } catch (e) {
      setMsg({ text: tMsg(String(e)) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title={t("分享歌词")} subtitle={t("选 1~{n} 句，生成一张图片", { n: MAX_LINES })} wide onClose={onClose}>
      <div className="share">
        <div className="share-preview">{url ? <img src={url} alt={t("歌词卡片预览")} /> : <span className="share-loading" />}</div>
        <div className="share-side">
          <ol className="nl-list share-lines" aria-label={t("选择歌词")}>
            {usable.map((l) => {
              const on = picked.includes(l.i);
              return (
                <li key={l.i}>
                  <button className={`share-line${on ? " is-on" : ""}`} role="checkbox" aria-checked={on} onClick={() => toggle(l.i)}>
                    <span className="share-tick" aria-hidden="true" />
                    <span>{l.text}</span>
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="share-actions">
            <button className="st-btn" onClick={copy} disabled={!url || busy}>
              {t("复制图片")}
            </button>
            <button className="st-btn st-btn--primary" onClick={save} disabled={!url || busy}>
              {t("保存图片")}
            </button>
          </div>
          {msg && (
            <p className="share-msg" role="status">
              {msg.text}
              {msg.path && (
                <button className="st-link" onClick={() => invoke("reveal_path", { path: msg.path })}>
                  {t("打开文件夹")}
                </button>
              )}
            </p>
          )}
        </div>
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------------ 画卡片

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/** 按宽度断行：中文逐字断，英文尽量在空格处断 */
function wrap(ctx: CanvasRenderingContext2D, text: string, max: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const ch of Array.from(text)) {
    const test = line + ch;
    if (ctx.measureText(test).width > max && line) {
      const sp = line.lastIndexOf(" ");
      if (/[A-Za-z0-9]/.test(ch) && sp > 0) {
        out.push(line.slice(0, sp));
        line = line.slice(sp + 1) + ch;
      } else {
        out.push(line);
        line = ch.trim() ? ch : "";
      }
    } else line = test;
  }
  if (line) out.push(line);
  return out;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

async function renderCard(o: { title: string; artist: string; lines: string[]; artworkUrl: string | null; palette: string[] }): Promise<string> {
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext("2d")!;
  const font = getComputedStyle(document.body).fontFamily || "sans-serif";
  const art = o.artworkUrl ? await loadImage(o.artworkUrl).catch(() => null) : null;
  const c1 = o.palette[1] ?? "#6F48C6";
  const c5 = o.palette[o.palette.length - 1] ?? "#20163F";

  // 背景：封面放大模糊铺满，再压一层专辑色渐变
  ctx.fillStyle = c5;
  ctx.fillRect(0, 0, W, H);
  if (art) {
    ctx.save();
    ctx.filter = "blur(70px) saturate(1.4)";
    const s = Math.max(W, H) * 1.3;
    ctx.drawImage(art, (W - s) / 2, (H - s) / 2, s, s);
    ctx.restore();
  }
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, hexA(c1, 0.35));
  g.addColorStop(1, "rgba(10,6,24,0.62)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // 封面 + 歌名
  const pad = 96;
  if (art) {
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = 40;
    ctx.shadowOffsetY = 16;
    roundRect(ctx, pad, pad, 200, 200, 28);
    ctx.fillStyle = "#000";
    ctx.fill();
    ctx.restore();
    ctx.save();
    roundRect(ctx, pad, pad, 200, 200, 28);
    ctx.clip();
    ctx.drawImage(art, pad, pad, 200, 200);
    ctx.restore();
  }
  const tx = art ? pad + 240 : pad;
  ctx.fillStyle = "#fff";
  ctx.font = `800 46px ${font}`;
  const title = wrap(ctx, o.title, W - tx - pad).slice(0, 2);
  title.forEach((t, i) => ctx.fillText(t, tx, pad + 70 + i * 56));
  ctx.fillStyle = "rgba(255,255,255,0.72)";
  ctx.font = `500 32px ${font}`;
  ctx.fillText(wrap(ctx, o.artist, W - tx - pad)[0] ?? "", tx, pad + 70 + title.length * 56 + 14);

  // 歌词：字号按总行数自适应，整体垂直居中在中下部
  const maxW = W - pad * 2;
  let size = 84;
  let rows: string[][] = [];
  for (; size >= 48; size -= 4) {
    ctx.font = `900 ${size}px ${font}`;
    rows = o.lines.map((l) => wrap(ctx, l, maxW));
    const total = rows.reduce((n, r) => n + r.length, 0) * size * 1.32 + (rows.length - 1) * size * 0.5;
    if (total <= H - 520) break;
  }
  const lh = size * 1.32;
  const total = rows.reduce((n, r) => n + r.length, 0) * lh + (rows.length - 1) * size * 0.5;
  let y = 400 + (H - 400 - 180 - total) / 2 + size;
  ctx.fillStyle = "#fff";
  ctx.shadowColor = "rgba(0,0,0,0.25)";
  ctx.shadowBlur = 24;
  for (const r of rows) {
    for (const t of r) {
      ctx.fillText(t, pad, y);
      y += lh;
    }
    y += size * 0.5;
  }
  ctx.shadowBlur = 0;

  // 底部署名
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.font = `700 30px ${font}`;
  ctx.fillText("ingfy", pad, H - pad);
  ctx.textAlign = "right";
  ctx.font = `500 26px ${font}`;
  ctx.fillText("在 ingfy 里听", W - pad, H - pad);
  ctx.textAlign = "left";

  return cv.toDataURL("image/png");
}

function hexA(hex: string, a: number) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(111,72,198,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
