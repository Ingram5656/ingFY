import type { LyricLine } from "./types";

/**
 * 聊天模式：把歌词拆成两个人的对话。
 * L 是对方（头像用专辑封面），R 是我（自定义头像）。
 */
export type ChatSplit = "auto" | "section" | "duet" | "alternate";
export type Side = "L" | "R";

export interface ChatMessage {
  /** 发出来的时间，毫秒 */
  time: number;
  side: Side;
  text: string;
  trans?: string;
  /** 在这条消息上面插一个灰色时间（开头、间奏后） */
  stamp?: string;
  key: string;
}

type Voice = "M" | "F" | "both";

// 对唱标记：行首的「男：」「(女)」「【合】」这类
const TAG = /^\s*(?:[(（【[]\s*(男|女|合|合唱|男声|女声|男女|女男)\s*[)）】\]]\s*[:：]?|(男|女|合|合唱|男声|女声|男女|女男)\s*[:：])\s*/;

function voiceOf(tag: string): Voice {
  if (tag.startsWith("男") && tag.length <= 2 && tag !== "男女") return "M";
  if (tag.startsWith("女") && tag.length <= 2 && tag !== "女男") return "F";
  return "both";
}

/** 拿来判断"同一句又唱了一遍"：去掉空格和标点，不分大小写 */
function norm(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

const GAP = 8000;

export function fmtTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * 分人：
 * - 按对唱：歌词里有男 / 女标记时，先出现的那位是对方，另一位是我，合唱两边都发
 * - 按段落：重复出现的句子当副歌（我），其余是主歌（对方）
 * - 一句一换：轮流
 * - 自动：有对唱标记按对唱，没有就按段落；整首没有重复句就一句一换
 */
export function toChat(lines: LyricLine[], split: ChatSplit, synced: boolean): { messages: ChatMessage[]; mode: Exclude<ChatSplit, "auto"> } {
  // 先去掉标记，记下每句是谁唱的（标记一直管到下一个标记）
  let cur: Voice | null = null;
  let tagged = 0;
  const seen = new Set<Voice>();
  const items: { time: number; text: string; trans?: string; voice: Voice | null }[] = [];
  for (const l of lines) {
    let text = l.text;
    const m = text.match(TAG);
    if (m) {
      cur = voiceOf(m[1] ?? m[2]);
      seen.add(cur);
      tagged++;
      text = text.slice(m[0].length);
    }
    if (!text.trim()) continue;
    items.push({ time: l.time, text: text.trim(), trans: l.trans, voice: cur });
  }
  const hasDuet = tagged >= 2 && (seen.has("M") || seen.has("F")) && seen.size >= 2;

  const counts = new Map<string, number>();
  for (const it of items) counts.set(norm(it.text), (counts.get(norm(it.text)) ?? 0) + 1);
  const hasRepeat = [...counts.values()].some((n) => n >= 2);

  let mode: Exclude<ChatSplit, "auto"> =
    split === "auto" ? (hasDuet ? "duet" : hasRepeat ? "section" : "alternate") : split;
  if (mode === "duet" && !hasDuet) mode = hasRepeat ? "section" : "alternate";
  if (mode === "section" && !hasRepeat) mode = "alternate";

  // 按对唱时，先唱的那位当对方
  const firstVoice = items.find((it) => it.voice === "M" || it.voice === "F")?.voice ?? "F";

  const out: ChatMessage[] = [];
  let last = -Infinity;
  const push = (time: number, side: Side, it: (typeof items)[number], i: number, k: string) => {
    // 开头和长间隔（前奏、间奏）后面插一个时间
    const stamp = synced && time - last > GAP ? fmtTime(time) : undefined;
    out.push({ time, side, text: it.text, trans: it.trans, stamp, key: `${i}${k}` });
    last = time;
  };
  items.forEach((it, i) => {
    if (mode === "duet") {
      if (it.voice === "both") {
        push(it.time, "L", it, i, "a");
        push(it.time + 450, "R", it, i, "b");
      } else push(it.time, it.voice === null || it.voice === firstVoice ? "L" : "R", it, i, "");
    } else if (mode === "section") {
      push(it.time, (counts.get(norm(it.text)) ?? 0) >= 2 ? "R" : "L", it, i, "");
    } else push(it.time, i % 2 === 0 ? "L" : "R", it, i, "");
  });
  return { messages: out, mode };
}

/** 有多少条消息已经到点（时间有序） */
export function countShown(messages: ChatMessage[], position: number): number {
  let lo = 0;
  let hi = messages.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (messages[mid].time <= position) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
