import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { mirrored, onAudioLevels } from "../lib/audio";
import { Karaoke } from "../components/Karaoke";
import { FitText } from "../components/FitText";
import { HeartIcon, LockIcon, NextIcon, PauseIcon, PlayIcon, PrevIcon } from "../components/Icons";
import { findLineIndex, lineProgress } from "../lib/lrc";
import { useLyricPref } from "../lib/lyricPrefs";
import { trackKey } from "../lib/types";
import { mediaControl, useAlbumPalette, useLyrics, usePlayer, usePosition } from "../lib/player";
import { pickGradient } from "../lib/palette";
import { lightPalette, useApplySettings, useSettings } from "../lib/settings";
import { useSpotify } from "../lib/spotify";
import { t, useLang } from "../lib/i18n";

/**
 * 桌面歌词：两行 KTV 式交错。偶数行在上、左对齐；奇数行在下、右对齐。
 * 正在唱的那行逐步填色，另一行显示下一句。
 * 整个玻璃条可以拖动（data-tauri-drag-region），锁定后鼠标穿透。
 */
export default function DesktopLyrics() {
  useLang(); // 切换语言时整页重绘
  const { now, artwork, desktopLocked } = usePlayer();
  const position = usePosition(now);
  const pref = useLyricPref(now?.title ? trackKey(now) : "");
  const lyrics = useLyrics(now, pref);
  // 每首歌单独的时间微调：正数让歌词提前
  const lyricPos = position + (pref.offset ?? 0);
  const palette = useAlbumPalette(artwork);
  const [settings] = useSettings();
  useApplySettings(settings);
  const spotify = useSpotify(now);
  const glowRef = useRef<HTMLDivElement>(null);
  const dlRef = useRef<HTMLDivElement>(null);

  // 窗口高度跟着内容走：字调大后歌词条变高，窗口往上长（底边不动），控制栏和歌词都完整显示。
  // 窗口没能变高时（还没调过来、手动拉矮了），把整块按比例缩小装进窗口，不切掉任何一边
  useEffect(() => {
    const dl = dlRef.current;
    if (!dl) return;
    let asked = 0;
    const fit = () => {
      // 内容自己的高度；transform 缩放不影响它
      const need = Math.ceil(dl.offsetHeight) + 2;
      const fitScale = Math.min(1, window.innerHeight / need);
      dl.style.setProperty("--dl-fit", fitScale.toFixed(4));
      if (Math.abs(need - asked) >= 2 || Math.abs(window.innerHeight - need) > 1) {
        asked = need;
        invoke("desktop_fit", { height: need }).catch(() => {});
      }
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(dl);
    window.addEventListener("resize", fit);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, []);

  // 玻璃条下面的辉光也跟着音乐跳
  useEffect(() => {
    const box = glowRef.current;
    if (!box || !settings.beat) return;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const off = onAudioLevels((bands) => {
      const values = mirrored(bands, 9);
      const spans = box.children;
      for (let i = 0; i < spans.length; i++) (spans[i] as HTMLElement).style.setProperty("--lv", values[i].toFixed(3));
      if (values.some((v) => v > 0.02)) {
        box.classList.add("is-live");
        clearTimeout(idle);
        idle = setTimeout(() => box.classList.remove("is-live"), 1000);
      }
    });
    return () => {
      off();
      clearTimeout(idle);
      box.classList.remove("is-live");
    };
  }, [settings.beat]);

  const lines = lyrics.lines;
  const idx = lyrics.synced ? findLineIndex(lines, lyricPos) : -1;
  const progress = lyrics.synced ? lineProgress(lines, idx, lyricPos, now?.durationMs ?? 0) : 0;

  let top = "";
  let bottom = "";
  let activeTop = true;
  if (lyrics.status === "ready" && lyrics.synced) {
    const cur = Math.max(idx, 0);
    const curText = idx >= 0 ? lines[cur].text || "♪" : lines[0]?.text ?? "";
    const nextText = idx >= 0 ? lines[cur + 1]?.text ?? "" : "";
    activeTop = cur % 2 === 0;
    top = activeTop ? curText : nextText;
    bottom = activeTop ? nextText : curText;
  } else if (now?.title) {
    top = now.title;
    bottom = now.artist;
  } else {
    top = "ingfy";
    bottom = t("等待播放");
  }

  const karaokeTop = activeTop && lyrics.synced;
  const karaokeBottom = !activeTop && lyrics.synced;

  return (
    <div className={`dl${desktopLocked ? " is-locked" : ""}`} ref={dlRef}>
      <div className="dl-toolbar glass">
        <button className="ibtn" aria-label={t("上一首")} onClick={() => mediaControl("previous")}><PrevIcon size={18} /></button>
        <button className="ibtn" aria-label={now?.playing ? t("暂停") : t("播放")} onClick={() => mediaControl("toggle")}>
          {now?.playing ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
        </button>
        <button className="ibtn" aria-label={t("下一首")} onClick={() => mediaControl("next")}><NextIcon size={18} /></button>
        <span className="sep" aria-hidden="true" />
        {spotify.liked !== null && (
          <button
            className={`ibtn heart${spotify.liked ? " is-liked" : ""}`}
            aria-label={spotify.liked ? t("从 Spotify 收藏中移除") : t("收藏到 Spotify")}
            aria-pressed={spotify.liked}
            onClick={spotify.toggleLike}
          >
            <HeartIcon size={18} filled={spotify.liked} />
          </button>
        )}
        <button className="ibtn" aria-label={t("锁定桌面歌词")} onClick={() => invoke("set_desktop_locked", { locked: true })}>
          <LockIcon size={18} />
        </button>
      </div>

      <div className="dl-bar glass" data-tauri-drag-region>
        <div className={`dl-glow${settings.lightsOn ? "" : " is-hidden"}`} aria-hidden="true" ref={glowRef}>
          {Array.from({ length: 9 }, (_, i) => (
            <span key={i} style={{ background: pickGradient(lightPalette(settings, palette), i, 9), animationDelay: `${(i * 0.31) % 1.2}s` }} />
          ))}
        </div>
        <FitText className={`dl-line dl-line--top${activeTop ? " is-active" : ""}`} fitKey={top} minScale={0.55} wrap={false} data-tauri-drag-region>
          {lyrics.synced ? <Karaoke text={top} progress={karaokeTop && idx >= 0 ? progress : 0} /> : top}
        </FitText>
        <FitText className={`dl-line dl-line--bottom${!activeTop ? " is-active" : ""}`} fitKey={bottom} minScale={0.55} wrap={false} data-tauri-drag-region>
          {lyrics.synced ? <Karaoke text={bottom} progress={karaokeBottom && idx >= 0 ? progress : 0} /> : bottom}
        </FitText>
      </div>
    </div>
  );
}
