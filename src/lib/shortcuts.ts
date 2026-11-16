import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** 可以设快捷键的动作，顺序就是设置里列出来的顺序 */
export type ShortcutAction = "desktop" | "lock" | "play" | "previous" | "next" | "like";
export const SHORTCUT_ACTIONS: { id: ShortcutAction; label: string }[] = [
  { id: "desktop", label: "显示 / 隐藏桌面歌词" },
  { id: "lock", label: "锁定 / 解锁桌面歌词" },
  { id: "play", label: "播放 / 暂停" },
  { id: "previous", label: "上一首" },
  { id: "next", label: "下一首" },
  { id: "like", label: "收藏当前歌曲" },
];

/** 组合的写法和后端一致：修饰键在前、主键用 KeyboardEvent.code，如 "Ctrl+Alt+KeyL"。空字符串 = 不用 */
export type ShortcutMap = Record<ShortcutAction, string>;
export const DEFAULT_SHORTCUTS: ShortcutMap = {
  desktop: "Ctrl+Alt+KeyL",
  lock: "Ctrl+Alt+KeyU",
  play: "Ctrl+Alt+KeyP",
  previous: "Ctrl+Alt+ArrowLeft",
  next: "Ctrl+Alt+ArrowRight",
  like: "Ctrl+Alt+KeyK",
};

const MOD_LABEL: Record<string, string> = { Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift", Super: "Win" };
const KEY_LABEL: Record<string, string> = {
  ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓",
  Space: "Space", Enter: "Enter", Tab: "Tab", Backspace: "⌫", Delete: "Del", Insert: "Ins",
  Home: "Home", End: "End", PageUp: "PgUp", PageDown: "PgDn",
  Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: ";", Quote: "'",
  Comma: ",", Period: ".", Slash: "/", Backquote: "`",
  NumpadAdd: "Num +", NumpadSubtract: "Num -", NumpadMultiply: "Num *", NumpadDivide: "Num /", NumpadDecimal: "Num .", NumpadEnter: "Num Enter",
  MediaPlayPause: "⏯", MediaTrackNext: "⏭", MediaTrackPrevious: "⏮", MediaStop: "⏹",
  AudioVolumeUp: "Vol +", AudioVolumeDown: "Vol -", AudioVolumeMute: "Mute",
};

/** "Ctrl+Alt+KeyL" → ["Ctrl", "Alt", "L"]，用来画成一个个按键帽 */
export function accelCaps(accel: string): string[] {
  if (!accel) return [];
  return accel.split("+").map((part) => {
    if (MOD_LABEL[part]) return MOD_LABEL[part];
    if (KEY_LABEL[part]) return KEY_LABEL[part];
    if (/^Key[A-Z]$/.test(part)) return part.slice(3);
    if (/^Digit\d$/.test(part)) return part.slice(5);
    if (/^Numpad\d$/.test(part)) return `Num ${part.slice(6)}`;
    return part;
  });
}

/** 这些键单独按也可以当快捷键（不会和打字冲突） */
const SOLO_OK = /^(F([1-9]|1\d|2[0-4])|Media\w+|AudioVolume\w+|Pause|ScrollLock|PrintScreen)$/;
const MODIFIER_CODES = /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/;

/**
 * 录制：从一次按键得到组合。只按了修饰键返回 "partial"（界面上先显示按住的修饰键）；
 * 普通键必须带 Ctrl / Alt / Win 之一，不然打字时会误触，返回 "needs-mod"
 */
export function accelFromEvent(e: KeyboardEvent): { accel: string } | "partial" | "needs-mod" | null {
  const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super"].filter(Boolean) as string[];
  if (!e.code || e.code === "Unidentified") return null;
  if (MODIFIER_CODES.test(e.code)) return "partial";
  const strong = e.ctrlKey || e.altKey || e.metaKey;
  if (!strong && !SOLO_OK.test(e.code)) return "needs-mod";
  return { accel: [...mods, e.code].join("+") };
}

/** 只按着修饰键时，界面上先显示出来 */
export function heldModifiers(e: KeyboardEvent): string[] {
  return [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Win"].filter(Boolean) as string[];
}

export function shortcutsOf(saved: Partial<ShortcutMap> | undefined): ShortcutMap {
  return { ...DEFAULT_SHORTCUTS, ...(saved ?? {}) };
}

// ---- 后端注册的结果：哪个快捷键没生效、为什么。主窗口和设置面板在同一个页面里，用一个小仓库共享

let errors: Partial<Record<ShortcutAction, string>> = {};
const subs = new Set<() => void>();

/** 把一套快捷键交给后端注册，记下哪些没成功 */
export async function applyShortcuts(map: ShortcutMap): Promise<void> {
  try {
    const results = await invoke<{ action: ShortcutAction; error: string | null }[]>("set_shortcuts", {
      bindings: SHORTCUT_ACTIONS.map((a) => [a.id, map[a.id] ?? ""]),
    });
    errors = {};
    for (const r of results) if (r.error) errors[r.action] = r.error;
  } catch {
    errors = {};
  }
  subs.forEach((fn) => fn());
}

export function useShortcutErrors(): Partial<Record<ShortcutAction, string>> {
  const [value, setValue] = useState(errors);
  useEffect(() => {
    const fn = () => setValue(errors);
    subs.add(fn);
    return () => void subs.delete(fn);
  }, []);
  return value;
}

/** 录制新组合时让后端先停用全部快捷键 */
export function suspendShortcuts(suspended: boolean): void {
  invoke("suspend_shortcuts", { suspended }).catch(() => {});
}
