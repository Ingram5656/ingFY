import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { formatTime } from "../lib/player";

interface ListTrack {
  uri: string;
  name: string;
  artists: string;
  durationMs: number;
}

interface NowListData {
  kind: "album" | "playlist" | "queue";
  contextUri: string | null;
  title: string;
  subtitle: string;
  image: string | null;
  tracks: ListTrack[];
  currentUri: string | null;
  note: string | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  loggedIn: boolean;
  needsReauth: boolean;
  onLogin: () => void;
  /** 换歌时变化，用来刷新"正在播放"是哪一首 */
  trackKey: string;
  /** 当前歌名，Spotify 那边还没报上新歌时，先按歌名高亮 */
  currentTitle: string;
}

/**
 * 右下角的播放列表：正在播放的专辑或歌单里的所有歌，当前这首高亮，点哪首播哪首。
 * 不是从专辑 / 歌单播放时（单曲、电台、"已点赞的歌曲"），显示接下来的播放队列。
 */
export function NowListPanel(p: Props) {
  const [data, setData] = useState<NowListData | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "none" | "error">("idle");
  const [error, setError] = useState("");
  const [busyUri, setBusyUri] = useState<string | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const scrolledFor = useRef<string | null>(null);

  // 打开时、以及打开状态下换歌时刷新。稍等一下，让 Spotify 那边先切到新歌
  useEffect(() => {
    if (!p.open || !p.loggedIn || p.needsReauth) return;
    let alive = true;
    if (!data) setStatus("loading");
    const t = setTimeout(
      () => {
        invoke<NowListData | null>("spotify_now_list")
          .then((d) => {
            if (!alive) return;
            setData(d);
            setStatus(d ? "ready" : "none");
          })
          .catch((e) => {
            if (!alive) return;
            setError(String(e));
            setStatus("error");
          });
      },
      data ? 700 : 0,
    );
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.open, p.loggedIn, p.needsReauth, p.trackKey]);

  // 当前这首：Spotify 报的 URI 优先，对不上再按歌名找
  const tracks = data?.tracks ?? [];
  let currentIdx = data?.currentUri ? tracks.findIndex((t) => t.uri === data.currentUri) : -1;
  if (currentIdx < 0 && p.currentTitle) currentIdx = tracks.findIndex((t) => t.name === p.currentTitle);

  // 打开或换歌后，把当前这首滚到列表中间（同一首只滚一次，不打扰手动翻看）
  useEffect(() => {
    if (!p.open || currentIdx < 0) return;
    const key = `${data?.contextUri ?? ""}|${currentIdx}`;
    if (scrolledFor.current === key) return;
    const first = scrolledFor.current === null;
    scrolledFor.current = key;
    const list = listRef.current;
    const el = list?.children[currentIdx] as HTMLElement | undefined;
    // 只滚列表自己，不用 scrollIntoView（它会连带滚动外层的舞台）
    if (list && el) list.scrollTo({ top: el.offsetTop - list.clientHeight / 2 + el.offsetHeight / 2, behavior: first ? "auto" : "smooth" });
  }, [p.open, currentIdx, data?.contextUri]);

  useEffect(() => {
    if (!p.open) scrolledFor.current = null;
  }, [p.open]);

  // Esc 关闭
  useEffect(() => {
    if (!p.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") p.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p.open, p.onClose]);

  if (!p.open) return null;

  const play = async (t: ListTrack) => {
    setBusyUri(t.uri);
    try {
      await invoke("spotify_play_track", { contextUri: data?.contextUri ?? null, trackUri: t.uri });
      setData((d) => (d ? { ...d, currentUri: t.uri } : d));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyUri(null);
    }
  };

  const kindLabel = data?.kind === "album" ? "专辑" : data?.kind === "playlist" ? "歌单" : "队列";

  let body;
  if (!p.loggedIn) {
    body = (
      <div className="nl-empty">
        <p>连接 Spotify 后，这里会列出正在播放的歌单或专辑里的所有歌</p>
        <button className="st-btn" onClick={p.onLogin}>连接 Spotify</button>
      </div>
    );
  } else if (p.needsReauth) {
    body = (
      <div className="nl-empty">
        <p>播放列表需要新的 Spotify 权限，重新连接一次就好</p>
        <button className="st-btn" onClick={p.onLogin}>重新连接</button>
      </div>
    );
  } else if (status === "loading") {
    body = <p className="nl-hint">正在读取…</p>;
  } else if (status === "none") {
    body = <p className="nl-hint">现在没有在 Spotify 里播放</p>;
  } else if (status === "error" && !data) {
    body = <p className="nl-hint">{error}</p>;
  } else if (data) {
    body = (
      <>
        {data.note && <p className="nl-note">{data.note}，先显示播放队列</p>}
        {tracks.length === 0 ? (
          <p className="nl-hint">列表是空的</p>
        ) : (
          <ol className="nl-list" ref={listRef}>
            {tracks.map((t, i) => {
              const on = i === currentIdx;
              return (
                <li key={`${t.uri}-${i}`}>
                  <button
                    className={`nl-row${on ? " is-on" : ""}${busyUri === t.uri ? " is-busy" : ""}`}
                    aria-current={on ? "true" : undefined}
                    onClick={() => play(t)}
                  >
                    <span className="nl-idx" aria-hidden="true">
                      {on ? (
                        <span className="nl-eq">
                          <i />
                          <i />
                          <i />
                        </span>
                      ) : (
                        i + 1
                      )}
                    </span>
                    <span className="nl-text">
                      <span className="nl-name">{t.name}</span>
                      <span className="nl-artist">{t.artists}</span>
                    </span>
                    <span className="nl-dur">{t.durationMs ? formatTime(t.durationMs) : ""}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
        {status === "error" && error && <p className="nl-note nl-note--error">{error}</p>}
      </>
    );
  }

  return (
    <section className="nl-panel glass" role="dialog" aria-label="播放列表">
      <header className="nl-head">
        {data?.image ? <img className="nl-cover" src={data.image} alt="" /> : <span className="nl-cover nl-cover--empty" aria-hidden="true" />}
        <div className="nl-title">
          <small>{data ? `正在播放的${kindLabel}` : "播放列表"}</small>
          <strong>{data?.title || "播放列表"}</strong>
          {data && (
            <span>
              {data.subtitle ? `${data.subtitle}，` : ""}
              {tracks.length} 首
            </span>
          )}
        </div>
        <button className="nl-close" aria-label="关闭播放列表" onClick={p.onClose}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </header>
      {body}
    </section>
  );
}
