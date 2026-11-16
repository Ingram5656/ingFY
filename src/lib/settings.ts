import { REFIT_EVENT } from "../components/FitText";
import { useEffect, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import type { LightStyle } from "../components/Lights";
import { mixPalette } from "./palette";
import { invoke } from "@tauri-apps/api/core";
import { resolveLang, setLang, type LangSetting } from "./i18n";
import { setLightResponse, setLightSensitivity } from "./audio";
import { DEFAULT_SHORTCUTS, shortcutsOf, type ShortcutMap } from "./shortcuts";
import type { ChatSplit } from "./chat";

export type BackgroundKind = "fluid" | "gradient" | "image" | "video" | "cover";
export type BaseMode = "default" | "album" | "custom" | "transparent";
export interface BasePref {
  mode: BaseMode;
  color: string;
}

/** 某种背景的底色设置。专辑流体必须有底色：存成透明的（旧设置里共用的那份）按默认算 */
export function baseOf(s: Settings, kind: BackgroundKind): BasePref {
  const p = s.baseByBg?.[kind] ?? { mode: s.baseColorMode, color: s.baseColor };
  return kind === "fluid" && p.mode === "transparent" ? { mode: "default", color: p.color } : p;
}
/** 改某种背景的底色，不动其他背景的 */
export function withBase(s: Settings, kind: BackgroundKind, patch: Partial<BasePref>): Partial<Settings> {
  return { baseByBg: { ...s.baseByBg, [kind]: { ...baseOf(s, kind), ...patch } } };
}

export interface Settings {
  background: BackgroundKind;
  /**
   * 底色：色块之间、边角透出来的那层颜色，也决定暗度层和纯色渐变的色调。
   * 每种背景各存一份（baseByBg）；某种背景还没单独设过时用这里的值——也就是 2.3.0 之前大家共用的那一份。
   * transparent：没有底色——背景不往任何颜色里混，暗度蒙版是不带色调的黑；专辑流体必须有底色，不能选
   */
  baseColorMode: BaseMode;
  baseColor: string;
  baseByBg: Partial<Record<BackgroundKind, BasePref>>;
  /** 背景模糊 0~100 */
  bgBlur: number;
  /** 背景暗度 0~100 */
  bgDim: number;
  lightStyle: LightStyle;
  /** 拾音灯 3D 模式：灯、场景和歌词变成立体的（只在全屏歌词界面生效） */
  light3d: boolean;
  /** 灯效选项的排列顺序（顶栏里可以拖动排序，设置里也按这个顺序） */
  lightOrder: LightStyle[];
  /** 全局快捷键，空字符串表示不用 */
  shortcuts: ShortcutMap;
  /** 灯光亮度 0~100 */
  lightBrightness: number;
  /** 色彩鲜艳度 0~100，50 为原色 */
  vividness: number;
  /** 跟着节拍闪烁；关掉后灯光只缓慢呼吸 */
  beat: boolean;
  /** 拾音灯总开关 */
  lightsOn: boolean;
  /** 灯的粗细 0~100，50 是原来的粗细（0.5~1.5 倍）；直方图变粗是减少柱子数量 */
  lightThickness: number;
  /** 灵敏度：同样大的声音灯跳多高，0~100，50 是原样 */
  lightSensitivity: number;
  /** 反应速度：灯起落有多快，0~100，50 是原样 */
  lightResponse: number;
  lyricColorMode: "album" | "custom";
  lyricColor: string;
  /** 有翻译时在歌词下面显示翻译 */
  showTranslation: boolean;
  /** 有罗马音时在全屏歌词原文下面显示 */
  showRomaji: boolean;
  /** 界面语言：跟随系统 / 中文 / English */
  language: LangSetting;
  /** 全屏歌词字号 0~100，50 是默认大小（实际缩放 0.7~1.3 倍） */
  lyricSize: number;
  /** 桌面歌词字号 0~100，50 是默认大小（实际缩放 0.8~1.2 倍） */
  desktopLyricSize: number;
  /** 桌面歌词唱到的字的颜色：跟全屏歌词一样 / 跟随专辑 / 固定颜色 */
  deskLyricColorMode: "same" | "album" | "custom";
  deskLyricColor: string;
  /** 桌面歌词没唱到的字的颜色 */
  deskRestColor: string;
  /** 桌面歌词背景透明度 0~100：0 是不透明的深色底，100 是完全透明，50 是原来的玻璃 */
  deskBgTransparency: number;
  /** 有罗马音时在桌面歌词每行下面显示 */
  deskShowRomaji: boolean;
  /** 桌面歌词条下面的拾音灯，和全屏的拾音灯分开开关 */
  deskLightsOn: boolean;
  /** 歌词界面：显示歌词 / 显示专辑封面和信息。两个都关时只剩拾音灯；拾音灯关着时这两项不能改，强制都显示 */
  showLyrics: boolean;
  showAlbum: boolean;
  /** 拾音灯颜色：取自专辑，或者固定的起止色渐变 */
  lightColorMode: "album" | "custom";
  lightA: string;
  lightB: string;
  /** 主界面显示歌词、唱片，还是曲库（歌单）/ 专辑 */
  viewMode: "lyrics" | "vinyl" | "playlists" | "albums";
  /** 唱片中间的标签：专辑封面 / 当前歌词 / 纯色印歌名 */
  vinylLabel: "album" | "lyric" | "solid";
  vinylLabelColor: string;
  /** 唱片外观，random 表示每次切歌随机换 */
  vinylLook: VinylLook | "random";
  /** 唱片颜色：取自专辑，或者自定义主色、副色 */
  vinylColorMode: "album" | "custom";
  vinylA: string;
  vinylB: string;
  /** 灵动岛：开关、锁定（悬停隐身、鼠标穿透）、大小 0~100（50 是默认大小） */
  islandOn: boolean;
  islandLocked: boolean;
  islandSize: number;
  /** 灵动岛左边：专辑封面 / 唱片 */
  islandLeft: "album" | "vinyl";
  /** 灵动岛自己的唱片外观（不带唱针） */
  islandVinyl: VinylPrefs;
  /** 灵动岛背景的拾音灯 */
  islandLightsOn: boolean;
  islandLightStyle: LightStyle;
  /** 灵动岛字幕唱到的字的颜色 */
  islandLyricColorMode: "album" | "custom";
  islandLyricColor: string;
  /** 聊天模式窗口：开关、置顶、浅色 / 深色 / 跟随系统、两个人怎么分、我的头像（小图 data URL，空字符串用默认头像） */
  chatWindowOn: boolean;
  chatOnTop: boolean;
  chatTheme: "light" | "dark" | "system";
  chatSplit: ChatSplit;
  chatAvatar: string;
  /** 桌面歌词上次是开着的：下次启动接着显示 */
  desktopOn: boolean;
  /** 所有歌的歌词整体提前（正）/ 推后（负）多少毫秒，每首歌自己的微调叠在上面。蓝牙耳机慢半拍时用 */
  lyricDelay: number;
  /** 关掉主窗口时：第一次问一下，之后照选的来 */
  closeAction: "ask" | "tray" | "quit";
  /** 右上角"小窗口"的说明气泡看过了 */
  tipWindowsSeen: boolean;
}

/** 一张唱片的外观设置：标签、花纹、颜色 */
export interface VinylPrefs {
  label: "album" | "lyric" | "solid";
  labelColor: string;
  look: VinylLook | "random";
  colorMode: "album" | "custom";
  a: string;
  b: string;
}

export type VinylLook = "classic" | "color" | "splatter" | "spots" | "split" | "swirl";

export const DEFAULT_SETTINGS: Settings = {
  background: "fluid",
  baseColorMode: "default",
  baseColor: "#1A1238",
  baseByBg: {},
  bgBlur: 60,
  bgDim: 30,
  lightStyle: "wave",
  light3d: false,
  lightOrder: ["ink", "hist", "ring", "wave"],
  shortcuts: DEFAULT_SHORTCUTS,
  lightBrightness: 80,
  vividness: 50,
  beat: true,
  lightsOn: true,
  lightThickness: 50,
  lightSensitivity: 50,
  lightResponse: 50,
  lyricColorMode: "album",
  lyricColor: "#FFFFFF",
  showTranslation: true,
  showRomaji: true,
  language: "system",
  lyricSize: 50,
  desktopLyricSize: 50,
  deskLyricColorMode: "same",
  deskLyricColor: "#FFFFFF",
  deskRestColor: "#FFFFFF",
  deskBgTransparency: 50,
  deskShowRomaji: false,
  deskLightsOn: true,
  showLyrics: true,
  showAlbum: true,
  lightColorMode: "album",
  lightA: "#FF5FA2",
  lightB: "#7B5CFF",
  viewMode: "lyrics",
  vinylLabel: "album",
  vinylLabelColor: "#F4EFE6",
  vinylLook: "classic",
  vinylColorMode: "album",
  vinylA: "#4BF0B5",
  vinylB: "#2F5BFF",
  islandOn: false,
  islandLocked: false,
  islandSize: 50,
  islandLeft: "album",
  islandVinyl: { label: "album", labelColor: "#F4EFE6", look: "classic", colorMode: "album", a: "#4BF0B5", b: "#2F5BFF" },
  islandLightsOn: true,
  islandLightStyle: "wave",
  islandLyricColorMode: "album",
  islandLyricColor: "#FFFFFF",
  chatWindowOn: false,
  chatOnTop: false,
  chatTheme: "light",
  chatSplit: "auto",
  chatAvatar: "",
  desktopOn: false,
  lyricDelay: 0,
  closeAction: "ask",
  tipWindowsSeen: false,
};

const KEY = "nige.settings";
const IMAGE_KEY = "nige.bgImage";

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    const saved = raw ? (JSON.parse(raw) as Partial<Settings>) : {};
    // 兼容 0.1.0：当时灯效单独存在 lightStyle 里
    const legacy = localStorage.getItem("lightStyle") as LightStyle | null;
    const merged = { ...DEFAULT_SETTINGS, ...(legacy ? { lightStyle: legacy } : {}), ...saved };
    // 2.1.0 去掉了"灯管"：之前选灯管的换成最接近的声波
    if ((merged.lightStyle as string) === "tube") merged.lightStyle = "wave";
    if ((merged.islandLightStyle as string) === "tube") merged.islandLightStyle = "wave";
    // 2.3.0 之前桌面歌词的灯跟着拾音灯总开关走：升级上来时沿用总开关当时的状态
    if (saved.deskLightsOn === undefined && saved.lightsOn !== undefined) merged.deskLightsOn = saved.lightsOn;
    // 以后新增的动作也要有默认组合
    merged.shortcuts = shortcutsOf(merged.shortcuts);
    return merged;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function loadBackgroundImage(): string | null {
  try {
    return localStorage.getItem(IMAGE_KEY);
  } catch {
    return null;
  }
}

/** 存自定义背景图。返回 false 表示图片太大存不下 */
export function saveBackgroundImage(dataUrl: string | null): boolean {
  try {
    if (dataUrl) localStorage.setItem(IMAGE_KEY, dataUrl);
    else localStorage.removeItem(IMAGE_KEY);
    emit("bg-image-changed", null);
    return true;
  } catch {
    return false;
  }
}

/** 把用户选的图片缩到最长边 2560，转成 JPEG，控制体积 */
export function downscaleImage(file: File, maxSide = 2560): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", 0.88));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("这个文件不是能打开的图片"));
    };
    img.src = url;
  });
}

/**
 * 设置。存在 localStorage，改动后广播给另一个窗口（主窗口 ↔ 桌面歌词）。
 */
export function useSettings(): [Settings, (patch: Partial<Settings>) => void] {
  const [settings, setSettings] = useState<Settings>(load);

  useEffect(() => {
    const un = listen<Settings>("settings-changed", (e) => setSettings(e.payload));
    return () => {
      un.then((u) => u());
    };
  }, []);

  const update = (patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        /* 存不下就只在本次运行生效 */
      }
      emit("settings-changed", next);
      return next;
    });
  };

  return [settings, update];
}

/** 把设置写成 CSS 变量和根元素的类名，界面各处直接读取 */
export function useApplySettings(s: Settings) {
  // 语言：通知所有用 useLang 的组件重绘，并让托盘菜单换成同一种语言
  useEffect(() => {
    const lang = resolveLang(s.language ?? "system");
    setLang(lang);
    void invoke("set_language", { lang }).catch(() => {});
  }, [s.language]);
  // 拾音灯灵敏度在每个窗口里换算；反应速度交给后端，在平滑频谱时用
  useEffect(() => {
    setLightSensitivity(s.lightSensitivity ?? 50);
  }, [s.lightSensitivity]);
  useEffect(() => {
    setLightResponse(s.lightResponse ?? 50);
    void invoke("set_light_response", { value: Math.round(s.lightResponse ?? 50) }).catch(() => {});
  }, [s.lightResponse]);
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--thick", String(thickScale(s.lightThickness ?? 50)));
    const albumSung = "color-mix(in srgb, #fff 45%, var(--c0))";
    const lyricSung = s.lyricColorMode === "custom" ? s.lyricColor : albumSung;
    root.style.setProperty("--lyric-sung", lyricSung);
    // 桌面歌词自己的颜色和背景
    const deskMode = s.deskLyricColorMode ?? "same";
    root.style.setProperty("--desk-sung", deskMode === "custom" ? s.deskLyricColor : deskMode === "album" ? albumSung : lyricSung);
    root.style.setProperty("--desk-rest", s.deskRestColor ?? "#FFFFFF");
    const [glass, solid] = deskBg(s.deskBgTransparency ?? 50);
    root.style.setProperty("--dl-glass", glass.toFixed(3));
    root.style.setProperty("--dl-solid", solid.toFixed(3));
    root.style.setProperty("--light-alpha", String(0.25 + (s.lightBrightness / 100) * 0.75));
    root.style.setProperty("--vivid", String(0.3 + (s.vividness / 100) * 1.4));
    root.style.setProperty("--bg-blur", `${(s.bgBlur / 100) * 60}px`);
    root.style.setProperty("--bg-dim", String((s.bgDim / 100) * 0.75));
    root.classList.toggle("calm", !s.beat);
    const lyricSize = String(lyricScale(s.lyricSize));
    const deskSize = String(deskScale(s.desktopLyricSize));
    const sizeChanged = root.style.getPropertyValue("--lyric-size") !== lyricSize || root.style.getPropertyValue("--desk-size") !== deskSize;
    root.style.setProperty("--lyric-size", lyricSize);
    root.style.setProperty("--desk-size", deskSize);
    // 字号变了：自适应宽度的歌词行要重新量（它们只在宽度变化时自动重算）
    if (sizeChanged) window.dispatchEvent(new Event(REFIT_EVENT));
  }, [s]);
}

export const lyricScale = (v: number) => 0.7 + (v / 100) * 0.6;
/** 拾音灯粗细：0.5~1.5 倍 */
export const thickScale = (v: number) => 0.5 + v / 100;
/** 灵动岛缩放：0.75~1.25 倍 */
export const islandScale = (v: number) => 0.75 + (v / 100) * 0.5;
/** 存下来的顺序可能缺项、重复或者带着已经去掉的灯效：整理成四个都在、各出现一次 */
export function lightOrderOf(order: readonly string[] | undefined): LightStyle[] {
  const all = DEFAULT_SETTINGS.lightOrder;
  const kept = (order ?? []).filter((id, i, a): id is LightStyle => (all as string[]).includes(id) && a.indexOf(id) === i);
  return [...kept, ...all.filter((id) => !kept.includes(id))];
}

export const deskScale = (v: number) => 0.8 + (v / 100) * 0.4;
/**
 * 桌面歌词背景：透明度 0~100 换算成两层的浓度。
 * 50 是原来的玻璃；往透明调，玻璃一起淡掉，100 时什么都没有；往不透明调，玻璃后面再垫一层越来越浓的深色。
 */
export function deskBg(transparency: number): [glass: number, solid: number] {
  const a = 1 - Math.max(0, Math.min(100, transparency)) / 100;
  return [Math.min(1, a * 2), Math.max(0, a * 2 - 1) * 0.85];
}

/** 拾音灯实际使用的颜色：取自专辑，或者用户定的起止色渐变 */
export function lightPalette(s: Settings, album: string[]): string[] {
  return s.lightColorMode === "custom" ? mixPalette(s.lightA, s.lightB, 6) : album;
}
