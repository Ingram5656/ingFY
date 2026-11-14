import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Artwork, LyricLine, LyricsResult, NowPlaying, Snapshot } from "./types";
import { trackKey } from "./types";
import { attachTranslation, dropCredits, parseLrc, parseYrc, plainToLines } from "./lrc";
import { extractPalette, FALLBACK_PALETTE } from "./palette";

/** 订阅后端推送的正在播放、封面和桌面歌词锁定状态 */
export function usePlayer() {
  const [now, setNow] = useState<NowPlaying | null>(null);
  const [artwork, setArtwork] = useState<Artwork | null>(null);
  const [desktopLocked, setDesktopLocked] = useState(false);

  useEffect(() => {
    const unlisten: Promise<UnlistenFn>[] = [];
    invoke<Snapshot>("get_snapshot").then((s) => {
      setNow(s.now ? { ...s.now, receivedAt: Date.now() } : null);
      setArtwork(s.artwork);
      setDesktopLocked(s.desktopLocked);
    });
    unlisten.push(listen<NowPlaying | null>("now-playing", (e) => setNow(e.payload ? { ...e.payload, receivedAt: Date.now() } : null)));
    unlisten.push(listen<Artwork>("artwork", (e) => setArtwork(e.payload)));
    unlisten.push(listen<boolean>("desktop-locked", (e) => setDesktopLocked(e.payload)));
    return () => unlisten.forEach((p) => p.then((u) => u()));
  }, []);

  const currentArtwork = now && artwork && artwork.trackKey === trackKey(now) ? artwork : null;
  return { now, artwork: currentArtwork, desktopLocked };
}

/**
 * 实时播放进度（毫秒）。播放器只在播放、暂停、拖动时更新进度（Spotify 尤其如此），
 * 所以用"上次报告的进度 + 距那时过去的时间"来插值。
 */
export function usePosition(now: NowPlaying | null): number {
  const [pos, setPos] = useState(0);
  const nowRef = useRef(now);
  nowRef.current = now;

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const n = nowRef.current;
      if (n) {
        const sane = Math.abs(Date.now() - n.updatedAtMs) < 24 * 3600_000;
        const base = sane ? n.updatedAtMs : n.receivedAt ?? Date.now();
        const elapsed = n.playing ? Date.now() - base : 0;
        const p = n.positionMs + elapsed;
        setPos(n.durationMs > 0 ? Math.min(p, n.durationMs) : p);
      } else {
        setPos(0);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return pos;
}

export type LyricsState =
  | { status: "idle" | "loading" | "none" | "error"; lines: LyricLine[]; synced: false; source?: string; instrumental?: boolean }
  | { status: "ready"; lines: LyricLine[]; synced: boolean; source: string; wordSync?: boolean; translated?: boolean };

const lyricsCache = new Map<string, LyricsState>();

/** 把后端返回的歌词整理成行：逐字（YRC）优先，其次逐行 LRC，最后纯文本；去掉作词作曲信息、挂上翻译 */
function buildLyrics(r: LyricsResult | null): LyricsState {
  if (!r) return { status: "none", lines: [], synced: false };
  let lines: LyricLine[] = [];
  let synced = false;
  let wordSync = false;
  if (r.yrc) {
    lines = dropCredits(parseYrc(r.yrc));
    wordSync = synced = lines.length > 0;
  }
  if (!synced && r.synced) {
    lines = dropCredits(parseLrc(r.synced));
    synced = lines.length > 0;
  }
  if (!synced && r.plain) lines = dropCredits(plainToLines(r.plain));
  if (!lines.length) return { status: "none", lines: [], synced: false, instrumental: r.instrumental };
  if (synced && r.translation) lines = attachTranslation(lines, r.translation);
  return { status: "ready", lines, synced, source: r.source, wordSync, translated: lines.some((l) => !!l.trans) };
}

/** 换歌时拉歌词，结果按歌曲缓存。choice 是用户手动选的歌词版本（"换一个歌词"） */
export function useLyrics(now: NowPlaying | null, choice?: { source?: string; id?: string }): LyricsState {
  const track = now?.title ? trackKey(now) : "";
  const picked = choice?.source && choice?.id ? `${choice.source}:${choice.id}` : "";
  const key = track ? `${track}|${picked}` : "";
  const [state, setState] = useState<LyricsState>({ status: "idle", lines: [], synced: false });

  useEffect(() => {
    if (!key || !now) {
      setState({ status: "idle", lines: [], synced: false });
      return;
    }
    const cached = lyricsCache.get(key);
    if (cached) {
      setState(cached);
      return;
    }
    let alive = true;
    setState({ status: "loading", lines: [], synced: false });
    const request = picked
      ? invoke<LyricsResult | null>("lyrics_by_id", { source: choice!.source, id: choice!.id })
      : invoke<LyricsResult | null>("fetch_lyrics", {
          title: now.title,
          artist: now.artist,
          album: now.album,
          durationMs: now.durationMs,
        });
    request
      .then((r) => {
        let next: LyricsState;
        next = buildLyrics(r);
        lyricsCache.set(key, next);
        if (alive) setState(next);
      })
      .catch(() => alive && setState({ status: "error", lines: [], synced: false }));
    return () => {
      alive = false;
    };
    // 只在换歌时重新拉取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return state;
}

/** 专辑取色，并写进 CSS 变量 --c0…--c5、--accent，整个界面跟着变色 */
export function useAlbumPalette(artwork: Artwork | null): string[] {
  const [palette, setPalette] = useState<string[]>(FALLBACK_PALETTE);

  useEffect(() => {
    let alive = true;
    if (!artwork) {
      setPalette(FALLBACK_PALETTE);
      return;
    }
    extractPalette(artwork.dataUrl)
      .then((p) => alive && setPalette(p))
      .catch(() => alive && setPalette(FALLBACK_PALETTE));
    return () => {
      alive = false;
    };
  }, [artwork?.trackKey]);

  useEffect(() => {
    const root = document.documentElement;
    palette.forEach((c, i) => root.style.setProperty(`--c${i}`, c));
    root.style.setProperty("--accent", palette[Math.floor(palette.length / 2)] ?? "#FF6F91");
    root.style.setProperty("--accent-soft", palette[0] ?? "#FF9BB3");
  }, [palette]);

  return palette;
}

/**
 * 进度跳转。拖动时用预览位置；松手跳转后，在播放器确认新进度之前（最多 2.5 秒）
 * 先按目标位置往前走，避免进度条和歌词先弹回旧位置再跳过去。
 */
export function useSeek(now: NowPlaying | null, position: number) {
  const [preview, setPreview] = useState<number | null>(null);
  const [pending, setPending] = useState<{ ms: number; at: number } | null>(null);

  const seek = (ms: number) => {
    const target = Math.max(0, Math.round(ms));
    setPending({ ms: target, at: Date.now() });
    invoke<boolean>("media_seek", { positionMs: target }).catch(() => setPending(null));
  };

  let effective = position;
  if (preview !== null) {
    effective = preview;
  } else if (pending && now) {
    const acknowledged = now.updatedAtMs >= pending.at - 100 && Math.abs(now.positionMs - pending.ms) < 3000;
    if (!acknowledged && Date.now() - pending.at < 2500) {
      effective = pending.ms + (now.playing ? Date.now() - pending.at : 0);
    }
  }
  return { position: effective, seek, setPreview };
}

export function mediaControl(action: "toggle" | "next" | "previous") {
  return invoke<boolean>("media_control", { action }).catch(() => false);
}

export function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
