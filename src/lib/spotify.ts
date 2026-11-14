import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { NowPlaying } from "./types";
import { trackKey } from "./types";
import { t, tMsg } from "./i18n";

export interface AccountStatus {
  loggedIn: boolean;
  displayName: string;
  /** 已登录但缺少新权限、或者登录已过期，要重新连接 */
  needsReauth: boolean;
  /** 登录已过期（开发模式下大约半年一次） */
  expired?: boolean;
  /** 正在使用自己填的 Client ID */
  customClient?: boolean;
}

/**
 * Spotify 账号和当前歌曲的收藏状态。
 * liked 为 null 表示不知道：没登录、正在查询、或者当前不是在 Spotify 放歌。
 */
// 记住上次的登录状态，启动时先按它显示，免得"曲库/专辑"按钮等后端回话后才闪出来
const LOGGED_IN_KEY = "ingfy.spotify.loggedIn";
function cachedLoggedIn() {
  try { return localStorage.getItem(LOGGED_IN_KEY) === "1"; } catch { return false; }
}

export function useSpotify(now: NowPlaying | null) {
  const [account, setAccountState] = useState<AccountStatus>(() => ({ loggedIn: cachedLoggedIn(), displayName: "", needsReauth: false }));
  /** 后端已经告诉过我们真实的登录状态 */
  const [ready, setReady] = useState(false);
  const setAccount = (a: AccountStatus) => {
    setAccountState(a);
    setReady(true);
    try { localStorage.setItem(LOGGED_IN_KEY, a.loggedIn ? "1" : "0"); } catch {}
  };
  const [liked, setLiked] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; kind: "ok" | "error" } | null>(null);
  const key = now?.title ? trackKey(now) : "";

  useEffect(() => {
    const un: Promise<UnlistenFn>[] = [];
    invoke<AccountStatus>("spotify_status").then(setAccount).catch(() => setReady(true));
    un.push(listen<AccountStatus>("spotify-account", (e) => setAccount(e.payload)));
    un.push(listen<boolean>("liked-changed", (e) => setLiked(e.payload)));
    return () => un.forEach((p) => p.then((u) => u()));
  }, []);

  // 换歌后查一下是否已收藏。稍等一会儿，让 Spotify 那边的"正在播放"先更新到新歌。
  useEffect(() => {
    setLiked(null);
    if (!account.loggedIn || !key) return;
    let alive = true;
    const t = setTimeout(() => {
      invoke<boolean | null>("spotify_liked")
        .then((r) => alive && setLiked(r))
        .catch(() => alive && setLiked(null));
    }, 900);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [key, account.loggedIn]);

  // 提示条 3 秒后消失
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), 3000);
    return () => clearTimeout(t);
  }, [message]);

  const toggleLike = async () => {
    if (liked === null) return;
    const next = !liked;
    setLiked(next);
    try {
      await invoke("spotify_set_liked", { liked: next });
      setMessage({ text: next ? t("已添加到 Spotify 的“已点赞的歌曲”") : t("已从“已点赞的歌曲”中移除"), kind: "ok" });
    } catch (e) {
      setLiked(!next);
      setMessage({ text: tMsg(String(e)), kind: "error" });
    }
  };

  const login = async () => {
    setBusy(true);
    try {
      setAccount(await invoke<AccountStatus>("spotify_login"));
      setMessage({ text: t("已连接 Spotify"), kind: "ok" });
    } catch (e) {
      setMessage({ text: tMsg(String(e)), kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    setAccount(await invoke<AccountStatus>("spotify_logout"));
    setLiked(null);
  };

  return { account, ready, liked, busy, message, toggleLike, login, logout };
}
