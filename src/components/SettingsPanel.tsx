import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties, type ReactNode } from "react";
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
    <>
      <Group foot="关闭主窗口后 ingfy 会留在右下角托盘里，桌面歌词和快捷键继续工作；从托盘菜单退出。">
        <Toggle
          label="开机自动启动"
          sub="开机后只显示桌面歌词，主窗口留在托盘"
          on={!!autostart}
          disabled={autostart === null}
          onChange={() => void toggleAutostart()}
        />
      </Group>
      <Group title="快捷键" foot="在任何程序里都能用。被别的程序占用的组合会自动跳过。">
        {SHORTCUTS.map(([k, v]) => (
          <div className="st-cell st-key" key={k}>
            <span>{v}</span>
            <span className="st-kbds">
              {k.split(" ").map((x) => (
                <kbd key={x}>{x}</kbd>
              ))}
            </span>
          </div>
        ))}
      </Group>
      <Group title="关于" foot={msg || undefined}>
        <div className="st-cell st-update">
          <span className="st-option-text">
            <span>
              ingfy {info?.current ?? ""}
              {info?.hasUpdate && <em className="st-new">新版本 {info.latest}</em>}
            </span>
            <small>{info?.hasUpdate ? "下载后会自动打开安装程序" : "从 GitHub 检查新版本"}</small>
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
      </Group>
    </>
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

  const lyricColorSwatches = (
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
        <Group title="样式">
          <div className="st-cell">
            <div className="st-tiles" role="radiogroup" aria-label="背景">
              {bgOptions.map((o) => (
                <button key={o.id} className="st-tile" role="radio" aria-checked={s.background === o.id} onClick={() => chooseBg(o.id)}>
                  <span className="st-thumb" style={o.style}>
                    {o.id === "image" && !p.bgImage && <span className="st-upload">点击选择</span>}
                    {s.background === o.id && (
                      <span className="st-check">
                        <CheckIcon />
                      </span>
                    )}
                  </span>
                  <span>{o.label}</span>
                </button>
              ))}
            </div>
            {p.bgImage && (
              <div className="st-row-btns">
                <button className="st-link" onClick={() => fileRef.current?.click()}>
                  换一张图片
                </button>
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
            {imgError && (
              <p className="st-error" role="alert">
                {imgError}
              </p>
            )}
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={pickImage} />
          </div>
        </Group>
        <Group foot="背景越暗，歌词越清楚。">
          <div className="st-cell">
            <Slider label="背景模糊" value={s.bgBlur} display={`${s.bgBlur}`} onChange={(v) => update({ bgBlur: v })} />
          </div>
          <div className="st-cell">
            <Slider label="背景暗度" value={s.bgDim} display={`${s.bgDim}`} onChange={(v) => update({ bgDim: v })} />
          </div>
        </Group>
      </>
    ),
    lyrics: (
      <>
        <Group title="唱到的字的颜色" foot="全屏歌词和桌面歌词一起生效。">
          <button className="st-cell st-choice" role="radio" aria-checked={s.lyricColorMode === "album"} onClick={() => update({ lyricColorMode: "album" })}>
            <span className="st-dot" style={{ background: `linear-gradient(135deg, ${p.palette[0]}, ${p.palette[p.palette.length - 1]})` }} />
            <span className="st-option-text">
              <span>跟随专辑</span>
              <small>换歌时自动换色</small>
            </span>
            {s.lyricColorMode === "album" && <CheckIcon />}
          </button>
          <div className="st-cell">
            <span className="st-cell-label">固定颜色</span>
            {lyricColorSwatches}
          </div>
        </Group>
        <Group>
          <Toggle label="显示翻译" sub="外语歌有翻译时，在全屏歌词每句下面显示" on={s.showTranslation} onChange={(v) => update({ showTranslation: v })} />
        </Group>
        <Group
          title="字号"
          foot={
            s.lyricSize !== 50 || s.desktopLyricSize !== 50 ? (
              <button className="st-link" onClick={() => update({ lyricSize: 50, desktopLyricSize: 50 })}>
                恢复默认字号
              </button>
            ) : (
              "放不下一行的句子会自动缩小。"
            )
          }
        >
          <div className="st-cell">
            <Slider label="全屏歌词" value={s.lyricSize} display={`${Math.round(lyricScale(s.lyricSize) * 100)}%`} onChange={(v) => update({ lyricSize: v })} />
          </div>
          <div className="st-cell">
            <Slider
              label="桌面歌词"
              value={s.desktopLyricSize}
              display={`${Math.round(deskScale(s.desktopLyricSize) * 100)}%`}
              onChange={(v) => update({ desktopLyricSize: v })}
            />
          </div>
        </Group>
      </>
    ),
    lights: (
      <>
        <Group title="灯效">
          <div className="st-cell">
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
          </div>
          <Toggle label="跟着节拍闪烁" sub="关掉后灯光只缓慢呼吸" on={s.beat} onChange={(v) => update({ beat: v })} />
        </Group>
        <Group>
          <div className="st-cell">
            <Slider label="亮度" value={s.lightBrightness} display={`${s.lightBrightness}`} onChange={(v) => update({ lightBrightness: v })} />
          </div>
          <div className="st-cell">
            <Slider label="色彩鲜艳度" value={s.vividness} display={`${s.vividness}`} onChange={(v) => update({ vividness: v })} />
          </div>
        </Group>
        <Group title="颜色" foot={s.lightColorMode === "album" ? "换歌时自动取当前专辑封面的颜色。" : undefined}>
          <div className="st-cell">
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
          </div>
          {s.lightColorMode === "custom" && (
            <>
              <div className="st-cell">
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
              </div>
              <div className="st-cell">
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
              </div>
            </>
          )}
        </Group>
      </>
    ),
    spotify: (
      <>
        <Group
          foot={
            p.account.loggedIn
              ? "连接后可以收藏歌曲、浏览曲库和专辑、查看播放列表；从专辑或歌单开始播放需要 Premium。"
              : "歌词、拾音灯、桌面歌词不需要连接 Spotify，任何播放器都能用。"
          }
        >
          <div className="st-cell st-account">
            <span className="st-spotify" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#0E2A17" strokeWidth="2.2" strokeLinecap="round">
                <path d="M6 9.5c4-1.3 8.5-1 12 1M7 13c3.2-1 6.6-.7 9.5.8M8 16.3c2.4-.7 4.8-.5 7 .6" />
              </svg>
            </span>
            <span className="st-option-text">
              {p.account.loggedIn && p.account.needsReauth ? (
                <>
                  <span>{p.account.displayName}</span>
                  <small>需要重新连接一次，授予新的权限</small>
                </>
              ) : p.account.loggedIn ? (
                <>
                  <span>{p.account.displayName}</span>
                  <small>已连接</small>
                </>
              ) : (
                <>
                  <span>未连接</span>
                  <small>连接后可以收藏正在播放的歌</small>
                </>
              )}
            </span>
            {p.account.loggedIn && p.account.needsReauth ? (
              <button className="st-btn st-btn--spotify" onClick={p.onLogin} disabled={p.accountBusy}>
                {p.accountBusy ? "等待浏览器授权…" : "重新连接"}
              </button>
            ) : p.account.loggedIn ? (
              <button className="st-btn" onClick={p.onLogout}>
                断开
              </button>
            ) : (
              <button className="st-btn st-btn--spotify" onClick={p.onLogin} disabled={p.accountBusy}>
                {p.accountBusy ? "等待浏览器授权…" : "连接 Spotify"}
              </button>
            )}
          </div>
        </Group>
      </>
    ),
    general: <GeneralSection initial={p.updateInfo} />,
  };

  const current = NAV.find((n) => n.id === page)!;
  return (
    <div className="st-backdrop" onPointerDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div className="st-panel glass glass--thick" role="dialog" aria-modal="true" aria-labelledby="st-title">
        {/* 左边：分类 */}
        <nav className="st-nav" aria-label="设置分类">
          <h2 id="st-title">设置</h2>
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
              <span>{n.label}</span>
              {n.id === "general" && p.updateInfo?.hasUpdate && <span className="st-badge" aria-label="有新版本" />}
              {n.id === "spotify" && p.account.needsReauth && <span className="st-badge" aria-label="需要重新连接" />}
            </button>
          ))}
        </nav>

        {/* 右边：当前分类的内容 */}
        <div className="st-main">
          <header className="st-main-head">
            <h3>{current.label}</h3>
            <button className="st-btn st-btn--primary st-done" onClick={p.onClose}>
              完成
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

type PageId = "look" | "lyrics" | "lights" | "spotify" | "general";

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
    label: "歌词",
    color: "linear-gradient(135deg, #FF9F0A, #FF6B3D)",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round">
        <path d="M5 7h14M5 12h10M5 17h12" />
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
