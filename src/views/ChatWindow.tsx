import { memo, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { countShown, toChat, type ChatMessage } from "../lib/chat";
import { useLyricPref } from "../lib/lyricPrefs";
import { trackKey } from "../lib/types";
import { useLyrics, usePlayer, usePosition } from "../lib/player";
import { useApplySettings, useSettings } from "../lib/settings";
import { t, useLang } from "../lib/i18n";

/** 只保留最近这么多条，旧的早就滚出窗口了 */
const KEEP = 60;
/** 轮到我唱之前多久开始在输入框里打字 */
const TYPE_AHEAD = 2000;

/**
 * 聊天模式：单独的竖条窗口，歌词像两个人在聊天。
 * 对方的头像是专辑封面，我的头像在设置里换。窗口大小、长宽比都能随便拉。
 */
export default function ChatWindow() {
  useLang();
  const { now, artwork } = usePlayer();
  const raw = usePosition(now);
  const pref = useLyricPref(now?.title ? trackKey(now) : "");
  const lyrics = useLyrics(now, pref);
  const [settings, update] = useSettings();
  const position = raw + (pref.offset ?? 0) + (settings.lyricDelay ?? 0);
  useApplySettings(settings);
  const dark = useDark(settings.chatTheme);

  // 置顶跟着设置走
  useEffect(() => {
    void getCurrentWindow().setAlwaysOnTop(settings.chatOnTop).catch(() => {});
  }, [settings.chatOnTop]);

  const synced = lyrics.status === "ready" && lyrics.synced;
  const { messages } = useMemo(() => toChat(lyrics.lines, settings.chatSplit, synced), [lyrics.lines, settings.chatSplit, synced]);
  // 没有时间轴的歌词一次全部发出来
  const shown = synced ? countShown(messages, position) : messages.length;

  // 新到的消息才放进场动画；第一次打开、拖进度条一下跳过去的不放
  const fresh = useRef(new Map<string, boolean>());
  const first = useRef(true);
  const track = now?.title ? trackKey(now) : "";
  useEffect(() => {
    fresh.current.clear();
    first.current = true;
  }, [track, settings.chatSplit]);
  const visible = messages.slice(Math.max(0, shown - KEEP), shown);
  for (const m of visible) {
    if (!fresh.current.has(m.key)) fresh.current.set(m.key, !first.current && synced && position - m.time < 1200);
  }
  if (visible.length) first.current = false;

  // 下一条是谁的：对方的话标题显示"正在输入"，我的话先在输入框里打出来
  const next = synced ? messages[shown] : undefined;
  const ahead = next ? next.time - position : Infinity;
  const typing = !!next && next.side === "L" && ahead < 1800 && !!now?.playing;
  let typed = "";
  if (next && next.side === "R" && ahead < TYPE_AHEAD) {
    const chars = Array.from(next.text);
    const p = Math.max(0, Math.min(1, (TYPE_AHEAD - ahead) / (TYPE_AHEAD - 500)));
    typed = chars.slice(0, Math.ceil(chars.length * p)).join("");
  }

  const empty = !now?.title
    ? t("没有在播放")
    : lyrics.status === "loading" || lyrics.status === "idle"
      ? t("正在找歌词…")
      : lyrics.status === "error"
        ? t("歌词加载失败，检查一下网络")
        : lyrics.status === "none"
          ? lyrics.instrumental
            ? t("纯音乐，没有歌词")
            : t("没找到这首歌的歌词")
          : synced && shown === 0
            ? t("前奏中…")
            : null;

  const win = getCurrentWindow();
  return (
    <div className={`chat${dark ? " chat--dark" : ""}`}>
      <header className="chat-head" data-tauri-drag-region>
        <h1 className="chat-title" data-tauri-drag-region aria-live="polite">
          {typing ? (
            <span className="chat-typing" data-tauri-drag-region>
              {t("对方正在输入")}
              <i>.</i>
              <i>.</i>
              <i>.</i>
            </span>
          ) : now?.title ? (
            <>
              {now.title}
              {now.artist && <span className="chat-sub">（{now.artist}）</span>}
            </>
          ) : (
            t("聊天模式")
          )}
        </h1>
        <button
          className={`chat-btn${settings.chatOnTop ? " is-on" : ""}`}
          aria-pressed={settings.chatOnTop}
          aria-label={settings.chatOnTop ? t("取消置顶") : t("置顶")}
          title={settings.chatOnTop ? t("取消置顶") : t("置顶")}
          onClick={() => update({ chatOnTop: !settings.chatOnTop })}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 4h6l-1 6 3 3v1H7v-1l3-3zM12 14v6" />
          </svg>
        </button>
        <button className="chat-btn" aria-label={t("关闭")} title={t("关闭")} onClick={() => void win.close()}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </header>

      <div className="chat-list" role="log" aria-label={t("歌词")}>
        {visible.map((m) => (
          <Bubble key={m.key} m={m} fresh={!!fresh.current.get(m.key)} art={artwork?.dataUrl ?? null} avatar={settings.chatAvatar} trans={settings.showTranslation} />
        ))}
        {empty && <p className="chat-empty">{empty}</p>}
      </div>

      <div className="chat-input" aria-hidden="true">
        <div className="chat-typed">
          {typed ? (
            <>
              {typed}
              <span className="chat-caret" />
            </>
          ) : (
            <span className="chat-ph">{t("轮到你唱的时候，歌词会先出现在这里")}</span>
          )}
        </div>
        <span className={`chat-send${typed ? " is-ready" : ""}`}>{t("发送")}</span>
      </div>
    </div>
  );
}

const Bubble = memo(function Bubble({ m, fresh, art, avatar, trans }: { m: ChatMessage; fresh: boolean; art: string | null; avatar: string; trans: boolean }) {
  return (
    <div className={`chat-grow${fresh ? " is-new" : ""}`}>
      <div>
        {m.stamp && <div className="chat-stamp">{m.stamp}</div>}
        <div className={`chat-row chat-row--${m.side}`}>
          {m.side === "L" ? (
            art ? <img className="chat-av" src={art} alt="" /> : <span className="chat-av chat-av--album" />
          ) : avatar ? (
            <img className="chat-av" src={avatar} alt="" />
          ) : (
            <span className="chat-av chat-av--me">
              <svg viewBox="0 0 40 40" width="100%" height="100%" aria-hidden="true">
                <circle cx="20" cy="16" r="7" fill="rgba(255,255,255,.92)" />
                <path d="M7 37c1.5-8 6.5-12 13-12s11.5 4 13 12" fill="rgba(255,255,255,.92)" />
              </svg>
            </span>
          )}
          <span className="chat-bub">
            {m.text}
            {trans && m.trans && <span className="chat-trans">{m.trans}</span>}
          </span>
        </div>
      </div>
    </div>
  );
});

/** 浅色 / 深色 / 跟随系统 */
function useDark(theme: "light" | "dark" | "system"): boolean {
  const query = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const [sys, setSys] = useState(query?.matches ?? false);
  useEffect(() => {
    if (!query) return;
    const on = () => setSys(query.matches);
    query.addEventListener("change", on);
    return () => query.removeEventListener("change", on);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return theme === "dark" || (theme === "system" && sys);
}
