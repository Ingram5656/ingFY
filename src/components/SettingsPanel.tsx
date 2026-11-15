import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import type { Settings, BackgroundKind, BasePref } from "../lib/settings";
import { baseOf, withBase, lightOrderOf, downscaleImage, saveBackgroundImage } from "../lib/settings";
import type { LightStyle } from "./Lights";
import type { AccountStatus } from "../lib/spotify";
import { CheckIcon } from "./Icons";
import { COLOR_PRESETS, DEFAULT_BASE, deepTone, pickGradient } from "../lib/palette";
import { deskScale, islandScale, lightPalette, lyricScale, thickScale } from "../lib/settings";
import { Lights } from "./Lights";
import { Karaoke } from "./Karaoke";
import { VinylEditor } from "./Vinyl";
import { t, tMsg, useLang } from "../lib/i18n";
import { listen } from "@tauri-apps/api/event";
import { cacheSize, clearCaches, formatBytes } from "../lib/cache";
import { deleteBackgroundVideo, saveBackgroundVideo, useVideoPoster } from "../lib/bgvideo";
import { DEFAULT_SHORTCUTS, SHORTCUT_ACTIONS, accelCaps, accelFromEvent, heldModifiers, shortcutsOf, suspendShortcuts, useShortcutErrors, type ShortcutAction } from "../lib/shortcuts";

interface Props {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  palette: string[];
  artworkUrl: string | null;
  bgImage: string | null;
  account: AccountStatus;
  accountBusy: boolean;
  onLogin: () => void;
  onLogout: () => void;
  onClose: () => void;
  /** 启动时查到的更新信息，没查到为 null */
  updateInfo?: UpdateInfo | null;
}

export interface UpdateInfo {
  current: string;
  latest: string;
  hasUpdate: boolean;
  installerUrl: string | null;
  pageUrl: string | null;
  notes: string;
}

/**
 * 快捷键：点右边的按键帽开始录新组合，按下去就换上；Esc 取消，⌫ / Delete 清空（不用这个快捷键）。
 * 录制时所有全局快捷键先停用，免得按到旧组合触发了动作。
 * 同一个组合只能给一个动作用：录到别的动作正在用的组合，就从那个动作上挪过来
 */
function ShortcutsGroup({ settings, update }: { settings: Settings; update: (patch: Partial<Settings>) => void }) {
  const map = shortcutsOf(settings.shortcuts);
  const errors = useShortcutErrors();
  const [recording, setRecording] = useState<ShortcutAction | null>(null);
  const [held, setHeld] = useState<string[]>([]);
  const [hint, setHint] = useState<{ action: ShortcutAction; text: string } | null>(null);
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!recording) return;
    suspendShortcuts(true);
    setHeld([]);
    const done = () => {
      setRecording(null);
      setHeld([]);
    };
    const onDown = (e: KeyboardEvent) => {
      // 录制时的按键都归这里，别让面板的 Esc 关闭、方向键翻页之类的处理拿到
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) return done();
      if ((e.code === "Backspace" || e.code === "Delete") && !e.ctrlKey && !e.altKey && !e.metaKey) {
        update({ shortcuts: { ...map, [recording]: "" } });
        setNote("");
        return done();
      }
      const r = accelFromEvent(e);
      if (r === "partial") return setHeld(heldModifiers(e));
      if (r === "needs-mod") return setHint({ action: recording, text: t("要和 Ctrl、Alt 或 Win 一起按") });
      if (!r) return;
      const next = { ...map, [recording]: r.accel };
      const taken = SHORTCUT_ACTIONS.find((a) => a.id !== recording && map[a.id] === r.accel);
      if (taken) {
        next[taken.id] = "";
        setNote(t("这个组合原来给「{action}」用，已经挪过来了", { action: t(taken.label) }));
      } else setNote("");
      setHint(null);
      update({ shortcuts: next });
      done();
    };
    const onUp = (e: KeyboardEvent) => {
      e.stopImmediatePropagation();
      setHeld(heldModifiers(e));
    };
    // 点到别处、窗口失去焦点就算取消
    const onBlur = () => done();
    window.addEventListener("keydown", onDown, true);
    window.addEventListener("keyup", onUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onDown, true);
      window.removeEventListener("keyup", onUp, true);
      window.removeEventListener("blur", onBlur);
      suspendShortcuts(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);

  const changed = SHORTCUT_ACTIONS.some((a) => map[a.id] !== DEFAULT_SHORTCUTS[a.id]);
  return (
    <Group
      title={t("快捷键")}
      foot={
        note || changed ? (
          <>
            {note && <span>{note} </span>}
            {changed && (
              <button
                className="st-link"
                onClick={() => {
                  setNote("");
                  update({ shortcuts: { ...DEFAULT_SHORTCUTS } });
                }}
              >
                {t("恢复默认")}
              </button>
            )}
          </>
        ) : undefined
      }
    >
      {SHORTCUT_ACTIONS.map((a) => {
        const rec = recording === a.id;
        const caps = rec ? held : accelCaps(map[a.id]);
        const problem = rec ? (hint?.action === a.id ? hint.text : "") : errors[a.id] ? t(errors[a.id]!) : "";
        return (
          <div className={`st-cell st-key${problem ? " has-problem" : ""}`} key={a.id}>
            <span className="st-key-label">
              {t(a.label)}
              {problem && <small className="st-key-problem">{problem}</small>}
            </span>
            <button
              className={`st-kbd-btn${rec ? " is-recording" : ""}${!map[a.id] && !rec ? " is-empty" : ""}`}
              aria-label={rec ? t("按下新的组合键，Esc 取消，Delete 清空") : t("修改「{action}」的快捷键", { action: t(a.label) })}
              aria-pressed={rec}
              onClick={() => {
                setHint(null);
                setRecording(rec ? null : a.id);
              }}
            >
              <span className="st-kbds">
                {caps.length ? caps.map((x, i) => <kbd key={i}>{x}</kbd>) : <span className="st-kbd-empty">{rec ? t("按下新组合") : t("未设置")}</span>}
              </span>
            </button>
          </div>
        );
      })}
    </Group>
  );
}

/** 通用：开机自启、快捷键、版本与更新 */
function GeneralSection({ initial, settings, update }: { initial?: UpdateInfo | null; settings: Settings; update: (patch: Partial<Settings>) => void }) {
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [info, setInfo] = useState<UpdateInfo | null>(initial ?? null);
  const [state, setState] = useState<"idle" | "checking" | "installing">("idle");
  const [msg, setMsg] = useState("");

  const [version, setVersion] = useState("");
  useEffect(() => {
    invoke<boolean>("autostart_enabled").then(setAutostart).catch(() => setAutostart(false));
    getVersion().then(setVersion).catch(() => {});
  }, []);

  const toggleAutostart = async () => {
    try {
      setAutostart(await invoke<boolean>("set_autostart", { enabled: !autostart }));
    } catch (e) {
      setMsg(tMsg(String(e)));
    }
  };
  const check = async () => {
    setState("checking");
    setMsg("");
    try {
      const r = await invoke<UpdateInfo>("check_update");
      setInfo(r);
      if (!r.hasUpdate) setMsg(t("已经是最新版本"));
    } catch (e) {
      setMsg(tMsg(String(e)));
    } finally {
      setState("idle");
    }
  };
  // 缓存：显示占了多少硬盘空间，点一下清掉
  const [cacheBytes, setCacheBytes] = useState<number | null>(null);
  const [cacheState, setCacheState] = useState<"idle" | "clearing" | "done">("idle");
  useEffect(() => {
    void cacheSize().then(setCacheBytes);
    // 硬盘上那部分是后台清的，清完重新量一次
    const un = listen("cache-cleared", () => {
      void cacheSize().then(setCacheBytes);
      setCacheState("done");
    });
    return () => void un.then((f) => f());
  }, []);
  useEffect(() => {
    if (cacheState === "idle") return;
    // 后端迟迟没回话也别一直转；"已清理"显示两秒后变回按钮
    const timer = setTimeout(() => setCacheState("idle"), cacheState === "clearing" ? 8000 : 2000);
    return () => clearTimeout(timer);
  }, [cacheState]);
  const clearCache = async () => {
    setCacheState("clearing");
    try {
      await clearCaches();
    } catch (e) {
      setCacheState("idle");
      setMsg(tMsg(String(e)));
    }
  };

  const install = async () => {
    if (!info?.installerUrl) return;
    setState("installing");
    setMsg(t("正在下载新版本，下载完会自动打开安装程序…"));
    try {
      await invoke("install_update", { url: info.installerUrl });
    } catch (e) {
      setMsg(tMsg(String(e)));
      setState("idle");
    }
  };

  return (
    <>
      <Group title={t("语言")}>
        <div className="st-cell">
          <div className="st-seg" role="radiogroup" aria-label={t("语言")}>
            {(
              [
                ["system", t("跟随系统")],
                ["zh", "简体中文"],
                ["en", "English"],
              ] as const
            ).map(([id, name]) => (
              <button key={id} role="radio" aria-checked={(settings.language ?? "system") === id} onClick={() => update({ language: id })}>
                {name}
              </button>
            ))}
          </div>
        </div>
      </Group>
      <Group>
        <Toggle
          label={t("开机自动启动")}
          sub={t("开机后只显示桌面歌词，主窗口留在托盘")}
          on={!!autostart}
          disabled={autostart === null}
          onChange={() => void toggleAutostart()}
        />
      </Group>
      <ShortcutsGroup settings={settings} update={update} />
      <Group title={t("存储")}>
        <div className="st-cell st-update">
          <span>{t("缓存")}</span>
          <span className="st-cache-size">{cacheBytes === null ? "" : formatBytes(cacheBytes)}</span>
          <button className="st-btn" onClick={() => void clearCache()} disabled={cacheState !== "idle"}>
            {cacheState === "clearing" ? t("正在清理…") : cacheState === "done" ? t("已清理") : t("清理")}
          </button>
        </div>
      </Group>
      <Group title={t("关于")} foot={msg || undefined}>
        <div className="st-cell st-update">
          <span className="st-option-text">
            <span>
              ingfy {info?.current ?? version}
              {info?.hasUpdate && <em className="st-new">{t("新版本 {v}", { v: info.latest })}</em>}
            </span>
            <small>{info?.hasUpdate ? t("下载后会自动打开安装程序") : t("从 GitHub 检查新版本")}</small>
          </span>
          {info?.hasUpdate && info.installerUrl ? (
            <button className="st-btn st-btn--primary" onClick={install} disabled={state !== "idle"}>
              {state === "installing" ? t("正在更新…") : t("立即更新")}
            </button>
          ) : (
            <button className="st-btn" onClick={check} disabled={state !== "idle"}>
              {state === "checking" ? t("正在检查…") : t("检查更新")}
            </button>
          )}
        </div>
      </Group>
      <Credits />
    </>
  );
}

const TAGLINE_KEY = "ingfy.tagline";
/** 关于页署名下面默认的那句话，可以点一下改成自己的 */
const DEFAULT_TAGLINE = "Do whatever you want and f**k the rest";

/** 关于页最下面的署名，以及一句自己写的话（点一下就能改，存在本地） */
function Credits() {
  const [line, setLine] = useState(() => {
    try {
      return localStorage.getItem(TAGLINE_KEY) ?? DEFAULT_TAGLINE;
    } catch {
      return DEFAULT_TAGLINE;
    }
  });
  const [editing, setEditing] = useState(false);
  const save = (v: string) => {
    const text = v.trim();
    setLine(text);
    setEditing(false);
    try {
      // 清空也记下来（存空字符串），不会又变回默认那句
      localStorage.setItem(TAGLINE_KEY, text);
    } catch {
      /* 存不下就算了 */
    }
  };
  return (
    <footer className="st-credits">
      <p className="st-made">
        Made by <strong>Ingram</strong> &amp; <strong>Claude</strong>
      </p>
      {editing ? (
        <input
          className="st-input st-tagline-input"
          autoFocus
          defaultValue={line}
          maxLength={60}
          placeholder={t("写一句你喜欢的话")}
          aria-label={t("写一句你喜欢的话")}
          onBlur={(e) => save(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save((e.target as HTMLInputElement).value);
            if (e.key === "Escape") setEditing(false);
          }}
        />
      ) : (
        <button className={`st-tagline${line ? "" : " is-empty"}`} onClick={() => setEditing(true)} title={t("点一下修改")}>
          {line || t("点这里写一句你喜欢的话")}
        </button>
      )}
    </footer>
  );
}

const LYRIC_PRESETS = [
  { c: "#FFFFFF", name: "白色" },
  { c: "#FFD166", name: "暖黄" },
  { c: "#7FD3FF", name: "天蓝" },
  { c: "#B8F2A0", name: "薄荷绿" },
  { c: "#FF8A80", name: "珊瑚红" },
  { c: "#C9A7FF", name: "淡紫" },
];

/** 一排颜色预设 + 一个自选色。active 为 false 时一个都不选中（比如当前是"跟随专辑"） */
function Swatches({ value, active, onPick, label }: { value: string; active: boolean; onPick: (c: string) => void; label: string }) {
  const v = value.toUpperCase();
  return (
    <div className="st-swatches" role="radiogroup" aria-label={label}>
      {LYRIC_PRESETS.map((c) => (
        <button
          key={c.c}
          className="st-swatch"
          role="radio"
          aria-checked={active && v === c.c}
          aria-label={t(c.name)}
          style={{ background: c.c }}
          onClick={() => onPick(c.c)}
        />
      ))}
      <label className="st-swatch st-swatch--pick" aria-label={t("更多颜色")}>
        <input type="color" value={value} onChange={(e) => onPick(e.target.value.toUpperCase())} />
        {/* 自己挑的颜色不在预设里时显示该颜色，否则显示彩色色环 */}
        <span style={{ background: active && !LYRIC_PRESETS.some((c) => c.c === v) ? value : "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)" }} />
      </label>
    </div>
  );
}

/**
 * 桌面歌词预览：用桌面歌词同一套样式，摆在一张"桌面壁纸"上，
 * 调透明度时能看到后面的东西透出来多少；按 820 宽画好再整体缩小。
 */
function DesktopPreview({ showRomaji, lights }: { showRomaji: boolean; lights: string[] | null }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.6);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(el.clientWidth / 820));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="st-dlpv" ref={boxRef} role="img" aria-label={t("桌面歌词预览")}>
      <div className="st-dlpv-wall" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <div className="st-dlpv-stage" style={{ transform: `scale(${scale})` }}>
        <div className="dl-bar glass">
          {lights && (
            <div className="dl-glow" aria-hidden="true">
              {Array.from({ length: 9 }, (_, i) => (
                <span key={i} style={{ background: pickGradient(lights, i, 9), animationDelay: `${(i * 0.31) % 1.2}s` }} />
              ))}
            </div>
          )}
          <p className="dl-line dl-line--top is-active">
            <Karaoke text="君の声が聞こえる" progress={0.55} />
            {showRomaji && <span className="dl-roma">kimi no koe ga kikoeru</span>}
          </p>
          <p className="dl-line dl-line--bottom">
            <Karaoke text="明日もきっと晴れる" progress={0} />
            {showRomaji && <span className="dl-roma">ashita mo kitto hareru</span>}
          </p>
        </div>
      </div>
    </div>
  );
}

/** 底色预设：都是深色，白字放上去依然清楚 */
const BASE_PRESETS = [
  { c: "#0E1A33", name: "午夜蓝" },
  { c: "#0F2420", name: "墨绿" },
  { c: "#2A0F18", name: "酒红" },
  { c: "#2A1D14", name: "暖棕" },
  { c: "#141414", name: "炭黑" },
  { c: "#000000", name: "纯黑" },
];

const LIGHT_STYLES: { id: LightStyle; label: string }[] = [
  { id: "ink", label: "墨晕" },
  { id: "hist", label: "直方图" },
  { id: "ring", label: "圆环" },
  { id: "wave", label: "声波" },
];

/** 设置里的灯效也按顶栏拖出来的顺序排 */
function orderedStyles(order: LightStyle[] | undefined) {
  return lightOrderOf(order).map((id) => LIGHT_STYLES.find((l) => l.id === id)!);
}

function Slider({ label, value, onChange, display }: { label: string; value: number; onChange: (v: number) => void; display?: string }) {
  return (
    <label className="st-slider">
      <span>
        {label}
        {display && <em className="st-val">{display}</em>}
      </span>
      <input type="range" min={0} max={100} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

/** 滑块数值的文字说明：50 附近是"默认" */
function levelWord(v: number): string {
  if (v <= 15) return t("很低");
  if (v < 40) return t("低");
  if (v <= 60) return t("默认");
  if (v < 85) return t("高");
  return t("很高");
}

/**
 * 拾音灯预览：和全屏界面同一套灯，按 1440 宽的设计尺寸画好后整体缩小。
 * 正在放歌时跟着真实声音跳，没声音时用一段假节奏，拖滑块马上能看出差别。
 */
function LightPreview({ style, palette, thickness, beat }: { style: LightStyle; palette: string[]; thickness: number; beat: boolean }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.4);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(el.clientWidth / 1440));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div className={`st-lpv${style === "ink" ? " is-ink" : ""}`} ref={boxRef} aria-label={t("拾音灯预览")} role="img">
      <div className="st-lpv-stage" style={{ transform: `scale(${scale})` }}>
        <Lights palette={palette} style={style} playing reactive={beat} thickness={thickness} demo />
      </div>
      {!beat && <span className="st-lpv-tag">{t("跟着节拍闪烁已关闭")}</span>}
    </div>
  );
}

/** 灯效缩略图：用当前专辑色画一个小样 */
function LightThumb({ id, palette }: { id: LightStyle; palette: string[] }) {
  // 墨晕的配色是固定的，缩略图也不跟专辑色
  if (id === "ink") {
    return (
      <span className="thumb-ink">
        <i />
        <i />
        <i />
      </span>
    );
  }
  if (id === "ring") {
    return (
      <span className="thumb-ring">
        {Array.from({ length: 16 }, (_, i) => (
          <span
            key={i}
            style={{
              transform: `rotate(${i * 22.5}deg) translateY(-14px)`,
              height: `${6 + 8 * Math.abs(Math.sin(i * 0.8))}px`,
              background: pickGradient(palette, Math.abs(8 - i), 9),
            }}
          />
        ))}
      </span>
    );
  }
  const n = id === "hist" ? 9 : 12;
  return (
    <span className={`thumb-bars thumb-bars--${id}`}>
      {Array.from({ length: n }, (_, i) => {
        const v =
          id === "hist" ? Math.exp(-i / 5) * (0.7 + 0.3 * Math.abs(Math.sin(i))) : Math.abs(Math.sin(i * 0.9 + 0.4));
        return <span key={i} style={{ height: `${20 + v * 70}%`, background: pickGradient(palette, i, n) }} />;
      })}
    </span>
  );
}

export function SettingsPanel(p: Props) {
  useLang();
  const { settings: s, update } = p;
  const lightPal = lightPalette(s, p.palette);
  const fileRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLInputElement>(null);
  const [imgError, setImgError] = useState<string | null>(null);
  const videoPoster = useVideoPoster();
  const hasVideo = videoPoster !== null;
  const [importing, setImporting] = useState(false);
  const [page, setPageRaw] = useState<PageId>(lastPage);
  const setPage = (id: PageId) => {
    lastPage = id;
    setPageRaw(id);
  };

  const pickImage = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const url = await downscaleImage(file);
      if (!saveBackgroundImage(url)) {
        setImgError(t("图片太大了，换一张小一点的试试"));
        return;
      }
      setImgError(null);
      update({ background: "image" });
    } catch (err) {
      setImgError(String((err as Error).message ?? err));
    }
  };

  const pickVideo = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setImporting(true);
    setImgError(null);
    try {
      await saveBackgroundVideo(file);
      update({ background: "video" });
    } catch (err) {
      setImgError(t(String((err as Error).message ?? err)));
    } finally {
      setImporting(false);
    }
  };

  const bgOptions: { id: BackgroundKind; label: string; style: CSSProperties }[] = [
    {
      id: "fluid",
      label: "专辑流体",
      style: {
        background: `radial-gradient(circle at 25% 30%, ${p.palette[1] ?? "#FF6F91"}, transparent 55%), radial-gradient(circle at 75% 70%, ${p.palette[p.palette.length - 1] ?? "#6F48C6"}, transparent 55%), #1a1238`,
      },
    },
    {
      id: "gradient",
      label: "纯色渐变",
      style: { background: `linear-gradient(135deg, color-mix(in srgb, ${p.palette[1]} 55%, #120c2a), color-mix(in srgb, ${p.palette[p.palette.length - 1]} 60%, #120c2a))` },
    },
    {
      id: "image",
      label: p.bgImage ? "我的图片" : "选择图片",
      style: p.bgImage ? { backgroundImage: `url(${p.bgImage})`, backgroundSize: "cover", backgroundPosition: "center" } : {},
    },
    {
      id: "video",
      label: hasVideo ? "我的视频" : "选择视频",
      style: videoPoster ? { backgroundImage: `url(${videoPoster})`, backgroundSize: "cover", backgroundPosition: "center" } : {},
    },
    {
      id: "cover",
      label: "专辑封面放大",
      style: p.artworkUrl
        ? { backgroundImage: `url(${p.artworkUrl})`, backgroundSize: "cover", backgroundPosition: "center", filter: "blur(6px)" }
        : { background: "linear-gradient(135deg, #FF6F91, #3B2A8C)" },
    },
  ];

  // 底色按当前选中的背景样式各存一份
  const bp = baseOf(s, s.background);
  const setBase = (patch: Partial<BasePref>) => update(withBase(s, s.background, patch));

  const chooseBg = (id: BackgroundKind) => {
    if (id === "image" && !p.bgImage) {
      fileRef.current?.click();
      return;
    }
    if (id === "video" && !hasVideo) {
      if (!importing) videoRef.current?.click();
      return;
    }
    update({ background: id });
  };

  const lyricColorSwatches = (
    <div className="st-swatches" role="radiogroup" aria-label={t("固定颜色")}>
      {LYRIC_PRESETS.map((c) => {
        const on = s.lyricColorMode === "custom" && s.lyricColor.toUpperCase() === c.c;
        return (
          <button
            key={c.c}
            className="st-swatch"
            role="radio"
            aria-checked={on}
            aria-label={t(c.name)}
            style={{ background: c.c }}
            onClick={() => update({ lyricColorMode: "custom", lyricColor: c.c })}
          />
        );
      })}
      <label className="st-swatch st-swatch--pick" aria-label={t("更多颜色")}>
        <input type="color" value={s.lyricColor} onChange={(e) => update({ lyricColorMode: "custom", lyricColor: e.target.value.toUpperCase() })} />
        {/* 自己挑的颜色不在预设里时显示该颜色，否则显示彩色色环 */}
        <span
          style={{
            background:
              s.lyricColorMode === "custom" && !LYRIC_PRESETS.some((c) => c.c === s.lyricColor.toUpperCase())
                ? s.lyricColor
                : "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)",
          }}
        />
      </label>
    </div>
  );

  const pages: Record<PageId, JSX.Element> = {
    look: (
      <>
        <Group title={t("样式")}>
          <div className="st-cell">
            <div className="st-tiles st-tiles--bg" role="radiogroup" aria-label={t("背景")}>
              {bgOptions.map((o) => (
                <button key={o.id} className="st-tile" role="radio" aria-checked={s.background === o.id} onClick={() => chooseBg(o.id)}>
                  <span className="st-thumb" style={o.style}>
                    {o.id === "image" && !p.bgImage && <span className="st-upload">{t("点击选择")}</span>}
                    {o.id === "video" && (!hasVideo || importing) && <span className="st-upload">{importing ? t("正在导入…") : t("点击选择")}</span>}
                    {o.id === "video" && hasVideo && !importing && (
                      <span className="st-play-badge" aria-hidden="true">
                        <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 1l7 4-7 4z" fill="currentColor" /></svg>
                      </span>
                    )}
                    {s.background === o.id && (
                      <span className="st-check">
                        <CheckIcon />
                      </span>
                    )}
                  </span>
                  <span>{t(o.label)}</span>
                </button>
              ))}
            </div>
            {p.bgImage && (
              <div className="st-row-btns">
                <button className="st-link" onClick={() => fileRef.current?.click()}>
                  {t("换一张图片")}
                </button>
                <button
                  className="st-link"
                  onClick={() => {
                    saveBackgroundImage(null);
                    if (s.background === "image") update({ background: "fluid" });
                  }}
                >
                  {t("删除图片")}
                </button>
              </div>
            )}
            {hasVideo && (
              <div className="st-row-btns">
                <button className="st-link" disabled={importing} onClick={() => videoRef.current?.click()}>
                  {t("换一个视频")}
                </button>
                <button
                  className="st-link"
                  disabled={importing}
                  onClick={() => {
                    void deleteBackgroundVideo();
                    if (s.background === "video") update({ background: "fluid" });
                  }}
                >
                  {t("删除视频")}
                </button>
              </div>
            )}
            {imgError && (
              <p className="st-error" role="alert">
                {imgError}
              </p>
            )}
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={pickImage} />
            <input ref={videoRef} type="file" accept="video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov,.m4v" hidden onChange={pickVideo} />
          </div>
        </Group>
        <Group title={`${t("底色")}（${t(bgOptions.find((o) => o.id === s.background)?.label ?? "")}）`}>
          <button className="st-cell st-choice" role="radio" aria-checked={bp.mode === "default"} onClick={() => setBase({ mode: "default" })}>
            <span className="st-dot" style={{ background: DEFAULT_BASE }} />
            <span className="st-option-text">
              <span>{t("默认")}</span>
              <small>{t("ingfy 的深紫")}</small>
            </span>
            {bp.mode === "default" && <CheckIcon />}
          </button>
          <button className="st-cell st-choice" role="radio" aria-checked={bp.mode === "album"} onClick={() => setBase({ mode: "album" })}>
            <span className="st-dot" style={{ background: deepTone(p.palette) }} />
            <span className="st-option-text">
              <span>{t("跟随专辑")}</span>
              <small>{t("用封面的颜色压暗，换歌时自动换色")}</small>
            </span>
            {bp.mode === "album" && <CheckIcon />}
          </button>
          {/* 专辑流体是几团光飘在底色上，必须有底色，所以选流体时不能选透明 */}
          <button
            className="st-cell st-choice"
            role="radio"
            aria-checked={bp.mode === "transparent" && s.background !== "fluid"}
            aria-disabled={s.background === "fluid"}
            onClick={() => s.background !== "fluid" && setBase({ mode: "transparent" })}
          >
            <span className="st-dot st-dot--clear" />
            <span className="st-option-text">
              <span>{t("透明")}</span>
              <small>{s.background === "fluid" ? t("专辑流体需要底色，换成其他背景后可选") : t("不加底色，背景不往任何颜色里混")}</small>
            </span>
            {bp.mode === "transparent" && s.background !== "fluid" && <CheckIcon />}
          </button>
          <div className="st-cell">
            <span className="st-cell-label">{t("固定颜色")}</span>
            <div className="st-swatches" role="radiogroup" aria-label={t("底色")}>
              {BASE_PRESETS.map((c) => (
                <button
                  key={c.c}
                  className="st-swatch st-swatch--dark"
                  role="radio"
                  aria-checked={bp.mode === "custom" && bp.color.toUpperCase() === c.c}
                  aria-label={t(c.name)}
                  style={{ background: c.c }}
                  onClick={() => setBase({ mode: "custom", color: c.c })}
                />
              ))}
              <label className="st-swatch st-swatch--pick" aria-label={t("更多颜色")}>
                <input type="color" value={bp.color} onChange={(e) => setBase({ mode: "custom", color: e.target.value.toUpperCase() })} />
                <span
                  style={{
                    background:
                      bp.mode === "custom" && !BASE_PRESETS.some((c) => c.c === bp.color.toUpperCase())
                        ? bp.color
                        : "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)",
                  }}
                />
              </label>
            </div>
          </div>
        </Group>
        <Group>
          <div className="st-cell">
            <Slider label={t("背景模糊")} value={s.bgBlur} display={`${s.bgBlur}`} onChange={(v) => update({ bgBlur: v })} />
          </div>
          <div className="st-cell">
            <Slider label={t("背景暗度")} value={s.bgDim} display={`${s.bgDim}`} onChange={(v) => update({ bgDim: v })} />
          </div>
        </Group>
      </>
    ),
    lyrics: (
      <>
        <Group title={t("唱到的字的颜色")}>
          <button className="st-cell st-choice" role="radio" aria-checked={s.lyricColorMode === "album"} onClick={() => update({ lyricColorMode: "album" })}>
            <span className="st-dot" style={{ background: `linear-gradient(135deg, ${p.palette[0]}, ${p.palette[p.palette.length - 1]})` }} />
            <span className="st-option-text">
              <span>{t("跟随专辑")}</span>
              <small>{t("换歌时自动换色")}</small>
            </span>
            {s.lyricColorMode === "album" && <CheckIcon />}
          </button>
          <div className="st-cell">
            <span className="st-cell-label">{t("固定颜色")}</span>
            {lyricColorSwatches}
          </div>
        </Group>
        <Group>
          <Toggle label={t("显示翻译")} sub={t("外语歌有翻译时，在每句下面显示")} on={s.showTranslation} onChange={(v) => update({ showTranslation: v })} />
          <Toggle label={t("显示罗马音")} sub={t("日语歌有罗马音时，在原文下面显示")} on={s.showRomaji} onChange={(v) => update({ showRomaji: v })} />
        </Group>
        <Group
          foot={
            s.lyricSize !== 50 ? (
              <button className="st-link" onClick={() => update({ lyricSize: 50 })}>
                {t("恢复默认字号")}
              </button>
            ) : undefined
          }
        >
          <div className="st-cell">
            <Slider label={t("字号")} value={s.lyricSize} display={`${Math.round(lyricScale(s.lyricSize) * 100)}%`} onChange={(v) => update({ lyricSize: v })} />
          </div>
        </Group>
      </>
    ),
    desktop: (
      <>
        {/* 预览钉在顶上，往下调颜色、透明度时一直看得到 */}
        <div className="st-dlpv-pin">
          <DesktopPreview showRomaji={s.deskShowRomaji} lights={s.deskLightsOn ? lightPal : null} />
        </div>
        <Group title={t("唱到的字的颜色")}>
          <button className="st-cell st-choice" role="radio" aria-checked={s.deskLyricColorMode === "same"} onClick={() => update({ deskLyricColorMode: "same" })}>
            <span
              className="st-dot"
              style={{ background: s.lyricColorMode === "custom" ? s.lyricColor : `linear-gradient(135deg, ${p.palette[0]}, ${p.palette[p.palette.length - 1]})` }}
            />
            <span className="st-option-text">
              <span>{t("跟全屏歌词一样")}</span>
            </span>
            {s.deskLyricColorMode === "same" && <CheckIcon />}
          </button>
          <button className="st-cell st-choice" role="radio" aria-checked={s.deskLyricColorMode === "album"} onClick={() => update({ deskLyricColorMode: "album" })}>
            <span className="st-dot" style={{ background: `linear-gradient(135deg, ${p.palette[0]}, ${p.palette[p.palette.length - 1]})` }} />
            <span className="st-option-text">
              <span>{t("跟随专辑")}</span>
              <small>{t("换歌时自动换色")}</small>
            </span>
            {s.deskLyricColorMode === "album" && <CheckIcon />}
          </button>
          <div className="st-cell">
            <span className="st-cell-label">{t("固定颜色")}</span>
            <Swatches
              label={t("固定颜色")}
              value={s.deskLyricColor}
              active={s.deskLyricColorMode === "custom"}
              onPick={(c) => update({ deskLyricColorMode: "custom", deskLyricColor: c })}
            />
          </div>
        </Group>
        <Group title={t("没唱到的字的颜色")}>
          <div className="st-cell">
            <Swatches label={t("没唱到的字的颜色")} value={s.deskRestColor} active onPick={(c) => update({ deskRestColor: c })} />
          </div>
        </Group>
        <Group
          title={t("背景")}
          foot={
            s.deskBgTransparency !== 50 ? (
              <button className="st-link" onClick={() => update({ deskBgTransparency: 50 })}>
                {t("恢复默认")}
              </button>
            ) : undefined
          }
        >
          <div className="st-cell">
            <Slider label={t("背景透明度")} value={s.deskBgTransparency} display={`${Math.round(s.deskBgTransparency)}%`} onChange={(v) => update({ deskBgTransparency: v })} />
          </div>
        </Group>
        <Group>
          <Toggle label={t("拾音灯")} sub={t("歌词条下面跟着音乐跳的光，和全屏的拾音灯分开开关")} on={s.deskLightsOn} onChange={(v) => update({ deskLightsOn: v })} />
          <Toggle label={t("显示罗马音")} sub={t("日语歌有罗马音时，在每行下面显示")} on={s.deskShowRomaji} onChange={(v) => update({ deskShowRomaji: v })} />
        </Group>
        <Group
          foot={
            s.desktopLyricSize !== 50 ? (
              <button className="st-link" onClick={() => update({ desktopLyricSize: 50 })}>
                {t("恢复默认字号")}
              </button>
            ) : undefined
          }
        >
          <div className="st-cell">
            <Slider label={t("字号")} value={s.desktopLyricSize} display={`${Math.round(deskScale(s.desktopLyricSize) * 100)}%`} onChange={(v) => update({ desktopLyricSize: v })} />
          </div>
        </Group>
      </>
    ),
    lights: (
      <>
        <Group title={t("灯效")}>
          <div className="st-cell">
            <div className="st-fx" role="radiogroup" aria-label={t("灯效样式")}>
              {orderedStyles(s.lightOrder).map((l) => (
                <button key={l.id} className="st-tile" role="radio" aria-checked={s.lightStyle === l.id} onClick={() => update({ lightStyle: l.id })}>
                  <span className="st-thumb st-thumb--fx">
                    <LightThumb id={l.id} palette={lightPal} />
                  </span>
                  <span>{t(l.label)}</span>
                </button>
              ))}
            </div>
          </div>
          <Toggle label={t("跟着节拍闪烁")} sub={t("关掉后灯光只缓慢呼吸")} on={s.beat} onChange={(v) => update({ beat: v })} />
        </Group>
        <Group
          title={t("粗细和灵敏度")}
          foot={
            s.lightThickness !== 50 || s.lightSensitivity !== 50 || s.lightResponse !== 50 ? (
              <button className="st-link" onClick={() => update({ lightThickness: 50, lightSensitivity: 50, lightResponse: 50 })}>
                {t("恢复默认")}
              </button>
            ) : undefined
          }
        >
          <div className="st-cell">
            <LightPreview style={s.lightStyle} palette={lightPal} thickness={thickScale(s.lightThickness)} beat={s.beat} />
          </div>
          <div className="st-cell">
            <Slider label={t("粗细")} value={s.lightThickness} display={`${Math.round(thickScale(s.lightThickness) * 100)}%`} onChange={(v) => update({ lightThickness: v })} />
          </div>
          <div className="st-cell">
            <Slider label={t("灵敏度")} value={s.lightSensitivity} display={levelWord(s.lightSensitivity)} onChange={(v) => update({ lightSensitivity: v })} />
          </div>
          <div className="st-cell">
            <Slider label={t("反应速度")} value={s.lightResponse} display={levelWord(s.lightResponse)} onChange={(v) => update({ lightResponse: v })} />
          </div>
        </Group>
        {/* 墨晕的颜色是固定的，亮度、鲜艳度和配色都不起作用 */}
        <div className={s.lightStyle === "ink" ? "st-locked" : undefined} aria-disabled={s.lightStyle === "ink" || undefined}>
        <Group>
          <div className="st-cell">
            <Slider label={t("亮度")} value={s.lightBrightness} display={`${s.lightBrightness}`} onChange={(v) => update({ lightBrightness: v })} />
          </div>
          <div className="st-cell">
            <Slider label={t("色彩鲜艳度")} value={s.vividness} display={`${s.vividness}`} onChange={(v) => update({ vividness: v })} />
          </div>
        </Group>
        <Group title={t("颜色")}>
          <div className="st-cell">
            <div className="st-seg" role="radiogroup" aria-label={t("拾音灯颜色来源")}>
              {(
                [
                  ["album", t("取自专辑")],
                  ["custom", t("固定配色")],
                ] as const
              ).map(([id, name]) => (
                <button key={id} role="radio" aria-checked={s.lightColorMode === id} onClick={() => update({ lightColorMode: id })}>
                  {name}
                </button>
              ))}
            </div>
          </div>
          {s.lightColorMode === "custom" && (
            <>
              <div className="st-cell">
                <div className="st-presets" role="radiogroup" aria-label={t("配色主题")}>
                  {COLOR_PRESETS.map((c) => {
                    const on = s.lightA === c.a && s.lightB === c.b;
                    return (
                      <button key={c.id} className="st-preset" role="radio" aria-checked={on} onClick={() => update({ lightA: c.a, lightB: c.b })}>
                        <span style={{ background: `linear-gradient(90deg, ${c.a}, ${c.b})` }} />
                        {t(c.name)}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="st-cell">
                <div className="st-pickers">
                  <label className="st-pick">
                    <input type="color" value={s.lightA} onChange={(e) => update({ lightA: e.target.value.toUpperCase() })} />
                    {t("起始色")}
                  </label>
                  <span className="st-grad" style={{ background: `linear-gradient(90deg, ${s.lightA}, ${s.lightB})` }} aria-hidden="true" />
                  <label className="st-pick">
                    <input type="color" value={s.lightB} onChange={(e) => update({ lightB: e.target.value.toUpperCase() })} />
                    {t("结束色")}
                  </label>
                  <button className="st-link" onClick={() => update({ lightA: s.lightB, lightB: s.lightA })}>
                    {t("对调")}
                  </button>
                </div>
              </div>
            </>
          )}
        </Group>
        </div>
      </>
    ),
    spotify: (
      <>
        <Group>
          <div className="st-cell st-account">
            <span className="st-spotify" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#0E2A17" strokeWidth="2.2" strokeLinecap="round">
                <path d="M6 9.5c4-1.3 8.5-1 12 1M7 13c3.2-1 6.6-.7 9.5.8M8 16.3c2.4-.7 4.8-.5 7 .6" />
              </svg>
            </span>
            <span className="st-option-text">
              {p.account.loggedIn ? (
                <>
                  <span>{p.account.displayName}</span>
                  <small className={p.account.needsReauth ? "st-warn" : undefined}>
                    {p.account.expired ? t("登录已过期") : p.account.needsReauth ? t("需要重新连接一次，授予新的权限") : t("已连接")}
                  </small>
                </>
              ) : (
                <>
                  <span>{t("未连接")}</span>
                  <small>{t("连接后可以收藏正在播放的歌")}</small>
                </>
              )}
            </span>
            {p.account.loggedIn && p.account.needsReauth ? (
              <button className="st-btn st-btn--spotify" onClick={p.onLogin} disabled={p.accountBusy}>
                {p.accountBusy ? t("等待浏览器授权…") : t("重新连接")}
              </button>
            ) : p.account.loggedIn ? (
              <button className="st-btn" onClick={p.onLogout}>
                {t("断开")}
              </button>
            ) : (
              <button className="st-btn st-btn--spotify" onClick={p.onLogin} disabled={p.accountBusy}>
                {p.accountBusy ? t("等待浏览器授权…") : t("连接 Spotify")}
              </button>
            )}
          </div>
        </Group>
        <ClientSection />
      </>
    ),
    island: <IslandSection settings={s} update={update} palette={p.palette} lightPal={lightPal} artworkUrl={p.artworkUrl} />,
    general: <GeneralSection initial={p.updateInfo} settings={s} update={update} />,
  };

  const current = NAV.find((n) => n.id === page)!;
  return (
    <div className="st-backdrop" onPointerDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div className="st-panel glass glass--thick" role="dialog" aria-modal="true" aria-labelledby="st-title">
        {/* 左边：分类 */}
        <nav className="st-nav" aria-label={t("设置分类")}>
          <h2 id="st-title">{t("设置")}</h2>
          {NAV.map((n) => (
            <button
              key={n.id}
              className={`st-nav-item${page === n.id ? " is-on" : ""}`}
              aria-current={page === n.id ? "page" : undefined}
              onClick={() => setPage(n.id)}
            >
              <span className="st-icon" style={{ background: n.color }} aria-hidden="true">
                {n.icon}
              </span>
              <span>{t(n.label)}</span>
              {n.id === "general" && p.updateInfo?.hasUpdate && <span className="st-badge" aria-label={t("有新版本")} />}
              {n.id === "spotify" && p.account.loggedIn && p.account.needsReauth && <span className="st-badge" aria-label={t("需要重新连接")} />}
            </button>
          ))}
        </nav>

        {/* 右边：当前分类的内容 */}
        <div className="st-main">
          <header className="st-main-head">
            <h3>{t(current.label)}</h3>
            <button className="st-btn st-btn--primary st-done" onClick={p.onClose}>
              {t("完成")}
            </button>
          </header>
          <div className="st-page" key={page}>
            {pages[page]}
          </div>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ 灵动岛

function IslandSection({
  settings: s,
  update,
  palette,
  lightPal,
  artworkUrl,
}: {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  palette: string[];
  lightPal: string[];
  artworkUrl: string | null;
}) {
  const v = s.islandVinyl;
  const discColors: [string, string] = v.colorMode === "custom" ? [v.a, v.b] : [palette[1] ?? "#FF6F91", palette[palette.length - 1] ?? "#6F48C6"];
  const customColor = s.islandLyricColorMode === "custom";
  return (
    <>
      <Group>
        <Toggle label={t("显示灵动岛")} sub={t("在屏幕顶部显示正在唱的歌词")} on={s.islandOn} onChange={(on) => update({ islandOn: on })} />
      </Group>

      <Group title={t("模式")}>
        <div className="st-cell">
          <div className="st-seg" role="radiogroup" aria-label={t("模式")}>
            {(
              [
                [false, t("不锁定")],
                [true, t("锁定")],
              ] as const
            ).map(([id, name]) => (
              <button key={String(id)} role="radio" aria-checked={s.islandLocked === id} onClick={() => update({ islandLocked: id })}>
                {name}
              </button>
            ))}
          </div>
        </div>
      </Group>

      <Group title={t("大小")}>
        <div className="st-cell">
          <Slider label={t("灵动岛大小")} value={s.islandSize} display={`${Math.round(islandScale(s.islandSize) * 100)}%`} onChange={(n) => update({ islandSize: n })} />
        </div>
      </Group>

      <Group title={t("左边显示")}>
        <div className="st-cell">
          <div className="st-seg" role="radiogroup" aria-label={t("左边显示")}>
            {(
              [
                ["album", t("专辑封面")],
                ["vinyl", t("唱片")],
              ] as const
            ).map(([id, name]) => (
              <button key={id} role="radio" aria-checked={s.islandLeft === id} onClick={() => update({ islandLeft: id })}>
                {name}
              </button>
            ))}
          </div>
        </div>
        {s.islandLeft === "vinyl" && (
          <div className="st-cell st-vinyl-editor">
            <VinylEditor
              value={v}
              onChange={(patch) => update({ islandVinyl: { ...v, ...patch } })}
              colors={discColors}
              artUrl={artworkUrl}
              lyricLabel={false}
            />
          </div>
        )}
      </Group>

      <Group title={t("背景拾音灯")}>
        <Toggle label={t("拾音灯")} sub={t("关掉后背景是纯黑")} on={s.islandLightsOn} onChange={(on) => update({ islandLightsOn: on })} />
        <div className={`st-cell${s.islandLightsOn ? "" : " is-disabled"}`}>
          <div className="st-fx" role="radiogroup" aria-label={t("灯效样式")}>
            {orderedStyles(s.lightOrder).map((l) => (
              <button
                key={l.id}
                className="st-tile"
                role="radio"
                aria-checked={s.islandLightStyle === l.id}
                disabled={!s.islandLightsOn}
                onClick={() => update({ islandLightStyle: l.id })}
              >
                <span className="st-thumb st-thumb--fx">
                  <LightThumb id={l.id} palette={lightPal} />
                </span>
                <span>{t(l.label)}</span>
              </button>
            ))}
          </div>
        </div>
      </Group>

      <Group title={t("字幕颜色")}>
        <button className="st-cell st-choice" role="radio" aria-checked={!customColor} onClick={() => update({ islandLyricColorMode: "album" })}>
          <span className="st-dot" style={{ background: `linear-gradient(135deg, ${palette[0]}, ${palette[palette.length - 1]})` }} />
          <span className="st-option-text">
            <span>{t("跟随专辑")}</span>
            <small>{t("换歌时自动换色")}</small>
          </span>
          {!customColor && <CheckIcon />}
        </button>
        <div className="st-cell">
          <span className="st-cell-label">{t("固定颜色")}</span>
          <div className="st-swatches" role="radiogroup" aria-label={t("固定颜色")}>
            {LYRIC_PRESETS.map((c) => (
              <button
                key={c.c}
                className="st-swatch"
                role="radio"
                aria-checked={customColor && s.islandLyricColor.toUpperCase() === c.c}
                aria-label={t(c.name)}
                style={{ background: c.c }}
                onClick={() => update({ islandLyricColorMode: "custom", islandLyricColor: c.c })}
              />
            ))}
            <label className="st-swatch st-swatch--pick" aria-label={t("更多颜色")}>
              <input
                type="color"
                value={s.islandLyricColor}
                onChange={(e) => update({ islandLyricColorMode: "custom", islandLyricColor: e.target.value.toUpperCase() })}
              />
              <span
                style={{
                  background:
                    customColor && !LYRIC_PRESETS.some((c) => c.c === s.islandLyricColor.toUpperCase())
                      ? s.islandLyricColor
                      : "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)",
                }}
              />
            </label>
          </div>
        </div>
      </Group>
    </>
  );
}

// ------------------------------------------------------------------ 自己的 Spotify 应用

const DASHBOARD = "https://developer.spotify.com/dashboard";

/**
 * 登录方式：用 ingfy 自带的 Spotify 应用（只有名单里的最多 5 个账号能登录），
 * 或者填自己在开发者后台建的应用的 Client ID（不占名额，需要自己有 Premium）。
 */
function ClientSection() {
  const [info, setInfo] = useState<{ clientId: string | null; redirectUri: string } | null>(null);
  const [own, setOwn] = useState(false);
  const [draft, setDraft] = useState("");
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    invoke<{ clientId: string | null; redirectUri: string }>("spotify_client_get")
      .then((r) => {
        setInfo(r);
        setOwn(!!r.clientId);
        setDraft(r.clientId ?? "");
      })
      .catch(() => {});
  }, []);

  const apply = async (id: string | null) => {
    try {
      await invoke("spotify_client_set", { clientId: id });
      setInfo((i) => (i ? { ...i, clientId: id } : i));
      setMsg({ text: id ? t("已保存。点上面的「连接 Spotify」，用你自己的应用登录。") : t("已改回 ingfy 自带的应用，需要重新连接。") });
    } catch (e) {
      setMsg({ text: tMsg(String(e)), error: true });
    }
  };

  const toggle = (v: boolean) => {
    setOwn(v);
    setMsg(null);
    // 关掉时如果之前保存过自己的 ID，就改回自带的
    if (!v && info?.clientId) void apply(null);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(info?.redirectUri ?? "http://127.0.0.1:43821/callback");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 剪贴板不可用就算了，地址就在旁边 */
    }
  };

  const saved = info?.clientId ?? null;
  const dirty = draft.trim().toLowerCase() !== (saved ?? "");
  return (
    <Group
      title={t("登录方式")}
      foot={
        msg ? <span className={msg.error ? "st-warn" : undefined}>{msg.text}</span> : undefined
      }
    >
      <Toggle label={t("使用自己的 Client ID")} sub={saved ? t("正在使用你自己的 Spotify 应用") : t("现在用的是 ingfy 自带的应用")} on={own} onChange={toggle} />
      {own && (
        <>
          <div className="st-cell">
            <span className="st-cell-label">Client ID</span>
            <div className="st-input-row">
              <input
                className="st-input"
                value={draft}
                placeholder={t("粘贴 32 位 Client ID")}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => {
                  setDraft(e.target.value);
                  setMsg(null);
                }}
                onKeyDown={(e) => e.key === "Enter" && dirty && draft.trim() && void apply(draft.trim())}
              />
              <button className="st-btn st-btn--primary" disabled={!dirty || !draft.trim()} onClick={() => void apply(draft.trim())}>
                {t("保存")}
              </button>
            </div>
          </div>
          <div className="st-cell">
            <span className="st-cell-label">{t("怎么申请（两分钟）")}</span>
            <ol className="st-steps">
              <li>
                {t("打开 Spotify 开发者后台，用你的 Spotify 账号登录。")}
                <button className="st-link" onClick={() => void invoke("open_url", { url: DASHBOARD })}>
                  {t("打开开发者后台")}
                </button>
              </li>
              <li>{t("点 Create app，名字和描述随便填。")}</li>
              <li>
                {t("Redirect URI 填")}
                <code className="st-code">{info?.redirectUri ?? "http://127.0.0.1:43821/callback"}</code>
                <button className="st-chip" onClick={copy}>
                  {copied ? t("已复制") : t("复制")}
                </button>
              </li>
              <li>{t("“Which API/SDKs are you planning to use” 勾选 Web API，同意条款后保存。")}</li>
              <li>{t("在应用的 Settings 里复制 Client ID，粘贴到上面，点保存，然后连接 Spotify。")}</li>
            </ol>
          </div>
        </>
      )}
    </Group>
  );
}

// ------------------------------------------------------------------ 分组、开关行

/** iOS 设置里那种圆角分组：可选的小标题、几行内容、底部灰色说明 */
function Group({ title, foot, children }: { title?: string; foot?: ReactNode; children: ReactNode }) {
  return (
    <section className="st-group">
      {title && <h4>{title}</h4>}
      <div className="st-card">{children}</div>
      {foot && <div className="st-foot">{foot}</div>}
    </section>
  );
}

function Toggle({ label, sub, on, onChange, disabled }: { label: string; sub?: string; on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="st-cell st-toggle">
      <span className="st-option-text">
        <span>{label}</span>
        {sub && <small>{sub}</small>}
      </span>
      <button className={`st-switch${on ? " is-on" : ""}`} role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}>
        <span />
      </button>
    </div>
  );
}

type PageId = "look" | "lyrics" | "desktop" | "lights" | "island" | "spotify" | "general";

const NAV: { id: PageId; label: string; color: string; icon: JSX.Element }[] = [
  {
    id: "look",
    label: "背景",
    color: "linear-gradient(135deg, #5AC8FA, #007AFF)",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3.5" y="5" width="17" height="14" rx="3" />
        <path d="M4 16l5-5 4 4 2.5-2.5L20 17" />
      </svg>
    ),
  },
  {
    id: "lyrics",
    label: "全屏歌词",
    color: "linear-gradient(135deg, #FF9F0A, #FF6B3D)",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round">
        <path d="M5 7h14M5 12h10M5 17h12" />
      </svg>
    ),
  },
  {
    id: "desktop",
    label: "桌面歌词",
    color: "linear-gradient(135deg, #FF6482, #FF2D55)",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4.5" width="18" height="12" rx="2.5" />
        <path d="M9 20h6M12 16.5V20M7 9.5h7M10 12.5h7" />
      </svg>
    ),
  },
  {
    id: "lights",
    label: "拾音灯",
    color: "linear-gradient(135deg, #BF5AF2, #7B4DFF)",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round">
        <path d="M6 15v3M10 9v9M14 5v13M18 11v7" />
      </svg>
    ),
  },
  {
    id: "island",
    label: "灵动岛",
    color: "linear-gradient(135deg, #3A3A3C, #000000)",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="3" y="8" width="18" height="8" rx="4" fill="#fff" />
        <circle cx="7.2" cy="12" r="2" fill="#000" />
      </svg>
    ),
  },
  {
    id: "spotify",
    label: "Spotify",
    color: "linear-gradient(135deg, #30D158, #1DB954)",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round">
        <path d="M6 9.5c4-1.3 8.5-1 12 1M7 13c3.2-1 6.6-.7 9.5.8M8 16.3c2.4-.7 4.8-.5 7 .6" />
      </svg>
    ),
  },
  {
    id: "general",
    label: "通用",
    color: "linear-gradient(135deg, #8E8E93, #636366)",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" />
      </svg>
    ),
  },
];

/** 记住上次停在哪个分类，下次打开设置还在那 */
let lastPage: PageId = "look";
