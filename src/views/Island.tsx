import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Karaoke } from "../components/Karaoke";
import { FitText } from "../components/FitText";
import { Lights } from "../components/Lights";
import { Disc } from "../components/Vinyl";
import { SeekBar } from "../components/SeekBar";
import { NextIcon, PauseIcon, PlayIcon, PrevIcon } from "../components/Icons";
import { onAudioLevels } from "../lib/audio";
import { findLineIndex, lineProgress } from "../lib/lrc";
import { useLyricPref } from "../lib/lyricPrefs";
import { trackKey } from "../lib/types";
import { mediaControl, useAlbumPalette, useLyrics, usePlayer, usePosition, useSeek } from "../lib/player";
import { islandScale, lightPalette, thickScale, useApplySettings, useSettings } from "../lib/settings";
import { LOOK_IDS, seedFrom } from "../lib/vinyl";
import { t, useLang } from "../lib/i18n";

/** 灵动岛的设计尺寸（缩放 1 倍时，逻辑像素） */
const COMPACT = { w: 380, h: 46 };
const EXPANDED = { w: 420, h: 172 };
/** 窗口比岛本身左右各宽一点、下面高一点，留给阴影 */
const PAD_X = 14;
const PAD_B = 18;
/** 收起动画的时长，动画播完再把窗口缩回去 */
const MORPH_MS = 420;

/**
 * 灵动岛：屏幕顶部的一颗黑色胶囊。左边专辑封面或唱片，右边逐字歌词，背后是拾音灯。
 *
 * 锁定：鼠标穿透，鼠标移上去时整个岛隐身，不挡下面的东西。
 * 不锁定：单击展开，出现进度条和上一首 / 播放暂停 / 下一首；按住拖动可以挪位置。
 * 贴在屏幕顶边时像刘海（上面两个角是直的），离开顶边就变成操场形状的圆角矩形。
 */
export default function Island() {
  useLang();
  const { now, artwork } = usePlayer();
  const rawPosition = usePosition(now);
  const { position, seek, setPreview } = useSeek(now, rawPosition);
  const key = now?.title ? trackKey(now) : "";
  const pref = useLyricPref(key);
  const lyrics = useLyrics(now, pref);
  const palette = useAlbumPalette(artwork);
  const [settings] = useSettings();
  useApplySettings(settings);

  const [expanded, setExpanded] = useState(false);
  const [docked, setDocked] = useState(true);
  const [ghost, setGhost] = useState(false);
  const scale = islandScale(settings.islandSize);
  const locked = settings.islandLocked;
  const open = expanded && !locked;

  // 显示 / 隐藏、锁定：交给后端改窗口（鼠标穿透只能在后端设）
  useEffect(() => {
    invoke<boolean>("island_set", { visible: settings.islandOn, locked })
      .then((d) => setDocked(d))
      .catch(() => {});
    if (locked) setExpanded(false);
    if (!locked) setGhost(false);
  }, [settings.islandOn, locked]);

  // 后端通知：贴边状态变了、锁定时鼠标进出。（托盘里的显示 / 隐藏由主窗口处理：这个窗口用到时才创建）
  useEffect(() => {
    const un = [
      listen<boolean>("island-dock", (e) => setDocked(e.payload)),
      listen<boolean>("island-hover", (e) => setGhost(e.payload)),
    ];
    return () => un.forEach((p) => p.then((u) => u()));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 窗口大小跟着岛走：展开时先把窗口放大再播动画；收起时动画播完再缩回去，免得把动画裁掉
  useEffect(() => {
    const size = open ? EXPANDED : COMPACT;
    const apply = () =>
      invoke("island_layout", {
        width: Math.round(EXPANDED.w * scale + PAD_X * 2),
        height: Math.round(size.h * scale + PAD_B),
      }).catch(() => {});
    if (open) {
      apply();
      return;
    }
    const timer = setTimeout(apply, MORPH_MS);
    return () => clearTimeout(timer);
  }, [open, scale]);

  // 展开后：窗口失去焦点、或者鼠标离开 4 秒，就自动收起
  useEffect(() => {
    if (!open) return;
    const close = () => setExpanded(false);
    window.addEventListener("blur", close);
    return () => window.removeEventListener("blur", close);
  }, [open]);
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>();
  const onLeave = () => {
    clearTimeout(leaveTimer.current);
    if (open) leaveTimer.current = setTimeout(() => setExpanded(false), 4000);
  };
  const onEnter = () => clearTimeout(leaveTimer.current);
  useEffect(() => () => clearTimeout(leaveTimer.current), []);

  // 单击展开 / 收起，按住拖动挪位置。按钮和进度条上的操作不算
  const press = useRef<{ x: number; y: number } | null>(null);
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (locked || e.button !== 0 || (e.target as HTMLElement).closest("button, .seek")) return;
    press.current = { x: e.clientX, y: e.clientY };
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const p = press.current;
    if (!p || Math.hypot(e.clientX - p.x, e.clientY - p.y) < 5) return;
    press.current = null;
    void getCurrentWindow().startDragging().catch(() => {});
  };
  const onUp = () => {
    if (!press.current) return;
    press.current = null;
    setExpanded((v) => !v);
  };

  // 字幕跟着低音轻轻跳一下
  const lyricRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = lyricRef.current;
    if (!el || !settings.beat) return;
    const off = onAudioLevels((bands) => {
      let low = 0;
      for (let i = 0; i < 8; i++) low = Math.max(low, bands[i] ?? 0);
      el.style.setProperty("--beat", low.toFixed(3));
    });
    return () => {
      off();
      el.style.setProperty("--beat", "0");
    };
  }, [settings.beat, open]);

  // ---------- 歌词 ----------
  const lyricPos = position + (pref.offset ?? 0);
  const lines = lyrics.lines;
  const idx = lyrics.synced ? findLineIndex(lines, lyricPos) : -1;
  const progress = lyrics.synced && idx >= 0 ? lineProgress(lines, idx, lyricPos, now?.durationMs ?? 0) : 0;
  let text: string;
  if (lyrics.status === "ready" && lyrics.synced) text = idx >= 0 ? lines[idx].text || "♪" : lines[0]?.text ?? "♪";
  else if (now?.title) text = now.artist ? `${now.title} · ${now.artist}` : now.title;
  else text = t("等待播放");
  const karaoke = lyrics.synced && idx >= 0;

  // ---------- 左边：封面或唱片 ----------
  const v = settings.islandVinyl;
  const discColors: [string, string] = v.colorMode === "custom" ? [v.a, v.b] : [palette[1] ?? "#FF6F91", palette[palette.length - 1] ?? "#6F48C6"];
  const seed = seedFrom(key || "ingfy");
  const look = v.look === "random" ? LOOK_IDS[seed % LOOK_IDS.length] : v.look;
  const artUrl = artwork?.dataUrl ?? null;
  const visual = (size: number) =>
    settings.islandLeft === "vinyl" ? (
      <Disc
        look={look}
        seed={seed}
        a={discColors[0]}
        b={discColors[1]}
        size={size}
        spinning={!!now?.playing}
        label={
          <span
            className="disc-label"
            style={
              v.label === "solid"
                ? { background: v.labelColor }
                : artUrl
                  ? { backgroundImage: `url(${artUrl})` }
                  : { background: `linear-gradient(135deg, ${discColors[0]}, ${discColors[1]})` }
            }
          />
        }
      />
    ) : (
      <span
        className="isl-art"
        style={{
          width: size,
          height: size,
          ...(artUrl ? { backgroundImage: `url(${artUrl})` } : { background: `linear-gradient(135deg, ${palette[1]}, ${palette[palette.length - 1]})` }),
        }}
      />
    );

  const sung = settings.islandLyricColorMode === "custom" ? settings.islandLyricColor : "color-mix(in srgb, #fff 45%, var(--c0))";
  const lyricLine = (
    <FitText className="isl-lyric" fitKey={`${text}|${open}|${scale}`} minScale={0.6} wrap={false}>
      {karaoke ? <Karaoke text={text} progress={progress} /> : text}
    </FitText>
  );

  return (
    <div
      className={`isl-root${settings.islandLightsOn && settings.islandLightStyle === "ink" ? " is-ink" : ""}${docked ? " is-docked" : ""}${open ? " is-open" : ""}${locked ? " is-locked" : ""}${ghost ? " is-ghost" : ""}`}
      style={{ "--s": scale, "--isl-sung": sung } as CSSProperties}
    >
      <div className="isl" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerEnter={onEnter} onPointerLeave={onLeave}>
        {settings.islandLightsOn && (
          <div className="isl-lights">
            <Lights palette={lightPalette(settings, palette)} style={settings.islandLightStyle} playing={!!now?.playing} reactive={settings.beat} thickness={thickScale(settings.lightThickness ?? 50)} />
          </div>
        )}

        {/* 收起时：一行 */}
        <div className="isl-compact" aria-hidden={open || undefined} ref={open ? undefined : lyricRef}>
          <span className="isl-visual">{visual(Math.round(34 * scale))}</span>
          <div className="isl-text">{lyricLine}</div>
        </div>

        {/* 展开时：封面、歌名、歌词、进度条、播放控制 */}
        <div className="isl-full" aria-hidden={!open || undefined} ref={open ? lyricRef : undefined}>
          <div className="isl-head">
            <span className="isl-visual">{visual(Math.round(64 * scale))}</span>
            <div className="isl-meta">
              <strong>{now?.title || "ingfy"}</strong>
              <small>{now?.artist || t("等待播放")}</small>
              <div className="isl-text">{lyricLine}</div>
            </div>
          </div>
          <div className="isl-seek">
            <SeekBar position={position} duration={now?.durationMs ?? 0} onPreview={setPreview} onSeek={seek} />
          </div>
          <div className="isl-controls">
            <button className="ibtn" aria-label={t("上一首")} tabIndex={open ? 0 : -1} onClick={() => mediaControl("previous")}>
              <PrevIcon size={Math.round(22 * scale)} />
            </button>
            <button className="ibtn isl-play" aria-label={now?.playing ? t("暂停") : t("播放")} tabIndex={open ? 0 : -1} onClick={() => mediaControl("toggle")}>
              {now?.playing ? <PauseIcon size={Math.round(26 * scale)} /> : <PlayIcon size={Math.round(26 * scale)} />}
            </button>
            <button className="ibtn" aria-label={t("下一首")} tabIndex={open ? 0 : -1} onClick={() => mediaControl("next")}>
              <NextIcon size={Math.round(22 * scale)} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
