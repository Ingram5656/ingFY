import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import type { NowPlaying } from "../lib/types";
import { trackKey } from "../lib/types";
import type { Settings, VinylLook, VinylPrefs } from "../lib/settings";
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
/** 抬针 / 落针用时：切歌、暂停、继续都用这个速度 */
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

  // ---- 单击唱针：暂停 / 继续 ----
  // 播放器要过一小会儿才报告新状态，这里先按点击的结果画，唱针和唱片马上有反应
  const [playGuess, setPlayGuess] = useState<boolean | null>(null);
  const guessTimer = useRef<ReturnType<typeof setTimeout>>();
  const realPlaying = !!now?.playing;
  const playing = playGuess ?? realPlaying;
  const togglePlay = () => {
    if (!now) return;
    const want = !playing;
    setPlayGuess(want);
    clearTimeout(guessTimer.current);
    // 播放器一直没照做（比如它不支持暂停）：回到它报告的真实状态
    guessTimer.current = setTimeout(() => setPlayGuess(null), 2500);
    void mediaControl("toggle").then((ok) => {
      if (!ok) setPlayGuess(null);
    });
  };
  // 播放器报告的状态和点击的结果对上了，就不用再猜
  useEffect(() => {
    if (playGuess !== null && realPlaying === playGuess) setPlayGuess(null);
  }, [realPlaying, playGuess]);
  useEffect(() => () => clearTimeout(guessTimer.current), []);

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
  const canPress = settled && !!now;
  /** 按下的位置：挪动超过几个像素才算拖，没挪就松手算单击 */
  const armPress = useRef<{ x: number; y: number } | null>(null);
  const armDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !canPress) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    armPress.current = { x: e.clientX, y: e.clientY };
  };
  const armMove = (e: PointerEvent<HTMLDivElement>) => {
    if (dragAngle === null) {
      const st = armPress.current;
      if (!st || !canDrag || Math.hypot(e.clientX - st.x, e.clientY - st.y) < 5) return;
    }
    const a = angleAt(e);
    if (a === null) return;
    setDragAngle(a);
    p.onPreview(msAtAngle(a));
  };
  const armUp = (e: PointerEvent<HTMLDivElement>) => {
    const pressed = armPress.current;
    armPress.current = null;
    if (dragAngle === null) {
      // 没拖动就松手：单击，暂停或继续
      if (pressed && e.type === "pointerup") togglePlay();
      return;
    }
    const a = angleAt(e) ?? dragAngle;
    setDragAngle(null);
    p.onPreview(null);
    p.onSeek(msAtAngle(a));
  };
  const armKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === " " || e.key === "Enter") {
      if (canPress) togglePlay();
      e.preventDefault();
      return;
    }
    if (!canDrag) return;
    if (e.key === "ArrowRight") p.onSeek(Math.min(duration, p.position + 5000));
    else if (e.key === "ArrowLeft") p.onSeek(Math.max(0, p.position - 5000));
    else return;
    e.preventDefault();
  };

  const dragging = dragAngle !== null;
  // 唱针该不该落在唱片上：暂停、换唱片、推唱片时都抬起来回到架上
  const onRecord = playing && settled && !discDrag;
  const liveAngle = ARM_OUTER + (ARM_INNER - ARM_OUTER) * progress;
  // 抬针 / 落针的那一下：用快的速度，并且途中目标角度定住不动。
  // 不定住的话，播放进度每帧都在改目标角度，过渡动画被反复从头开始，唱针就会越走越慢、半天回不到位
  const [swing, setSwing] = useState<{ on: boolean; to: number | null; quick: boolean }>({ on: onRecord, to: null, quick: false });
  if (swing.on !== onRecord) setSwing({ on: onRecord, to: onRecord ? liveAngle : null, quick: true });
  useEffect(() => {
    if (!swing.quick) return;
    const timer = setTimeout(() => setSwing((v) => ({ ...v, to: null, quick: false })), DROP_MS + 80);
    return () => clearTimeout(timer);
  }, [swing.on, swing.quick]);
  const angle = dragging ? dragAngle : onRecord ? swing.to ?? liveAngle : ARM_REST;
  // 拖动时唱针被"拿起来"了，阴影也变大
  const lifted = dragging || !onRecord;

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
        className={`tonearm${lifted ? " is-lifted" : ""}${dragging ? " is-dragging" : ""}${canPress ? " can-drag" : ""}`}
        role="slider"
        tabIndex={0}
        aria-label={t("唱针：单击暂停或继续，拖动调整播放进度")}
        title={canPress ? t("单击暂停或继续，拖动调整进度") : undefined}
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
            "--arm-ms": `${fastArm ? (phase === "idle" ? DROP_MS : LIFT_MS) : swing.quick ? DROP_MS : 1600}ms`,
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
  const value: VinylPrefs = { label: s.vinylLabel, labelColor: s.vinylLabelColor, look: s.vinylLook, colorMode: s.vinylColorMode, a: s.vinylA, b: s.vinylB };
  const change = (patch: Partial<VinylPrefs>) =>
    update({
      ...(patch.label !== undefined && { vinylLabel: patch.label }),
      ...(patch.labelColor !== undefined && { vinylLabelColor: patch.labelColor }),
      ...(patch.look !== undefined && { vinylLook: patch.look }),
      ...(patch.colorMode !== undefined && { vinylColorMode: patch.colorMode }),
      ...(patch.a !== undefined && { vinylA: patch.a }),
      ...(patch.b !== undefined && { vinylB: patch.b }),
    });
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
      <VinylEditor value={value} onChange={change} colors={colors} artUrl={artUrl} />
    </section>
  );
}

/**
 * 唱片外观编辑：标签、花纹、颜色。全屏唱片模式的菜单和灵动岛设置共用。
 * lyricLabel 为 false 时不提供"歌词"标签（灵动岛的唱片太小，放不下字）。
 */
export function VinylEditor({
  value: v,
  onChange,
  colors,
  artUrl,
  lyricLabel = true,
}: {
  value: VinylPrefs;
  onChange: (patch: Partial<VinylPrefs>) => void;
  colors: [string, string];
  artUrl: string | null;
  lyricLabel?: boolean;
}) {
  const thumbLabel = artUrl ? { backgroundImage: `url(${artUrl})` } : { background: `linear-gradient(135deg, ${colors[0]}, ${colors[1]})` };
  const labels = (
    [
      ["album", t("专辑封面")],
      ["lyric", t("歌词")],
      ["solid", t("纯色")],
    ] as const
  ).filter(([id]) => lyricLabel || id !== "lyric");
  return (
    <>
      <div className="vm-block">
        <h3>{t("中间的标签")}</h3>
        <div className="st-seg" role="radiogroup" aria-label={t("标签内容")}>
          {labels.map(([id, name]) => (
            <button key={id} role="radio" aria-checked={v.label === id} onClick={() => onChange({ label: id })}>
              {name}
            </button>
          ))}
        </div>
        {v.label === "solid" && (
          <div className="vm-swatches" role="radiogroup" aria-label={t("标签颜色")}>
            {LABEL_COLORS.map((c) => (
              <button
                key={c.c}
                className="st-swatch"
                role="radio"
                aria-checked={v.labelColor === c.c}
                aria-label={t(c.name)}
                style={{ background: c.c }}
                onClick={() => onChange({ labelColor: c.c })}
              />
            ))}
          </div>
        )}
      </div>

      <div className="vm-block">
        <h3>{t("唱片外观")}</h3>
        <div className="vm-looks" role="radiogroup" aria-label={t("唱片外观")}>
          {VINYL_LOOKS.map((l) => (
            <button key={l.id} className="vm-look" role="radio" aria-checked={v.look === l.id} onClick={() => onChange({ look: l.id })}>
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
            <button key={id} role="radio" aria-checked={v.colorMode === id} onClick={() => onChange({ colorMode: id })}>
              {name}
            </button>
          ))}
        </div>
        {v.colorMode === "custom" && (
          <>
            <div className="vm-pairs" role="radiogroup" aria-label={t("配色主题")}>
              {VINYL_PRESETS.map((c) => {
                const on = v.a === c.a && v.b === c.b;
                return (
                  <button key={c.id} className="vm-pair" role="radio" aria-checked={on} onClick={() => onChange({ a: c.a, b: c.b })}>
                    <span style={{ background: `conic-gradient(${c.a} 0deg 180deg, ${c.b} 180deg 360deg)` }} />
                    {t(c.name)}
                  </button>
                );
              })}
            </div>
            <div className="st-pickers">
              <label className="st-pick">
                <input type="color" value={v.a} onChange={(e) => onChange({ a: e.target.value.toUpperCase() })} />
                {t("主色")}
              </label>
              <label className="st-pick">
                <input type="color" value={v.b} onChange={(e) => onChange({ b: e.target.value.toUpperCase() })} />
                {t("副色")}
              </label>
            </div>
          </>
        )}
      </div>
    </>
  );
}
