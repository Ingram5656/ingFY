import { useEffect, useState } from "react";
import { EN } from "./i18n-en";

/**
 * 界面语言。写代码时直接用中文原文当 key：t("播放列表")。
 * 带变量的用 {名字} 占位：t("还剩 {n} 分钟", { n: 3 })。
 * 后端（Rust）返回的提示也是中文，显示前用 tMsg() 翻译，带数字的提示按占位模板匹配。
 */
export type Lang = "zh" | "en";
export type LangSetting = "system" | Lang;

export function resolveLang(s: LangSetting): Lang {
  if (s === "zh" || s === "en") return s;
  const nav = (typeof navigator !== "undefined" && (navigator.languages?.[0] || navigator.language)) || "zh";
  return nav.toLowerCase().startsWith("zh") ? "zh" : "en";
}

let current: Lang = resolveLang("system");
const listeners = new Set<(l: Lang) => void>();

export function getLang(): Lang {
  return current;
}

export function setLang(l: Lang) {
  if (l === current) return;
  current = l;
  document.documentElement.lang = l === "zh" ? "zh-CN" : "en";
  listeners.forEach((f) => f(l));
}

function fill(s: string, vars?: Record<string, string | number>) {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

export function t(zh: string, vars?: Record<string, string | number>): string {
  const s = current === "en" ? EN[zh] ?? zh : zh;
  return fill(s, vars);
}

// 带占位符的英文模板，预先编译成正则，用来翻译后端返回的、带数字或名字的中文提示
let templates: { re: RegExp; keys: string[]; en: string }[] | null = null;
function compile() {
  templates = Object.entries(EN)
    .filter(([zh]) => /\{\w+\}/.test(zh))
    .map(([zh, en]) => {
      const keys: string[] = [];
      const pattern = zh.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\\?\{(\w+)\\?\}/g, (_m, k) => {
        keys.push(k);
        return "(.+?)";
      });
      return { re: new RegExp(`^${pattern}$`), keys, en };
    });
}

/** 翻译后端或系统返回的整句提示：先找原文，再按带占位的模板匹配，都没有就原样返回 */
export function tMsg(msg: string): string {
  if (current !== "en") return msg;
  const s = msg.replace(/^Error:\s*/, "");
  if (EN[s]) return EN[s];
  if (!templates) compile();
  for (const tp of templates!) {
    const m = tp.re.exec(s);
    if (m) {
      const vars: Record<string, string> = {};
      tp.keys.forEach((k, i) => {
        let v = tMsg(m[i + 1]);
        // 句中的动作词用小写："Couldn't Play" → "Couldn't play"
        if (tp.en.indexOf(`{${k}}`) > 0 && /^[A-Z][a-z]+$/.test(v)) v = v.toLowerCase();
        vars[k] = v;
      });
      return fill(tp.en, vars);
    }
  }
  return s;
}

/** 让组件在切换语言时重新渲染 */
export function useLang(): Lang {
  const [l, setL] = useState(current);
  useEffect(() => {
    const f = (x: Lang) => setL(x);
    listeners.add(f);
    setL(current);
    return () => {
      listeners.delete(f);
    };
  }, []);
  return l;
}
