import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Settings, BackgroundKind } from "../lib/settings";
import { downscaleImage, saveBackgroundImage } from "../lib/settings";
import type { LightStyle } from "./Lights";
import type { AccountStatus } from "../lib/spotify";
import { CheckIcon } from "./Icons";
import { COLOR_PRESETS, pickGradient } from "../lib/palette";
import { deskScale, lightPalette, lyricScale } from "../lib/settings";

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

const SHORTCUTS: [string, string][] = [
  ["Ctrl Alt L", "显示 / 隐藏桌面歌词"],
  ["Ctrl Alt P", "播放 / 暂停"],
  ["Ctrl Alt ← →", "上一首 / 下一首"],
  ["Ctrl Alt K", "收藏当前歌曲"],
];

/** 通用：开机自启、快捷键、版本与更新 */
function GeneralSection({ initial }: { initial?: UpdateInfo | null }) {
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [info, setInfo] = useState<UpdateInfo | null>(initial ?? null);
  const [state, setState] = useState<"idle" | "checking" | "installing">("idle");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    invoke<boolean>("autostart_enabled").then(setAutostart).catch(() => setAutostart(false));
  }, []);

  const toggleAutostart = async () => {
    try {
      setAutostart(await invoke<boolean>("set_autostart", { enabled: !autostart }));
    } catch (e) {
      setMsg(String(e));
    }
  };
  const check = async () => {
    setState("checking");
    setMsg("");
    try {
      const r = await invoke<UpdateInfo>("check_update");
      setInfo(r);
      if (!r.hasUpdate) setMsg("已经是最新版本");
    } catch (e) {
      setMsg(String(e));
    } finally {
      setState("idle");
    }
  };
  const install = async () => {
    if (!info?.installerUrl) return;
    setState("installing");
    setMsg("正在下载新版本，下载完会自动打开安装程序…");
    try {
      await invoke("install_update", { url: info.installerUrl });
    } catch (e) {
      setMsg(String(e));
      setState("idle");
    }
  };

  return (
    <section>
      <h3>通用</h3>
      <div className="st-toggle">
        <span className="st-option-text">
          <span>开机自动启动</span>
          <small>开机后只显示桌面歌词，主窗口留在托盘里</small>
        </span>
        <button
          className={`st-switch${autostart ? " is-on" : ""}`}
          role="switch"
          aria-checked={!!autostart}
          aria-label="开机自动启动"
          disabled={autostart === null}
          onClick={toggleAutostart}
        >
          <span />
        </button>
      </div>
      <p className="st-note">关闭主窗口后 ingfy 会留在右下角托盘继续显示桌面歌词，从托盘菜单退出。</p>
      <dl className="st-keys">
        {SHORTCUTS.map(([k, v]) => (
          <div key={k}>
            <dt>
              {k.split(" ").map((x) => (
                <kbd key={x}>{x}</kbd>
              ))}
            </dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <div className="st-update">
        <span>
          ingfy {info?.current ?? ""}
          {info?.hasUpdate && <em className="st-new">新版本 {info.latest}</em>}
        </span>
        {info?.hasUpdate && info.installerUrl ? (
          <button className="st-btn st-btn--primary" onClick={install} disabled={state !== "idle"}>
            {state === "installing" ? "正在更新…" : "立即更新"}
          </button>
        ) : (
          <button className="st-btn" onClick={check} disabled={state !== "idle"}>
            {state === "checking" ? "正在检查…" : "检查更新"}
          </button>
        )}
      </div>
      {msg && <p className="st-note">{msg}</p>}
    </section>
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

const LIGHT_STYLES: { id: LightStyle; label: string }[] = [
  { id: "tube", label: "灯管" },
  { id: "hist", label: "直方图" },
  { id: "ring", label: "圆环" },
  { id: "wave", label: "声波" },
];

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

/** 灯效缩略图：用当前专辑色画一个小样 */
function LightThumb({ id, palette }: { id: LightStyle; palette: string[] }) {
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
  const n = id === "tube" ? 5 : id === "hist" ? 9 : 12;
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
  const { settings: s, update } = p;
  const lightPal = lightPalette(s, p.palette);
  const fileRef = useRef<HTMLInputElement>(null);
  const [imgError, setImgError] = useState<string | null>(null);

  const pickImage = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const url = await downscaleImage(file);
      if (!saveBackgroundImage(url)) {
        setImgError("图片太大了，换一张小一点的试试");
        return;
      }
      setImgError(null);
      update({ background: "image" });
    } catch (err) {
      setImgError(String((err as Error).message ?? err));
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
      id: "cover",
      label: "专辑封面放大",
      style: p.artworkUrl
        ? { backgroundImage: `url(${p.artworkUrl})`, backgroundSize: "cover", backgroundPosition: "center", filter: "blur(6px)" }
        : { background: "linear-gradient(135deg, #FF6F91, #3B2A8C)" },
    },
  ];

  const chooseBg = (id: BackgroundKind) => {
    if (id === "image" && !p.bgImage) {
      fileRef.current?.click();
      return;
    }
    update({ background: id });
  };

  return (
    <div className="st-backdrop" onPointerDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div className="st-panel glass glass--thick" role="dialog" aria-modal="true" aria-labelledby="st-title">
        <header className="st-head">
          <h2 id="st-title">设置</h2>
          <button className="st-btn" onClick={p.onClose}>完成</button>
        </header>

        <div className="st-cols">
          {/* 左栏：背景、歌词颜色 */}
          <div className="st-col">
            <section>
              <h3>背景</h3>
              <div className="st-tiles" role="radiogroup" aria-label="背景">
                {bgOptions.map((o) => (
                  <button key={o.id} className="st-tile" role="radio" aria-checked={s.background === o.id} onClick={() => chooseBg(o.id)}>
                    <span className="st-thumb" style={o.style}>
                      {o.id === "image" && !p.bgImage && <span className="st-upload">点击选择</span>}
                      {s.background === o.id && <span className="st-check"><CheckIcon /></span>}
                    </span>
                    <span>{o.label}</span>
                  </button>
                ))}
              </div>
              {p.bgImage && (
                <div className="st-row-btns">
                  <button className="st-link" onClick={() => fileRef.current?.click()}>换一张图片</button>
                  <button
                    className="st-link"
                    onClick={() => {
                      saveBackgroundImage(null);
                      if (s.background === "image") update({ background: "fluid" });
                    }}
                  >
                    删除图片
                  </button>
                </div>
              )}
              {imgError && <p className="st-error" role="alert">{imgError}</p>}
              <input ref={fileRef} type="file" accept="image/*" hidden onChange={pickImage} />
              <Slider label="背景模糊" value={s.bgBlur} onChange={(v) => update({ bgBlur: v })} />
              <Slider label="背景暗度（让歌词更清楚）" value={s.bgDim} onChange={(v) => update({ bgDim: v })} />
            </section>

            <section>
              <h3>歌词颜色</h3>
              <p className="st-note">唱到的字用这个颜色，全屏歌词和桌面歌词一起生效。</p>
              <button
                className="st-option"
                role="radio"
                aria-checked={s.lyricColorMode === "album"}
                onClick={() => update({ lyricColorMode: "album" })}
              >
                <span className="st-dot" style={{ background: `linear-gradient(135deg, ${p.palette[0]}, ${p.palette[p.palette.length - 1]})` }} />
                <span className="st-option-text">
                  <span>跟随专辑</span>
                  <small>换歌时自动换色</small>
                </span>
              </button>
              <div className="st-swatches" role="radiogroup" aria-label="固定颜色">
                {LYRIC_PRESETS.map((c) => {
                  const on = s.lyricColorMode === "custom" && s.lyricColor.toUpperCase() === c.c;
                  return (
                    <button
                      key={c.c}
                      className="st-swatch"
                      role="radio"
                      aria-checked={on}
                      aria-label={c.name}
                      style={{ background: c.c }}
                      onClick={() => update({ lyricColorMode: "custom", lyricColor: c.c })}
                    />
                  );
                })}
                <label className="st-swatch st-swatch--pick" aria-label="更多颜色">
                  <input
                    type="color"
                    value={s.lyricColor}
                    onChange={(e) => update({ lyricColorMode: "custom", lyricColor: e.target.value.toUpperCase() })}
                  />
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
              <div className="st-toggle">
                <span className="st-option-text">
                  <span>显示翻译</span>
                  <small>外语歌有翻译时，在全屏歌词每句下面显示</small>
                </span>
                <button
                  className={`st-switch${s.showTranslation ? " is-on" : ""}`}
                  role="switch"
                  aria-checked={s.showTranslation}
                  aria-label="显示翻译"
                  onClick={() => update({ showTranslation: !s.showTranslation })}
                >
                  <span />
                </button>
              </div>
              <Slider
                label="全屏歌词字号"
                value={s.lyricSize}
                display={`${Math.round(lyricScale(s.lyricSize) * 100)}%`}
                onChange={(v) => update({ lyricSize: v })}
              />
              <Slider
                label="桌面歌词字号"
                value={s.desktopLyricSize}
                display={`${Math.round(deskScale(s.desktopLyricSize) * 100)}%`}
                onChange={(v) => update({ desktopLyricSize: v })}
              />
              {(s.lyricSize !== 50 || s.desktopLyricSize !== 50) && (
                <button className="st-link" onClick={() => update({ lyricSize: 50, desktopLyricSize: 50 })}>
                  恢复默认字号
                </button>
              )}
            </section>
          </div>

          {/* 右栏：拾音灯、Spotify */}
          <div className="st-col">
            <section>
              <h3>拾音灯</h3>
              <p className="st-note">颜色自动取自当前专辑封面。</p>
              <div className="st-fx" role="radiogroup" aria-label="灯效样式">
                {LIGHT_STYLES.map((l) => (
                  <button key={l.id} className="st-tile" role="radio" aria-checked={s.lightStyle === l.id} onClick={() => update({ lightStyle: l.id })}>
                    <span className="st-thumb st-thumb--fx">
                      <LightThumb id={l.id} palette={lightPal} />
                    </span>
                    <span>{l.label}</span>
                  </button>
                ))}
              </div>
              <div className="st-toggle">
                <span className="st-option-text">
                  <span>跟着节拍闪烁</span>
                  <small>关掉后灯光只缓慢呼吸</small>
                </span>
                <button
                  className={`st-switch${s.beat ? " is-on" : ""}`}
                  role="switch"
                  aria-checked={s.beat}
                  aria-label="跟着节拍闪烁"
                  onClick={() => update({ beat: !s.beat })}
                >
                  <span />
                </button>
              </div>
              <Slider label="灯光亮度" value={s.lightBrightness} onChange={(v) => update({ lightBrightness: v })} />
              <Slider label="色彩鲜艳度" value={s.vividness} onChange={(v) => update({ vividness: v })} />
            </section>

            <section>
              <h3>拾音灯颜色</h3>
              <div className="st-seg" role="radiogroup" aria-label="拾音灯颜色来源">
                {(
                  [
                    ["album", "取自专辑"],
                    ["custom", "固定配色"],
                  ] as const
                ).map(([id, name]) => (
                  <button key={id} role="radio" aria-checked={s.lightColorMode === id} onClick={() => update({ lightColorMode: id })}>
                    {name}
                  </button>
                ))}
              </div>
              {s.lightColorMode === "custom" && (
                <>
                  <div className="st-presets" role="radiogroup" aria-label="配色主题">
                    {COLOR_PRESETS.map((c) => {
                      const on = s.lightA === c.a && s.lightB === c.b;
                      return (
                        <button key={c.id} className="st-preset" role="radio" aria-checked={on} onClick={() => update({ lightA: c.a, lightB: c.b })}>
                          <span style={{ background: `linear-gradient(90deg, ${c.a}, ${c.b})` }} />
                          {c.name}
                        </button>
                      );
                    })}
                  </div>
                  <div className="st-pickers">
                    <label className="st-pick">
                      <input type="color" value={s.lightA} onChange={(e) => update({ lightA: e.target.value.toUpperCase() })} />
                      起始色
                    </label>
                    <span className="st-grad" style={{ background: `linear-gradient(90deg, ${s.lightA}, ${s.lightB})` }} aria-hidden="true" />
                    <label className="st-pick">
                      <input type="color" value={s.lightB} onChange={(e) => update({ lightB: e.target.value.toUpperCase() })} />
                      结束色
                    </label>
                    <button className="st-link" onClick={() => update({ lightA: s.lightB, lightB: s.lightA })}>
                      对调
                    </button>
                  </div>
                </>
              )}
            </section>

            <section>
              <h3>Spotify 账号</h3>
              <div className="st-account">
                <span className="st-spotify" aria-hidden="true">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#0E2A17" strokeWidth="2.2" strokeLinecap="round">
                    <path d="M6 9.5c4-1.3 8.5-1 12 1M7 13c3.2-1 6.6-.7 9.5.8M8 16.3c2.4-.7 4.8-.5 7 .6" />
                  </svg>
                </span>
                <span className="st-option-text">
                  {p.account.loggedIn && p.account.needsReauth ? (
                    <>
                      <span>已连接 {p.account.displayName}</span>
                      <small>Spotify 更新了收藏接口，需要重新连接一次授予新权限</small>
                    </>
                  ) : p.account.loggedIn ? (
                    <>
                      <span>已连接 {p.account.displayName}</span>
                      <small>点爱心会存进“已点赞的歌曲”</small>
                    </>
                  ) : (
                    <>
                      <span>未连接</span>
                      <small>连接后可以收藏正在播放的歌（需要 Premium）</small>
                    </>
                  )}
                </span>
                {p.account.loggedIn && p.account.needsReauth ? (
                  <button className="st-btn st-btn--spotify" onClick={p.onLogin} disabled={p.accountBusy}>
                    {p.accountBusy ? "等待浏览器授权…" : "重新连接"}
                  </button>
                ) : p.account.loggedIn ? (
                  <button className="st-btn" onClick={p.onLogout}>断开</button>
                ) : (
                  <button className="st-btn st-btn--spotify" onClick={p.onLogin} disabled={p.accountBusy}>
                    {p.accountBusy ? "等待浏览器授权…" : "连接 Spotify"}
                  </button>
                )}
              </div>
            </section>
            <GeneralSection initial={p.updateInfo} />
          </div>
        </div>
      </div>
    </div>
  );
}
