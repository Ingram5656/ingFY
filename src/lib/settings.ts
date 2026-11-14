import { REFIT_EVENT } from "../components/FitText";
import { useEffect, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import type { LightStyle } from "../components/Lights";
import { mixPalette } from "./palette";
import { invoke } from "@tauri-apps/api/core";
import { resolveLang, setLang, type LangSetting } from "./i18n";
import { setLightResponse, setLightSensitivity } from "./audio";

export type BackgroundKind = "fluid" | "gradient" | "image" | "cover";

export interface Settings {
  background: BackgroundKind;
  /** 背景模糊 0~100 */
  bgBlur: number;
  /** 背景暗度 0~100 */
  bgDim: number;
  lightStyle: LightStyle;
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
  /** 界面语言：跟随系统 / 中文 / English */
  language: LangSetting;
  /** 全屏歌词字号 0~100，50 是默认大小（实际缩放 0.7~1.3 倍） */
  lyricSize: number;
  /** 桌面歌词字号 0~100，50 是默认大小（实际缩放 0.8~1.2 倍） */
  desktopLyricSize: number;
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
  bgBlur: 60,
  bgDim: 30,
  lightStyle: "tube",
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
  language: "system",
  lyricSize: 50,
  desktopLyricSize: 50,
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
};

const KEY = "nige.settings";
const IMAGE_KEY = "nige.bgImage";

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    const saved = raw ? (JSON.parse(raw) as Partial<Settings>) : {};
    // 兼容 0.1.0：当时灯效单独存在 lightStyle 里
    const legacy = localStorage.getItem("lightStyle") as LightStyle | null;
    return { ...DEFAULT_SETTINGS, ...(legacy ? { lightStyle: legacy } : {}), ...saved };
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
    root.style.setProperty(
      "--lyric-sung",
      s.lyricColorMode === "custom" ? s.lyricColor : "color-mix(in srgb, #fff 45%, var(--c0))",
    );
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
export const deskScale = (v: number) => 0.8 + (v / 100) * 0.4;

/** 拾音灯实际使用的颜色：取自专辑，或者用户定的起止色渐变 */
export function lightPalette(s: Settings, album: string[]): string[] {
  return s.lightColorMode === "custom" ? mixPalette(s.lightA, s.lightB, 6) : album;
}
