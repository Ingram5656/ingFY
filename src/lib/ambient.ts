/**
 * 助眠模式的环境音：雨声、海浪、褐噪音、白噪音，可以几种叠在一起，各自调音量。
 * 声音文件在 public/ambient/ 里（和 ing番茄钟用的是同一套），循环播放。
 *
 * 谁在要声音有两处：助眠模式开着、音乐在放时的"正在放"，和设置里的"试听"。试听优先。
 * 雨声跟着画面走：晴天不响，雨量越大越响；滑块只管它的音量上限。
 */
import { audioContext } from "./sound";

export const AMBIENT_SOUNDS = [
  { id: "rain", label: "雨声" },
  { id: "waves", label: "海浪" },
  { id: "brown", label: "褐噪音" },
  { id: "white", label: "白噪音" },
] as const;
export type AmbientId = (typeof AMBIENT_SOUNDS)[number]["id"];
/** 每种声音的音量 0–1。0 或者没写就是不放 */
export type AmbientMix = Partial<Record<string, number>>;

/** 几个文件本身响度不一样，这里拉平；白噪音听着刺耳，压低一些 */
const BASE: Record<AmbientId, number> = { rain: 1, waves: 1.1, brown: 0.85, white: 0.6 };

/** 雨量 0–100 → 雨声有多响（0–1）：晴天没有，毛毛雨轻轻的，瓢泼大雨最响 */
export function rainLoudness(rain: number): number {
  const k = Math.max(0, Math.min(1, rain / 100));
  if (k <= 0) return 0;
  return Math.min(1, k / 0.04) * (0.32 + 0.68 * Math.pow(k, 0.7));
}

/** 设置里的滑块 + 现在的雨量 → 每种声音实际放多大声 */
export function ambientLevels(mix: AmbientMix, rain: number): Record<AmbientId, number> {
  const out = { rain: 0, waves: 0, brown: 0, white: 0 };
  for (const { id } of AMBIENT_SOUNDS) {
    const v = Math.max(0, Math.min(1, mix[id] ?? 0));
    // 滑块按听感走：一半的位置听着是一半响
    out[id] = v * v * BASE[id] * (id === "rain" ? rainLoudness(rain) : 1);
  }
  return out;
}

interface Voice {
  gain: GainNode;
  src: AudioBufferSourceNode | null;
  target: number;
  stop: ReturnType<typeof setTimeout> | null;
}

const voices = new Map<AmbientId, Voice>();
const buffers = new Map<AmbientId, Promise<AudioBuffer | null>>();
let live: Record<AmbientId, number> | null = null;
let preview: Record<AmbientId, number> | null = null;

function load(c: AudioContext, id: AmbientId): Promise<AudioBuffer | null> {
  let p = buffers.get(id);
  if (!p) {
    p = fetch(new URL(`ambient/${id}.ogg`, document.baseURI).href)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((data) => c.decodeAudioData(data))
      .catch(() => {
        buffers.delete(id); // 这次没读到，下次再试
        return null;
      });
    buffers.set(id, p);
  }
  return p;
}

function ramp(c: AudioContext, v: Voice, to: number, seconds: number) {
  const g = v.gain.gain;
  const now = c.currentTime;
  g.cancelScheduledValues(now);
  g.setValueAtTime(g.value, now);
  g.linearRampToValueAtTime(to, now + Math.max(0.03, seconds));
  v.target = to;
}

function apply(fade: number) {
  const want = preview ?? live;
  if (!want && voices.size === 0) return; // 从来没响过，不用去开声卡
  const c = audioContext();
  if (!c) return;
  if (want && c.state === "suspended") void c.resume().catch(() => {});
  for (const { id } of AMBIENT_SOUNDS) {
    const level = want ? want[id] : 0;
    let v = voices.get(id);
    if (level <= 0.0005) {
      if (!v || v.target === 0) continue;
      ramp(c, v, 0, fade);
      const voice = v;
      // 淡完以后把它停掉，不白白转着
      voice.stop = setTimeout(() => {
        voice.stop = null;
        if (voice.target !== 0 || !voice.src) return;
        try {
          voice.src.stop();
        } catch {
          /* 已经停了 */
        }
        voice.src = null;
      }, fade * 1000 + 300);
      continue;
    }
    if (!v) {
      v = { gain: c.createGain(), src: null, target: 0, stop: null };
      v.gain.gain.value = 0;
      v.gain.connect(c.destination);
      voices.set(id, v);
    }
    if (v.stop) {
      clearTimeout(v.stop);
      v.stop = null;
    }
    // 刚响起来的那一下淡入得慢一点，免得突然冒出来
    ramp(c, v, level, v.src ? fade : Math.max(fade, 1.6));
    if (!v.src) {
      const voice = v;
      void load(c, id).then((buf) => {
        if (!buf || voice.src || voice.target === 0) return;
        const src = c.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        src.connect(voice.gain);
        // 每次从不同的地方开始，几种声音叠着也不会每回都一个样
        src.start(0, Math.random() * buf.duration);
        voice.src = src;
      });
    }
  }
}

/** 助眠模式里正在放的环境音。levels 传 null 是停；fade：几秒内变过去 */
export function setAmbientLive(levels: Record<AmbientId, number> | null, fade: number) {
  live = levels;
  if (!preview) apply(fade);
}

/** 设置里的试听：不管助眠模式开没开、音乐放没放，先放出来听听。传 null 是停止试听 */
export function setAmbientPreview(levels: Record<AmbientId, number> | null) {
  const was = preview;
  preview = levels;
  apply(was && levels ? 0.2 : 0.8);
}
