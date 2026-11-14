import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import type { Settings, BackgroundKind } from "../lib/settings";
import { downscaleImage, saveBackgroundImage } from "../lib/settings";
import type { LightStyle } from "./Lights";
import type { AccountStatus } from "../lib/spotify";
import { CheckIcon } from "./Icons";
import { COLOR_PRESETS, pickGradient } from "../lib/palette";
import { deskScale, lightPalette, lyricScale } from "../lib/settings";
import { t, tMsg, useLang } from "../lib/i18n";

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
  ["Ctrl Alt L", t("显示 / 隐藏桌面歌词")],
  ["Ctrl Alt P", t("播放 / 暂停")],
  ["Ctrl Alt ← →", t("上一首 / 下一首")],
  ["Ctrl Alt K", t("收藏当前歌曲")],
];

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
      <Group foot={t("关闭主窗口后 ingfy 会留在右下角托盘里，桌面歌词和快捷键继续工作；从托盘菜单退出。")}>
        <Toggle
          label={t("开机自动启动")}
          sub={t("开机后只显示桌面歌词，主窗口留在托盘")}
          on={!!autostart}
          disabled={autostart === null}
          onChange={() => void toggleAutostart()}
        />
      </Group>
      <Group title={t("快捷键")} foot={t("在任何程序里都能用。被别的程序占用的组合会自动跳过。")}>
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
  useLang();
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
        setImgError(t("图片太大了，换一张小一点的试试"));
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
            <div className="st-tiles" role="radiogroup" aria-label={t("背景")}>
              {bgOptions.map((o) => (
                <button key={o.id} className="st-tile" role="radio" aria-checked={s.background === o.id} onClick={() => chooseBg(o.id)}>
                  <span className="st-thumb" style={o.style}>
                    {o.id === "image" && !p.bgImage && <span className="st-upload">{t("点击选择")}</span>}
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
            {imgError && (
              <p className="st-error" role="alert">
                {imgError}
              </p>
            )}
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={pickImage} />
          </div>
        </Group>
        <Group foot={t("背景越暗，歌词越清楚。")}>
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
        <Group title={t("唱到的字的颜色")} foot={t("全屏歌词和桌面歌词一起生效。")}>
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
          <Toggle label={t("显示翻译")} sub={t("外语歌有翻译时，在全屏歌词每句下面显示")} on={s.showTranslation} onChange={(v) => update({ showTranslation: v })} />
        </Group>
        <Group
          title={t("字号")}
          foot={
            s.lyricSize !== 50 || s.desktopLyricSize !== 50 ? (
              <button className="st-link" onClick={() => update({ lyricSize: 50, desktopLyricSize: 50 })}>
                {t("恢复默认字号")}
              </button>
            ) : (
              t("放不下一行的句子会自动缩小。")
            )
          }
        >
          <div className="st-cell">
            <Slider label={t("全屏歌词")} value={s.lyricSize} display={`${Math.round(lyricScale(s.lyricSize) * 100)}%`} onChange={(v) => update({ lyricSize: v })} />
          </div>
          <div className="st-cell">
            <Slider
              label={t("桌面歌词")}
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
        <Group title={t("灯效")}>
          <div className="st-cell">
            <div className="st-fx" role="radiogroup" aria-label={t("灯效样式")}>
              {LIGHT_STYLES.map((l) => (
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
        <Group>
          <div className="st-cell">
            <Slider label={t("亮度")} value={s.lightBrightness} display={`${s.lightBrightness}`} onChange={(v) => update({ lightBrightness: v })} />
          </div>
          <div className="st-cell">
            <Slider label={t("色彩鲜艳度")} value={s.vividness} display={`${s.vividness}`} onChange={(v) => update({ vividness: v })} />
          </div>
        </Group>
        <Group title={t("颜色")} foot={s.lightColorMode === "album" ? t("换歌时自动取当前专辑封面的颜色。") : undefined}>
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
      </>
    ),
    spotify: (
      <>
        <Group
          foot={
            p.account.expired
              ? t("Spotify 对开发模式应用的登录最长保留半年，或者你在 Spotify 账号里撤销了授权。重新连接一次就好。")
              : p.account.loggedIn
                ? t("连接后可以收藏歌曲、浏览曲库和专辑、查看播放列表；从专辑或歌单开始播放需要 Premium。")
                : t("歌词、拾音灯、桌面歌词不需要连接 Spotify，任何播放器都能用。")
          }
        >
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
        msg ? (
          <span className={msg.error ? "st-warn" : undefined}>{msg.text}</span>
        ) : (
          t("ingfy 自带的应用处于 Spotify 的开发模式，只有被加进用户名单的账号能登录（最多 5 人）。用自己的应用不占名额，但需要你有 Spotify Premium。换应用后需要重新连接。")
        )
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
