import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Artwork, LyricLine, LyricsResult, NowPlaying, Snapshot } from "./types";
import { trackKey } from "./types";
import { attachRomaji, attachTranslation, dropCredits, parseLrc, parseYrc, plainToLines } from "./lrc";
import { extractPalette, FALLBACK_PALETTE } from "./palette";
import { registerCache, useCacheEpoch } from "./cache";
import { t } from "./i18n";

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
    let last = 0;
    const tick = (ts: number) => {
      raf = requestAnimationFrame(tick);
      // 高刷屏上 rAF 一秒一两百次，进度最多更新 60 次就够顺滑，省下一半以上的重绘
      if (ts - last < 15) return;
      last = ts;
      setPos(livePosition(nowRef.current));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return pos;
}

/** 此刻播到哪了（毫秒）：播放器上次报告的进度 + 距那时过去的时间 */
export function livePosition(n: NowPlaying | null): number {
  if (!n) return 0;
  const sane = Math.abs(Date.now() - n.updatedAtMs) < 24 * 3600_000;
  const base = sane ? n.updatedAtMs : n.receivedAt ?? Date.now();
  const elapsed = n.playing ? Date.now() - base : 0;
  const p = n.positionMs + elapsed;
  return n.durationMs > 0 ? Math.min(p, n.durationMs) : p;
}

export type LyricsState =
  | { status: "idle" | "loading" | "none" | "error"; lines: LyricLine[]; synced: false; source?: string; instrumental?: boolean }
  | { status: "ready"; lines: LyricLine[]; synced: boolean; source: string; wordSync?: boolean; translated?: boolean; romanized?: boolean };

const lyricsCache = new Map<string, LyricsState>();
registerCache(() => lyricsCache.clear());
/** 最多记住最近 80 首的歌词，开着几天也不会越攒越多 */
const LYRICS_CACHE_MAX = 80;

/** 带上限的 Map 写入：超出上限时丢掉最早放进去的 */
export function remember<K, V>(map: Map<K, V>, key: K, value: V, max: number) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value as K);
}

/** 把后端返回的歌词整理成行：逐字（YRC）优先，其次逐行 LRC，最后纯文本；去掉作词作曲信息、挂上翻译和罗马音 */
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
  if (synced && r.romaji) lines = attachRomaji(lines, r.romaji);
  return { status: "ready", lines, synced, source: r.source, wordSync, translated: lines.some((l) => !!l.trans), romanized: lines.some((l) => !!l.roma) };
}

/** 换歌时拉歌词，结果按歌曲缓存。choice 是用户手动选的歌词版本（"换一个歌词"） */
export function useLyrics(now: NowPlaying | null, choice?: { source?: string; id?: string }): LyricsState {
  const track = now?.title ? trackKey(now) : "";
  const picked = choice?.source && choice?.id ? `${choice.source}:${choice.id}` : "";
  const key = track ? `${track}|${picked}` : "";
  const [state, setState] = useState<LyricsState>({ status: "idle", lines: [], synced: false });
  // 清理缓存后重新拉一次当前这首的歌词
  const epoch = useCacheEpoch();

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
        remember(lyricsCache, key, next, LYRICS_CACHE_MAX);
        if (alive) setState(next);
      })
      .catch(() => alive && setState({ status: "error", lines: [], synced: false }));
    return () => {
      alive = false;
    };
    // 只在换歌（或清理缓存）时重新拉取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, epoch]);

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

/** 跳转没成功时在本窗口发出的事件，detail 是 "refused"（播放器不接受）或 "error"（请求出错） */
export const SEEK_FAILED = "ingfy-seek-failed";
export type SeekFailure = "refused" | "error";

/**
 * 进度跳转。拖动时用预览位置；松手跳转后，在播放器确认新进度之前（最多 2.5 秒）
 * 先按目标位置往前走，避免进度条和歌词先弹回旧位置再跳过去。
 * 播放器拒绝（返回 false）或请求出错时，马上回到真实进度，并发出 SEEK_FAILED 让界面提示。
 */
export function useSeek(now: NowPlaying | null, position: number) {
  const [preview, setPreview] = useState<number | null>(null);
  const [pending, setPending] = useState<{ ms: number; at: number } | null>(null);

  const seek = (ms: number) => {
    const target = Math.max(0, Math.round(ms));
    const at = Date.now();
    setPending({ ms: target, at });
    const fail = (kind: SeekFailure) => {
      // 只撤销这一次跳转；用户已经又跳了一次的话，不去动新的那次
      setPending((p) => (p && p.at === at ? null : p));
      window.dispatchEvent(new CustomEvent<SeekFailure>(SEEK_FAILED, { detail: kind }));
    };
    invoke<boolean>("media_seek", { positionMs: target })
      .then((ok) => {
        if (ok === false) fail("refused");
      })
      .catch(() => fail("error"));
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

/** 跳转失败时给出一句提示，显示 3 秒；没有失败时是 null */
export function useSeekFailure(): string | null {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const on = (e: Event) => {
      const kind = (e as CustomEvent<SeekFailure>).detail;
      setMsg(kind === "refused" ? t("当前播放器不支持跳转进度") : t("跳转失败，请再试一次"));
      clearTimeout(timer);
      timer = setTimeout(() => setMsg(null), 3000);
    };
    window.addEventListener(SEEK_FAILED, on);
    return () => {
      window.removeEventListener(SEEK_FAILED, on);
      clearTimeout(timer);
    };
  }, []);
  return msg;
}

export function mediaControl(action: "toggle" | "next" | "previous") {
  return invoke<boolean>("media_control", { action }).catch(() => false);
}

export function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
