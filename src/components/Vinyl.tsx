import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import type { NowPlaying } from "../lib/types";
import { trackKey } from "../lib/types";
import type { Settings, VinylLook } from "../lib/settings";
import {
  ARM_INNER,
  ARM_LEN,
  ARM_OUTER,
  ARM_REST,
  LABEL_COLORS,
  LOOK_IDS,
  PIVOT,
  VINYL_LOOKS,
  VINYL_PRESETS,
  discLook,
  markDirection,
  seedFrom,
  takeDirection,
} from "../lib/vinyl";
import { mediaControl } from "../lib/player";
import { Presence } from "./Presence";
import { t } from "../lib/i18n";

// ---------- 单张唱片 ----------

interface DiscProps {
  look: VinylLook;
  seed: number;
  a: string;
  b: string;
  /** 直径（px） */
  size: number;
  spinning?: boolean;
  label?: ReactNode;
  className?: string;
}

/** 唱片本体：底色 + 斑点 + 沟槽纹 + 中间标签 + 轴心。转动时整张一起转 */
export function Disc({ look, seed, a, b, size, spinning, label, className }: DiscProps) {
  const g = discLook(look, seed, a, b);
  return (
    <div
      className={`disc${spinning === undefined ? "" : " disc--spin"}${spinning === false ? " is-stopped" : ""}${className ? " " + className : ""}`}
      style={{ width: size, height: size, background: g.bg, "--u": `${size / 100}px`, "--groove": g.groove } as CSSProperties}
    >
      {g.spots.map((s, i) => (
        <span
          key={i}
          className="disc-spot"
          style={{
            left: `${s.x}%`,
            top: `${s.y}%`,
            width: `${s.s}%`,
            height: `${s.s}%`,
            margin: `${-s.s / 2}% 0 0 ${-s.s / 2}%`,
            borderRadius: s.radius,
            background: s.c,
            filter: s.blur ? `blur(calc(var(--u) * ${s.blur}))` : undefined,
            transform: `rotate(${s.rot}deg)`,
          }}
        />
      ))}
      <span className="disc-groove" />
      {label}
      <span className="disc-spindle" />
    </div>
  );
}

// ---------- 唱片模式 ----------

interface Snapshot {
  look: VinylLook;
  seed: number;
  a: string;
  b: string;
  art: string | null;
  title: string;
  artist: string;
}

interface Props {
  now: NowPlaying | null;
  position: number;
  artworkUrl: string | null;
  /** 专辑取色 */
  palette: string[];
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  lyricText: string;
  menuOpen: boolean;
  onCloseMenu: () => void;
  /** 拖唱针时实时预览的位置（毫秒），null 表示松手 */
  onPreview: (ms: number | null) => void;
  /** 松开唱针时跳到对应位置（毫秒） */
  onSeek: (ms: number) => void;
}

const RECORD = 660;
/** 切歌时抬针、换唱片、落针都要快：整个过程约 1.4 秒，唱针尽快回到新歌开头 */
const LIFT_MS = 400;
const SWAP_MS = 650;
/** 落针用时；之后恢复平时（暂停/继续）的慢速摆动 */
const DROP_MS = 400;

function randomLook(): VinylLook {
  return LOOK_IDS[Math.floor(Math.random() * LOOK_IDS.length)];
}

export function VinylView(p: Props) {
  const { now, settings: s } = p;
  const key = now?.title ? trackKey(now) : "";
  const random = s.vinylLook === "random";

  // 当前唱片：随机模式下每次换歌随机抽一种外观和斑点；否则同一首歌固定同一张
  const [cur, setCur] = useState(() => ({ key, randomLook: randomLook(), randomSeed: Math.floor(Math.random() * 1e6) }));
  const [outgoing, setOutgoing] = useState<Snapshot | null>(null);
  const [phase, setPhase] = useState<"idle" | "lift" | "swap">("idle");
  const [dir, setDir] = useState<1 | -1>(1);
  /** 切歌期间唱臂快速摆动 */
  const [fastArm, setFastArm] = useState(false);
  const lastSnap = useRef<Snapshot | null>(null);

  const colors: [string, string] =
    s.vinylColorMode === "custom" ? [s.vinylA, s.vinylB] : [p.palette[1] ?? "#FF6F91", p.palette[p.palette.length - 1] ?? "#6F48C6"];
  const look: VinylLook = random ? cur.randomLook : (s.vinylLook as VinylLook);
  const seed = random ? cur.randomSeed : seedFrom(key || "nige");
  const snap: Snapshot = { look, seed, a: colors[0], b: colors[1], art: p.artworkUrl, title: now?.title ?? "", artist: now?.artist ?? "" };

  // ---- 拖唱片换歌：按住唱片左右拖，像在唱机上推开一张唱片 ----
  // 往左推过一定距离 = 下一首，往右 = 上一首；没推够就弹回来
  const [discDrag, setDiscDrag] = useState<{ x: number; flung: 0 | 1 | -1 } | null>(null);
  const discStart = useRef<{ x: number; id: number } | null>(null);
  /** 唱片是被拖出去的：换歌时旧唱片已经不在台上，不再播放"旧唱片滑出"的动画 */
  const flung = useRef(false);
  const flingTimer = useRef<ReturnType<typeof setTimeout>>();
  const stageScale = (el: HTMLElement) => {
    const stage = el.closest(".fs-stage") as HTMLElement | null;
    return stage ? stage.getBoundingClientRect().width / 1440 : 1;
  };
  const discDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || phase !== "idle" || !now) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    discStart.current = { x: e.clientX, id: e.pointerId };
    setDiscDrag({ x: 0, flung: 0 });
    // 唱针快速抬起
    setFastArm(true);
    clearTimeout(armTimer.current);
  };
  const discMove = (e: PointerEvent<HTMLDivElement>) => {
    const st = discStart.current;
    if (!st || st.id !== e.pointerId) return;
    const dx = (e.clientX - st.x) / stageScale(e.currentTarget);
    setDiscDrag({ x: dx, flung: 0 });
  };
  const discUp = (e: PointerEvent<HTMLDivElement>) => {
    const st = discStart.current;
    discStart.current = null;
    if (!st) return;
    const dx = (e.clientX - st.x) / stageScale(e.currentTarget);
    if (Math.abs(dx) < 150) {
      setDiscDrag(null); // 没推够：弹回原位
      dropArmFast();
      return;
    }
    const d: 1 | -1 = dx < 0 ? 1 : -1;
    flung.current = true;
    setDiscDrag({ x: dx, flung: d });
    markDirection(d);
    void mediaControl(d > 0 ? "next" : "previous");
    // 播放器没换歌（比如"上一首"在歌曲中段只会回到开头）：唱片转回来，唱针快速落回
    clearTimeout(flingTimer.current);
    flingTimer.current = setTimeout(() => {
      flung.current = false;
      setDiscDrag(null);
      dropArmFast();
    }, 900);
  };
  // 唱片拖完回到原位时，唱针用落针的速度（0.4 秒）回去，而不是平时暂停/继续的慢速
  const armTimer = useRef<ReturnType<typeof setTimeout>>();
  const dropArmFast = () => {
    setFastArm(true);
    clearTimeout(armTimer.current);
    armTimer.current = setTimeout(() => setFastArm(false), DROP_MS + 150);
  };
  useEffect(
    () => () => {
      clearTimeout(flingTimer.current);
      clearTimeout(armTimer.current);
    },
    [],
  );

  // 换歌：抬针 → 旧唱片滑出、新唱片滑入 → 落针
  useEffect(() => {
    if (key === cur.key) return;
    const next = { key, randomLook: randomLook(), randomSeed: Math.floor(Math.random() * 1e6) };
    if (!cur.key || !key || !lastSnap.current) {
      // 不播换片动画的情况（刚启动、两首歌之间短暂没有歌名）：把状态收拾干净，
      // 免得上一次被打断的换片停在半路，唱片和唱针一直不能拖
      setCur(next);
      setPhase("idle");
      setOutgoing(null);
      setFastArm(false);
      flung.current = false;
      setDiscDrag(null);
      return;
    }
    setDir(takeDirection());
    // 拖出去换的歌：旧唱片已经被推走了，只让新唱片从另一边滑进来
    if (flung.current) {
      flung.current = false;
      clearTimeout(flingTimer.current);
      // 先不带过渡地瞬间归位（这时台上是空的），下一帧再恢复正常状态
      setDiscDrag({ x: 0, flung: 0 });
      requestAnimationFrame(() => setDiscDrag(null));
      setOutgoing(null);
    } else {
      setOutgoing(lastSnap.current);
    }
    setPhase("lift");
    setFastArm(true);
    setCur(next);
    const t1 = setTimeout(() => setPhase("swap"), LIFT_MS);
    const t2 = setTimeout(() => {
      setPhase("idle");
      setOutgoing(null);
    }, LIFT_MS + SWAP_MS);
    const t3 = setTimeout(() => setFastArm(false), LIFT_MS + SWAP_MS + DROP_MS + 100);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      // 播放器有时会连续报两次换歌（先换歌名、再换歌手），被打断时也要保证唱臂不会停在慢速
      setFastArm(true);
    };
    // 只在换歌时触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // 记下这一帧画的是什么，换歌时用来画"旧唱片"
  useEffect(() => {
    if (phase === "idle") lastSnap.current = snap;
  });

  const playing = !!now?.playing;
  const settled = phase === "idle";
  const duration = now?.durationMs ?? 0;
  const progress = duration > 0 ? Math.min(1, p.position / duration) : 0;

  // ---- 拖动唱针调整进度 ----
  // 唱针可以在"最外圈（开头）"和"靠近标签（结尾）"之间拖；拖动时只预览，松手才跳转
  const [dragAngle, setDragAngle] = useState<number | null>(null);
  const lo = Math.min(ARM_OUTER, ARM_INNER);
  const hi = Math.max(ARM_OUTER, ARM_INNER);
  const angleAt = (e: PointerEvent<HTMLElement>) => {
    const stage = e.currentTarget.closest(".fs-stage") as HTMLElement | null;
    if (!stage) return null;
    const r = stage.getBoundingClientRect();
    const k = r.width / 1440; // 舞台按 1440 宽等比缩放
    const x = (e.clientX - r.left) / k - PIVOT.x;
    const y = (e.clientY - r.top) / k - PIVOT.y;
    const deg = (Math.atan2(-x, y) * 180) / Math.PI;
    return Math.min(hi, Math.max(lo, deg));
  };
  const msAtAngle = (a: number) => ((a - ARM_OUTER) / (ARM_INNER - ARM_OUTER)) * duration;
  const canDrag = settled && duration > 0;
  const armDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!canDrag) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const a = angleAt(e);
    if (a === null) return;
    setDragAngle(a);
    p.onPreview(msAtAngle(a));
  };
  const armMove = (e: PointerEvent<HTMLDivElement>) => {
    if (dragAngle === null) return;
    const a = angleAt(e);
    if (a === null) return;
    setDragAngle(a);
    p.onPreview(msAtAngle(a));
  };
  const armUp = (e: PointerEvent<HTMLDivElement>) => {
    if (dragAngle === null) return;
    const a = angleAt(e) ?? dragAngle;
    setDragAngle(null);
    p.onPreview(null);
    p.onSeek(msAtAngle(a));
  };
  const armKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!canDrag) return;
    if (e.key === "ArrowRight") p.onSeek(Math.min(duration, p.position + 5000));
    else if (e.key === "ArrowLeft") p.onSeek(Math.max(0, p.position - 5000));
    else return;
    e.preventDefault();
  };

  const dragging = dragAngle !== null;
  // 推唱片时唱针先抬起来回到架上
  const angle = dragging ? dragAngle : playing && settled && !discDrag ? ARM_OUTER + (ARM_INNER - ARM_OUTER) * progress : ARM_REST;
  // 拖动时唱针被"拿起来"了，阴影也变大
  const lifted = dragging || !!discDrag || !(playing && settled);

  const labelFor = (d: Snapshot) => {
    if (s.vinylLabel === "lyric") return null; // 歌词标签单独画在上层，不跟着转
    if (s.vinylLabel === "solid") {
      const dark = isDark(s.vinylLabelColor);
      return (
        <span className="disc-label disc-label--solid" style={{ background: s.vinylLabelColor, color: dark ? "#fff" : "#2A1E4A" }}>
          <strong>{d.title}</strong>
          <small>{d.artist}</small>
        </span>
      );
    }
    return (
      <span
        className="disc-label"
        style={d.art ? { backgroundImage: `url(${d.art})` } : { background: `linear-gradient(135deg, ${d.a}, ${d.b})` }}
      />
    );
  };

  return (
    <>
      <div className="vinyl-platter" aria-hidden="true" />

      <div
        className={`vinyl-stage${discDrag ? (discDrag.flung ? " is-flung" : " is-dragging") : ""}${now && settled ? " can-drag" : ""}`}
        aria-hidden="true"
        title={now ? t("左右拖动唱片换歌") : undefined}
        style={
          {
            // 唱片在台上滚动：平移的同时按周长转动，往外推过阈值后继续滑出画面
            "--dx": `${discDrag ? (discDrag.flung ? -discDrag.flung * 1100 : discDrag.x) : 0}px`,
            "--droll": `${discDrag ? ((discDrag.flung ? -discDrag.flung * 1100 : discDrag.x) / (RECORD / 2)) * (180 / Math.PI) : 0}deg`,
          } as CSSProperties
        }
        onPointerDown={discDown}
        onPointerMove={discMove}
        onPointerUp={discUp}
        onPointerCancel={discUp}
      >
        {outgoing && (
          <div className={`vinyl-slot${phase === "swap" ? (dir > 0 ? " out-left" : " out-right") : ""}`}>
            <Disc look={outgoing.look} seed={outgoing.seed} a={outgoing.a} b={outgoing.b} size={RECORD} spinning={false} label={labelFor(outgoing)} />
          </div>
        )}
        {phase !== "lift" && (
          <div className={`vinyl-slot${phase === "swap" ? (dir > 0 ? " in-right" : " in-left") : ""}`}>
            <Disc look={look} seed={seed} a={colors[0]} b={colors[1]} size={RECORD} spinning={playing && settled} label={labelFor(snap)} />
          </div>
        )}
      </div>

      {/* 不转的高光，唱片转动时反光位置不变 */}
      <div className="vinyl-sheen" aria-hidden="true" />

      {s.vinylLabel === "lyric" && (
        <div className={`vinyl-lyric${settled ? "" : " is-hidden"}`} aria-live="polite">
          <span>{p.lyricText || "♪"}</span>
        </div>
      )}

      <div className="tonearm-base glass" aria-hidden="true" />
      <div className="tonearm-knob" aria-hidden="true" />
      <div
        className={`tonearm${lifted ? " is-lifted" : ""}${dragging ? " is-dragging" : ""}${canDrag ? " can-drag" : ""}`}
        role="slider"
        tabIndex={0}
        aria-label={t("唱针：拖动调整播放进度")}
        aria-valuemin={0}
        aria-valuemax={Math.round(duration / 1000)}
        aria-valuenow={Math.round(p.position / 1000)}
        onPointerDown={armDown}
        onPointerMove={armMove}
        onPointerUp={armUp}
        onPointerCancel={armUp}
        onKeyDown={armKey}
        style={
          {
            height: ARM_LEN,
            transform: `rotate(${angle.toFixed(2)}deg)`,
            "--needle": colors[0],
            "--arm-ms": `${fastArm ? (phase === "idle" ? DROP_MS : LIFT_MS) : 1600}ms`,
          } as CSSProperties
        }
      >
        <span className="tonearm-weight" />
        <span className="tonearm-tube" />
        <span className="tonearm-head">
          <span />
        </span>
      </div>

      <div className={`vinyl-info${settled ? "" : " is-changing"}`}>
        <h1>{now?.title || t("没有在播放")}</h1>
        <p className="artist">{now?.artist || t("在 Spotify 或其他播放器里放一首歌")}</p>
        {now?.album && <p className="album">{now.album}</p>}
      </div>

      <Presence show={p.menuOpen}>
        <VinylMenu settings={s} update={p.update} colors={colors} artUrl={p.artworkUrl} onClose={p.onCloseMenu} />
      </Presence>
    </>
  );
}

function isDark(hex: string) {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return v[0] * 0.3 + v[1] * 0.59 + v[2] * 0.11 < 128;
}

// ---------- 自定义唱片菜单 ----------

interface MenuProps {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  colors: [string, string];
  artUrl: string | null;
  onClose: () => void;
}

function VinylMenu({ settings: s, update, colors, artUrl, onClose }: MenuProps) {
  const thumbLabel = artUrl ? { backgroundImage: `url(${artUrl})` } : { background: `linear-gradient(135deg, ${colors[0]}, ${colors[1]})` };
  return (
    <section className="vinyl-menu glass glass--thick" role="dialog" aria-labelledby="vm-title">
      <header>
        <h2 id="vm-title">{t("自定义唱片")}</h2>
        <button className="ibtn" aria-label={t("关闭")} onClick={onClose}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </header>

      <div className="vm-block">
        <h3>{t("中间的标签")}</h3>
        <div className="st-seg" role="radiogroup" aria-label={t("标签内容")}>
          {(
            [
              ["album", t("专辑封面")],
              ["lyric", t("歌词")],
              ["solid", t("纯色")],
            ] as const
          ).map(([id, name]) => (
            <button key={id} role="radio" aria-checked={s.vinylLabel === id} onClick={() => update({ vinylLabel: id })}>
              {name}
            </button>
          ))}
        </div>
        {s.vinylLabel === "solid" && (
          <div className="vm-swatches" role="radiogroup" aria-label={t("标签颜色")}>
            {LABEL_COLORS.map((c) => (
              <button
                key={c.c}
                className="st-swatch"
                role="radio"
                aria-checked={s.vinylLabelColor === c.c}
                aria-label={t(c.name)}
                style={{ background: c.c }}
                onClick={() => update({ vinylLabelColor: c.c })}
              />
            ))}
          </div>
        )}
        <p className="st-note">
          {s.vinylLabel === "lyric" ? t("歌词标签不跟着转，方便边听边看") : s.vinylLabel === "solid" ? t("纯色标签上印歌名和歌手") : t("标签用当前歌曲的专辑封面")}
        </p>
      </div>

      <div className="vm-block">
        <h3>{t("唱片外观")}</h3>
        <div className="vm-looks" role="radiogroup" aria-label={t("唱片外观")}>
          {VINYL_LOOKS.map((l) => (
            <button key={l.id} className="vm-look" role="radio" aria-checked={s.vinylLook === l.id} onClick={() => update({ vinylLook: l.id })}>
              <span className="vm-thumb">
                <Disc
                  look={l.id === "random" ? "swirl" : l.id}
                  seed={11}
                  a={colors[0]}
                  b={colors[1]}
                  size={60}
                  label={<span className="disc-label" style={thumbLabel} />}
                />
                {l.id === "random" && <span className="vm-dice">?</span>}
              </span>
              <span>{t(l.name)}</span>
            </button>
          ))}
        </div>
        <p className="st-note">{s.vinylLook === "random" ? t("每次切歌随机换一种外观，斑点位置也每次不同") : t("斑点位置每首歌都不一样")}</p>
      </div>

      <div className="vm-block">
        <h3>{t("唱片颜色")}</h3>
        <div className="st-seg" role="radiogroup" aria-label={t("唱片颜色来源")}>
          {(
            [
              ["album", t("取自专辑")],
              ["custom", t("自定义")],
            ] as const
          ).map(([id, name]) => (
            <button key={id} role="radio" aria-checked={s.vinylColorMode === id} onClick={() => update({ vinylColorMode: id })}>
              {name}
            </button>
          ))}
        </div>
        {s.vinylColorMode === "custom" && (
          <>
            <div className="vm-pairs" role="radiogroup" aria-label={t("配色主题")}>
              {VINYL_PRESETS.map((c) => {
                const on = s.vinylA === c.a && s.vinylB === c.b;
                return (
                  <button key={c.id} className="vm-pair" role="radio" aria-checked={on} onClick={() => update({ vinylA: c.a, vinylB: c.b })}>
                    <span style={{ background: `conic-gradient(${c.a} 0deg 180deg, ${c.b} 180deg 360deg)` }} />
                    {t(c.name)}
                  </button>
                );
              })}
            </div>
            <div className="st-pickers">
              <label className="st-pick">
                <input type="color" value={s.vinylA} onChange={(e) => update({ vinylA: e.target.value.toUpperCase() })} />
                {t("主色")}
              </label>
              <label className="st-pick">
                <input type="color" value={s.vinylB} onChange={(e) => update({ vinylB: e.target.value.toUpperCase() })} />
                {t("副色")}
              </label>
            </div>
          </>
        )}
        <p className="st-note">{s.vinylColorMode === "album" ? t("唱片颜色跟着专辑封面变，换歌自动换色") : t("所有唱片都用这两种颜色，墨水飞溅里还会加一点墨黑")}</p>
      </div>
    </section>
  );
}
