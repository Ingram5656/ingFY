// 与 src-tauri/src/media.rs、lyrics.rs 里的结构一一对应

export interface NowPlaying {
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  positionMs: number;
  updatedAtMs: number;
  playing: boolean;
  sourceApp: string;
  /** 前端收到这条数据的本地时间，用来兜底插值 */
  receivedAt?: number;
}

export interface Artwork {
  trackKey: string;
  dataUrl: string;
}

export interface Snapshot {
  now: NowPlaying | null;
  artwork: Artwork | null;
  desktopLocked: boolean;
}

export interface LyricsResult {
  synced: string | null;
  plain: string | null;
  /** 网易云逐字歌词（YRC） */
  yrc: string | null;
  /** 翻译歌词（LRC） */
  translation: string | null;
  instrumental: boolean;
  source: string;
}

/** 逐字歌词里的一个字（或一个英文单词），时间都是毫秒 */
export interface LyricWord {
  start: number;
  end: number;
  text: string;
}

export interface LyricLine {
  /** 开始时间，毫秒 */
  time: number;
  text: string;
  /** 有逐字时间时才有；text 等于所有 words 的 text 拼起来 */
  words?: LyricWord[];
  /** 翻译 */
  trans?: string;
}

export function trackKey(n: Pick<NowPlaying, "title" | "artist" | "album">): string {
  return `${n.title}\u001f${n.artist}\u001f${n.album}`;
}
