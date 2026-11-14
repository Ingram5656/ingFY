import type { LyricLine, LyricWord } from "./types";

const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

/** 解析 LRC。一行可以有多个时间标签，比如 [00:12.30][01:40.20]副歌 */
export function parseLrc(lrc: string): LyricLine[] {
  const lines: LyricLine[] = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const tags = [...raw.matchAll(TIME_TAG)];
    if (tags.length === 0) continue;
    const text = raw.replace(TIME_TAG, "").trim();
    for (const t of tags) {
      const min = Number(t[1]);
      const sec = Number(t[2]);
      const frac = t[3] ?? "0";
      const ms = Number(frac.padEnd(3, "0").slice(0, 3));
      lines.push({ time: min * 60_000 + sec * 1000 + ms, text });
    }
  }
  lines.sort((a, b) => a.time - b.time);
  // 去掉开头的空行，保留中间的空行当间奏
  while (lines.length && !lines[0].text) lines.shift();
  return lines;
}

/** 没有时间轴的纯文本歌词，平均铺开只用于展示 */
export function plainToLines(plain: string): LyricLine[] {
  return plain
    .split(/\r?\n/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((text) => ({ time: Number.NaN, text }));
}

/** 当前应该高亮的行号，二分查找；还没到第一行时返回 -1 */
export function findLineIndex(lines: LyricLine[], positionMs: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= positionMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** 当前行的演唱进度 0~1。
 * 有逐字时间（网易云 YRC）时按真实时间算：唱完的字算满，正在唱的字按它自己的时长算一部分，
 * 再折算成"已唱字数 / 总字数"，交给 Karaoke 逐字填色；
 * 没有逐字时间时，用时间比例近似。 */
export function lineProgress(lines: LyricLine[], index: number, positionMs: number, durationMs: number): number {
  if (index < 0 || index >= lines.length) return 0;
  const line = lines[index];
  if (line.words?.length) return wordProgress(line.words, positionMs);
  const start = line.time;
  const next = index + 1 < lines.length ? lines[index + 1].time : Math.max(durationMs, start + 5000);
  // 一行最长按 8 秒算，避免长间奏前的最后一句填得太慢
  const end = Math.min(next, start + 8000);
  if (end <= start) return 1;
  return Math.min(1, Math.max(0, (positionMs - start) / (end - start)));
}

function wordProgress(words: LyricWord[], positionMs: number): number {
  let total = 0;
  let sung = 0;
  for (const w of words) {
    const n = Array.from(w.text).length;
    total += n;
    if (positionMs >= w.end) sung += n;
    else if (positionMs > w.start) sung += (n * (positionMs - w.start)) / Math.max(1, w.end - w.start);
  }
  return total ? Math.min(1, sung / total) : 1;
}

const YRC_LINE = /^\[(\d+),(\d+)\](.*)$/;
/** 只认 (数字,数字,数字) 这种时间标签，歌词里本来的括号不受影响 */
const YRC_TAG = /\((\d+),(\d+),\d+\)/;

/** 解析网易云 YRC 逐字歌词。每行：[行开始,行时长](字开始,字时长,0)字(…)字… */
export function parseYrc(yrc: string): LyricLine[] {
  const lines: LyricLine[] = [];
  for (const raw of yrc.split(/\r?\n/)) {
    const m = YRC_LINE.exec(raw.trim());
    if (!m) continue; // 开头的 {"t":0,"c":[…]} 是制作人员信息，跳过
    const words: LyricWord[] = [];
    // split 带捕获组：[标签前的文字, 开始, 时长, 文字, 开始, 时长, 文字, …]
    const parts = m[3].split(new RegExp(YRC_TAG.source, "g"));
    for (let i = 1; i + 2 < parts.length + 1; i += 3) {
      const start = Number(parts[i]);
      words.push({ start, end: start + Number(parts[i + 1]), text: parts[i + 2] ?? "" });
    }
    if (!words.length) continue;
    // 去掉首尾多余空格，字数和显示保持一致
    words[0].text = words[0].text.trimStart();
    words[words.length - 1].text = words[words.length - 1].text.trimEnd();
    const kept = words.filter((w) => w.text.length > 0);
    lines.push({ time: Number(m[1]), text: kept.map((w) => w.text).join(""), words: kept });
  }
  lines.sort((a, b) => a.time - b.time);
  return lines;
}

/** 制作人员信息行（作词、作曲、编曲…），网易云的歌词开头常带这些 */
const CREDIT = /^\s*(作词|作曲|编曲|作詞|作曲|編曲|词|曲|制作人|製作人|监制|監製|混音|混音工程师|母带|母带工程师|录音|录音师|录音工程师|和声|和音|吉他|贝斯|鼓|键盘|弦乐|出品|发行|出品人|统筹|企划|策划|OP|SP|ISRC|Lyricist|Lyrics|Composer|Arranger|Producer|Mixing|Mixed by|Mastering|Mastered by|Recording|Vocal Producer)\s*[:：]/i;

export function dropCredits(lines: LyricLine[]): LyricLine[] {
  return lines.filter((l) => !CREDIT.test(l.text));
}

/** 把翻译按时间挂到对应的行上（找时间最接近、相差 1.5 秒以内的一句） */
export function attachTranslation(lines: LyricLine[], translation: string): LyricLine[] {
  const trans = parseLrc(translation).filter((t) => t.text && !/^\/\/\s*$/.test(t.text));
  if (!trans.length) return lines;
  let j = 0;
  return lines.map((l) => {
    while (j + 1 < trans.length && Math.abs(trans[j + 1].time - l.time) <= Math.abs(trans[j].time - l.time)) j++;
    const t = trans[j];
    return t && Math.abs(t.time - l.time) <= 1500 && l.text ? { ...l, trans: t.text } : l;
  });
}
