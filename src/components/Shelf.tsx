import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type WheelEvent,
} from "react";
import { formatTime } from "../lib/player";
import { Presence } from "./Presence";
import { invoke } from "@tauri-apps/api/core";
import { PlayIcon } from "./Icons";

export type ShelfKind = "playlist" | "album";

export interface ShelfItem {
  uri: string;
  name: string;
  /** 专辑是歌手，歌单是创建者 */
  subtitle: string;
  image: string | null;
  /** liked 是"已点赞的歌曲"，没有封面图，用紫色爱心封面 */
  kind: ShelfKind | "liked";
}

interface Props {
  kind: ShelfKind;
  loggedIn: boolean;
  needsReauth: boolean;
  loginBusy: boolean;
  onLogin: () => void;
  searchOpen: boolean;
  onCloseSearch: () => void;
}

/** 曲库内容按类型缓存，切页面再回来不用重新拉 */
const libraryCache = new Map<ShelfKind, ShelfItem[]>();

const SPACING = 116; // 相邻两张在架子上的间距（设计稿像素）
const PICKED_X = -250; // 抽出来的唱片挪到的位置
const PICKED_CENTER = (PICKED_X * 1500) / (1500 - 180); // 透视后它在屏幕上的中心（perspective 1500，往前推 180）
const RENDER_RANGE = 9; // 只画当前位置左右各 9 张
const WHEEL_STEP = 90; // 滚轮累计多少算翻一张：普通鼠标一格（100）正好翻一张，触控板慢慢滑也能翻

/**
 * 曲库 / 专辑：一排竖着插在架子上的封面，像在唱片箱里翻唱片。
 * - 滚轮左右翻；点旁边的一张会翻到它；点正中间那张把它抽出来正对你，再点播放。
 * - 右上角搜索：在 Spotify 曲库里搜，或者只在自己的歌单 / 专辑里筛。
 */
export function LibraryView(p: Props) {
  const [items, setItems] = useState<ShelfItem[] | null>(() => libraryCache.get(p.kind) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; kind: "ok" | "error" } | null>(null);

  // ---- 拉曲库 ----
  const load = useCallback(() => {
    if (!p.loggedIn) return;
    setError(null);
    invoke<ShelfItem[]>("spotify_library", { kind: p.kind })
      .then((list) => {
        libraryCache.set(p.kind, list);
        setItems(list);
      })
      .catch((e) => setError(String(e)));
  }, [p.kind, p.loggedIn]);

  useEffect(() => {
    setItems(libraryCache.get(p.kind) ?? null);
    load();
  }, [load, p.kind]);

  // ---- 搜索 ----
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"spotify" | "mine">("mine");
  const [remote, setRemote] = useState<{ q: string; list: ShelfItem[] } | null>(null);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (p.searchOpen) inputRef.current?.focus();
    else {
      setQuery("");
      setRemote(null);
    }
  }, [p.searchOpen]);

  // 换页面时清掉搜索
  useEffect(() => {
    setQuery("");
    setRemote(null);
  }, [p.kind]);

  // Spotify 曲库搜索：停止输入 450ms 后再发请求
  useEffect(() => {
    const q = query.trim();
    if (scope !== "spotify" || !q) {
      setRemote(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    let alive = true;
    const t = setTimeout(() => {
      invoke<ShelfItem[]>("spotify_search", { query: q, kind: p.kind })
        .then((list) => alive && setRemote({ q, list }))
        .catch((e) => alive && setToast({ text: String(e), kind: "error" }))
        .finally(() => alive && setSearching(false));
    }, 450);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query, scope, p.kind]);

  const q = query.trim().toLowerCase();
  const shown: ShelfItem[] = useMemo(() => {
    if (!q) return items ?? [];
    if (scope === "spotify") return remote?.list ?? [];
    return (items ?? []).filter((it) => it.name.toLowerCase().includes(q) || it.subtitle.toLowerCase().includes(q));
  }, [q, scope, items, remote]);

  // 提示条 3 秒后消失
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  const play = async (it: ShelfItem) => {
    setToast({ text: `正在打开《${it.name}》…`, kind: "ok" });
    try {
      await invoke("spotify_play", { uri: it.uri });
      setToast({ text: `开始播放《${it.name}》`, kind: "ok" });
    } catch (e) {
      setToast({ text: String(e), kind: "error" });
    }
  };

  const playTrack = async (it: ShelfItem, t: ListTrack) => {
    setToast({ text: `正在打开《${t.name}》…`, kind: "ok" });
    try {
      await invoke("spotify_play_track", { contextUri: it.uri, trackUri: t.uri });
      setToast({ text: `开始播放《${t.name}》`, kind: "ok" });
    } catch (e) {
      setToast({ text: String(e), kind: "error" });
    }
  };

  const mineLabel = p.kind === "playlist" ? "我的歌单" : "我的专辑";
  const noun = p.kind === "playlist" ? "歌单" : "专辑";

  let empty: { text: string; action?: { label: string; run: () => void } } | null = null;
  if (!p.loggedIn) {
    empty = {
      text: `连接 Spotify 后，这里会摆满你的${noun}`,
      action: { label: p.loginBusy ? "正在连接…" : "连接 Spotify", run: p.onLogin },
    };
  } else if (p.needsReauth) {
    empty = { text: "曲库需要新的 Spotify 权限，重新连接一次就好", action: { label: "重新连接", run: p.onLogin } };
  } else if (error && !items) {
    empty = { text: error, action: { label: "重试", run: load } };
  } else if (!items) {
    empty = { text: `正在读取你的${noun}…` };
  } else if (q && scope === "spotify" && searching && !remote) {
    empty = { text: "正在 Spotify 里搜…" };
  } else if (q && shown.length === 0) {
    empty = { text: scope === "spotify" ? `Spotify 里没搜到相关的${noun}` : `${mineLabel}里没有"${query.trim()}"` };
  } else if (shown.length === 0) {
    empty = { text: p.kind === "playlist" ? "你还没有歌单，去 Spotify 里建一个或关注几个吧" : "你还没有收藏专辑，在 Spotify 里点专辑页的加号就能收藏" };
  }

  return (
    <>
      <Presence show={p.searchOpen}>
        <div className="lib-search glass" role="search">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            placeholder={scope === "spotify" ? `在 Spotify 搜${noun}` : `在${mineLabel}里找`}
            aria-label="搜索"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") p.onCloseSearch();
            }}
          />
          <div className="lib-scope" role="radiogroup" aria-label="搜索范围">
            {(
              [
                ["mine", mineLabel],
                ["spotify", "Spotify 曲库"],
              ] as const
            ).map(([id, label]) => (
              <button key={id} role="radio" aria-checked={scope === id} className={scope === id ? "is-on" : ""} onClick={() => setScope(id)}>
                {label}
              </button>
            ))}
          </div>
          <button className="lib-close" aria-label="关闭搜索" onClick={p.onCloseSearch}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      </Presence>

      {empty ? (
        <div className="lib-empty">
          <p>{empty.text}</p>
          {empty.action && (
            <button className="st-btn" onClick={empty.action.run}>
              {empty.action.label}
            </button>
          )}
        </div>
      ) : (
        <Shelf key={`${p.kind}|${scope}|${q}`} items={shown} onPlay={play} onPlayTrack={playTrack} />
      )}

      <Presence show={!!toast}>
        {toast && (
          <div className={`toast glass${toast.kind === "error" ? " toast--error" : ""}`} role="status">
            {toast.text}
          </div>
        )}
      </Presence>
    </>
  );
}

// ------------------------------------------------------------------ 架子

function Shelf({
  items,
  onPlay,
  onPlayTrack,
}: {
  items: ShelfItem[];
  onPlay: (it: ShelfItem) => void;
  onPlayTrack: (it: ShelfItem, t: ListTrack) => void;
}) {
  const n = items.length;
  const [pos, setPos] = useState(0);
  const [picked, setPickedRaw] = useState<number | null>(null);
  // 抽出 / 放回唱片时给 0.5 秒的过渡；平时翻动由 JS 逐帧驱动，不加过渡免得拖泥带水
  const [pickAnim, setPickAnim] = useState(false);
  const pickTimer = useRef<ReturnType<typeof setTimeout>>();
  const setPicked = useCallback((v: number | null | ((cur: number | null) => number | null)) => {
    setPickedRaw(v);
    setPickAnim(true);
    clearTimeout(pickTimer.current);
    pickTimer.current = setTimeout(() => setPickAnim(false), 550);
  }, []);
  const shelfRef = useRef<HTMLDivElement>(null);
  const target = useRef(0);
  const posRef = useRef(0);
  const raf = useRef(0);
  const acc = useRef(0);
  const accTimer = useRef<ReturnType<typeof setTimeout>>();

  // 位置向目标平滑靠拢，到了就停，不一直重绘
  const animate = useCallback(() => {
    cancelAnimationFrame(raf.current);
    const step = () => {
      const diff = target.current - posRef.current;
      if (Math.abs(diff) < 0.002) {
        posRef.current = target.current;
        setPos(target.current);
        return;
      }
      posRef.current += diff * 0.16;
      setPos(posRef.current);
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  }, []);

  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current);
      clearTimeout(pickTimer.current);
      clearTimeout(accTimer.current);
    },
    [],
  );

  const goTo = useCallback(
    (i: number) => {
      const t = Math.max(0, Math.min(n - 1, i));
      if (t === target.current) return;
      target.current = t;
      setPicked(null);
      animate();
    },
    [n, animate, setPicked],
  );

  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    // 竖着滚和横着滑都算左右翻
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    acc.current += d;
    clearTimeout(accTimer.current);
    accTimer.current = setTimeout(() => (acc.current = 0), 220);
    const steps = Math.trunc(acc.current / WHEEL_STEP);
    if (steps !== 0) {
      acc.current -= steps * WHEEL_STEP;
      goTo(Math.round(target.current) + Math.max(-3, Math.min(3, steps)));
    }
  };

  // ---- 鼠标拖动：按住左右拖，唱片跟着手走；松手按甩出去的速度多滑几张再停 ----
  const drag = useRef<{ x: number; startPos: number; lastX: number; lastT: number; v: number; moved: boolean; id: number } | null>(null);
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState(false);
  const stageK = () => {
    const r = shelfRef.current?.getBoundingClientRect();
    return r ? r.width / 1440 : 1;
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !n) return;
    if ((e.target as HTMLElement).closest(".rec-play")) return;
    drag.current = { x: e.clientX, startPos: posRef.current, lastX: e.clientX, lastT: performance.now(), v: 0, moved: false, id: e.pointerId };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = (e.clientX - d.x) / stageK();
    if (!d.moved) {
      if (Math.abs(dx) < 6) return;
      d.moved = true;
      setDragging(true);
      shelfRef.current?.setPointerCapture(e.pointerId);
      cancelAnimationFrame(raf.current);
      if (picked !== null) setPicked(null);
    }
    const now = performance.now();
    const dt = Math.max(1, now - d.lastT);
    // 速度做一点平滑，单位：张 / 毫秒
    d.v = d.v * 0.6 + (-(e.clientX - d.lastX) / stageK() / SPACING / dt) * 0.4;
    d.lastX = e.clientX;
    d.lastT = now;
    // 拖到两头会有一点阻尼，不会一下子拖出架子
    let p = d.startPos - dx / SPACING;
    if (p < 0) p = p * 0.3;
    if (p > n - 1) p = n - 1 + (p - (n - 1)) * 0.3;
    posRef.current = p;
    target.current = p;
    setPos(p);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d || !d.moved) return;
    setDragging(false);
    suppressClick.current = true;
    shelfRef.current?.releasePointerCapture?.(e.pointerId);
    // 甩出去：速度 × 250ms 作为惯性距离，最多 8 张
    const fling = Math.max(-8, Math.min(8, d.v * 250));
    target.current = Math.max(0, Math.min(n - 1, Math.round(posRef.current + fling)));
    animate();
  };

  const center = Math.round(pos);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowRight") goTo(center + 1);
    else if (e.key === "ArrowLeft") goTo(center - 1);
    else if (e.key === "Enter") {
      if (picked === center) onPlay(items[center]);
      else setPicked(center);
    } else if (e.key === "Escape") setPicked(null);
    else return;
    e.preventDefault();
  };

  const onPick = (i: number) => {
    if (i !== center) goTo(i);
    else setPicked((cur) => (cur === i ? null : i));
  };
  // 点击按位置算是哪一张：正中间的唱片只露一条很窄的书脊，浏览器对这种侧着的 3D 面点不中，
  // 所以不靠元素命中，而是把点击的横坐标换算成架子上的第几张。
  const onShelfClick = (e: MouseEvent<HTMLDivElement>) => {
    if (suppressClick.current) {
      // 刚拖完松手，不算点击
      suppressClick.current = false;
      return;
    }
    const el = shelfRef.current;
    if (!el || !n) return;
    const r = el.getBoundingClientRect();
    const k = r.width / 1440; // 舞台按 1440 宽等比缩放
    const x = (e.clientX - (r.left + r.width / 2)) / k;
    const y = (e.clientY - r.top) / k;
    if (picked !== null) {
      // 抽出来的那张挪到了左边（中心约在 -284，宽约 590），点它本身不动；
      // 右边的曲目面板自己处理点击；点别处把唱片放回去
      if (Math.abs(x - PICKED_CENTER) > 300 || y < 120 || y > 760) setPicked(null);
      return;
    }
    if (y < 120 || y > 760) return;
    onPick(Math.max(0, Math.min(n - 1, Math.round(pos + x / SPACING))));
  };

  const from = Math.max(0, Math.floor(pos) - RENDER_RANGE);
  const to = Math.min(n - 1, Math.ceil(pos) + RENDER_RANGE);
  const visible: number[] = [];
  for (let i = from; i <= to; i++) visible.push(i);

  return (
    <>
    <div
      className={`shelf${picked !== null ? " has-picked" : ""}${pickAnim ? " is-picking" : ""}${dragging ? " is-dragging" : ""}`}
      onWheel={onWheel}
      onKeyDown={onKey}
      tabIndex={0}
      role="listbox"
      aria-label="唱片架，滚轮或拖动左右翻"
      aria-activedescendant={n ? `rec-${center}` : undefined}
      ref={shelfRef}
      onClick={onShelfClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className="shelf-row">
        {visible.map((i) => (
          <Record
            key={items[i].uri + i}
            id={`rec-${i}`}
            item={items[i]}
            d={i - pos}
            picked={picked === i}
            pickedSide={picked === null ? 0 : Math.sign(i - picked)}
            onPlay={() => onPlay(items[i])}
          />
        ))}
      </div>
    </div>
    {/* 曲目面板放在架子外面：架子有左右渐隐的遮罩，放里面毛玻璃会只模糊到架子里的东西 */}
    <Presence show={picked !== null && !!items[picked]}>
      {picked !== null && items[picked] && (
        <ShelfTracks key={items[picked].uri} item={items[picked]} onPlayTrack={onPlayTrack} onClose={() => setPicked(null)} />
      )}
    </Presence>
    </>
  );
}

interface RecordProps {
  id: string;
  item: ShelfItem;
  /** 相对当前位置的偏移，0 是正中间，可以是小数（翻动途中） */
  d: number;
  picked: boolean;
  /** 有一张被抽出来时，其他唱片往两边让：-1 左边让，1 右边让 */
  pickedSide: number;
  onPlay: () => void;
}

const Record = memo(function Record({ id, item, d, picked, pickedSide, onPlay }: RecordProps) {
  const spineFromCover = useSpineColor(item.image);
  const spine = item.kind === "liked" ? { bg: "#4a2fd0", ink: "#ffffff" } : spineFromCover;
  const ad = Math.abs(d);
  // 竖着插在架子上：正中间侧面朝前（只看到书脊），往两边逐渐转开、露出封面。
  // 角度随位置连续变化（左边 66°~90°，右边 90°~114°），翻动时只是轻轻偏一点，
  // 不会在经过中间时整张翻面，也就不会和旁边的唱片穿插。右半边看到的是封套背面，背面也印着封面。
  const rot = 90 + Math.max(-4, Math.min(4, d)) * 6;
  const style = {
    // 抽出来的那张挪到左边给曲目面板让位；其余的往两边让开（右边让得更远，藏到面板后面）
    "--x": picked ? `${PICKED_X}px` : `${d * SPACING + (pickedSide < 0 ? -560 : pickedSide > 0 ? 900 : 0)}px`,
    "--rot": picked ? "0deg" : `${rot}deg`,
    "--z": picked ? "180px" : `${-Math.min(ad, 6) * 14}px`,
    "--blur": `${Math.max(0, ad - 5.5) * 3}px`,
    "--fade": ad > RENDER_RANGE - 1 ? Math.max(0, RENDER_RANGE - ad) : 1,
    "--spine": spine.bg,
    "--spine-ink": spine.ink,
    zIndex: picked ? 100 : 50 - Math.round(ad * 2),
  } as CSSProperties;
  const title = `${item.name}${item.subtitle ? `，${item.subtitle}` : ""}`;

  return (
    <div
      id={id}
      className={`rec${picked ? " is-picked" : ""}`}
      style={style}
      role="option"
      aria-selected={ad < 0.5}
      aria-label={title}
    >
      <div className="rec-face rec-front">
        <Cover item={item} />
        {picked && (
          <div className="rec-info">
            <div>
              <strong>{item.name}</strong>
              {item.subtitle && <span>{item.subtitle}</span>}
            </div>
            <button
              className="rec-play"
              aria-label={`播放${item.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onPlay();
              }}
            >
              <PlayIcon size={30} />
            </button>
          </div>
        )}
      </div>
      <div className="rec-face rec-back">
        <Cover item={item} />
      </div>
      <Spine side="l" name={item.name} sub={item.subtitle} />
      <Spine side="r" name={item.name} sub={item.subtitle} />
    </div>
  );
});

// ------------------------------------------------------------------ 曲目面板

export interface ListTrack {
  uri: string;
  name: string;
  artists: string;
  durationMs: number;
}

interface ContextList {
  title: string;
  subtitle: string;
  tracks: ListTrack[];
}

const tracksCache = new Map<string, ContextList>();

/** 抽出唱片后在右边展开的曲目列表：点哪首从哪首开始播 */
function ShelfTracks({ item, onPlayTrack, onClose }: { item: ShelfItem; onPlayTrack: (it: ShelfItem, t: ListTrack) => void; onClose: () => void }) {
  const [data, setData] = useState<ContextList | null>(() => tracksCache.get(item.uri) ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (tracksCache.has(item.uri)) return;
    let alive = true;
    invoke<ContextList>("spotify_context_tracks", { uri: item.uri })
      .then((d) => {
        tracksCache.set(item.uri, d);
        if (alive) setData(d);
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [item.uri]);

  const noun = item.kind === "album" ? "专辑" : "歌单";
  return (
    <section className="shelf-tracks glass glass--thick" aria-label={`${item.name}的曲目`}>
      <header className="trk-head">
        <div>
          <small>{noun}曲目</small>
          <strong>{item.name}</strong>
          <span>{data ? `${data.tracks.length} 首` : item.subtitle}</span>
        </div>
        <button className="nl-close" aria-label="收起" onClick={onClose}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </header>
      {error ? (
        <p className="nl-hint">{error}</p>
      ) : !data ? (
        <ol className="nl-list trk-skel" aria-busy="true">
          {Array.from({ length: 8 }, (_, i) => (
            <li key={i}>
              <span style={{ animationDelay: `${i * 60}ms` }} />
            </li>
          ))}
        </ol>
      ) : data.tracks.length === 0 ? (
        <p className="nl-hint">这个{noun}里还没有歌</p>
      ) : (
        <ol className="nl-list">
          {data.tracks.map((t, i) => (
            <li key={`${t.uri}-${i}`} style={{ animationDelay: `${Math.min(i, 12) * 28}ms` }} className="trk-row-in">
              <button className="nl-row" onClick={() => onPlayTrack(item, t)}>
                <span className="nl-idx">{i + 1}</span>
                <span className="nl-text">
                  <span className="nl-name">{t.name}</span>
                  <span className="nl-artist">{t.artists}</span>
                </span>
                <span className="nl-dur">{t.durationMs ? formatTime(t.durationMs) : ""}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Cover({ item }: { item: ShelfItem }) {
  if (item.image) return <img src={item.image} alt="" draggable={false} />;
  if (item.kind === "liked") return <LikedCover />;
  return <span className="rec-noimg">{item.name.slice(0, 2)}</span>;
}

/** "已点赞的歌曲"的封面：紫蓝渐变上一颗白色爱心 */
export function LikedCover() {
  return (
    <span className="liked-cover" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 20.6l-1.3-1.2C5.6 14.8 2.5 12 2.5 8.4 2.5 5.6 4.7 3.4 7.5 3.4c1.6 0 3.2.8 4.5 2 1.3-1.2 2.9-2 4.5-2 2.8 0 5 2.2 5 5 0 3.6-3.1 6.4-8.2 11l-1.3 1.2z" />
      </svg>
    </span>
  );
}

function Spine({ side, name, sub }: { side: "l" | "r"; name: string; sub: string }) {
  return (
    <div className={`rec-face rec-spine rec-spine--${side}`} aria-hidden="true">
      <span>
        <b>{name}</b>
        {sub && <i>{sub}</i>}
      </span>
    </div>
  );
}

// ------------------------------------------------------------------ 书脊颜色

const spineCache = new Map<string, { bg: string; ink: string }>();
const DEFAULT_SPINE = { bg: "#f1efe9", ink: "#1d1d1f" };

/** 书脊用封面左边一条的平均色，像真的唱片封套；读不到（跨域被拦）就用米白 */
function useSpineColor(url: string | null) {
  const [c, setC] = useState(() => (url && spineCache.get(url)) || DEFAULT_SPINE);
  useEffect(() => {
    if (!url) return;
    const hit = spineCache.get(url);
    if (hit) {
      setC(hit);
      return;
    }
    let alive = true;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const cv = document.createElement("canvas");
        cv.width = 4;
        cv.height = 16;
        const ctx = cv.getContext("2d")!;
        // 只取最左边 6% 的一条
        ctx.drawImage(img, 0, 0, Math.max(1, img.width * 0.06), img.height, 0, 0, 4, 16);
        const data = ctx.getImageData(0, 0, 4, 16).data;
        let r = 0, g = 0, b = 0;
        for (let i = 0; i < data.length; i += 4) {
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
        }
        const k = data.length / 4;
        r = Math.round(r / k);
        g = Math.round(g / k);
        b = Math.round(b / k);
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const v = { bg: `rgb(${r}, ${g}, ${b})`, ink: lum > 150 ? "#1d1d1f" : "#ffffff" };
        spineCache.set(url, v);
        if (alive) setC(v);
      } catch {
        spineCache.set(url, DEFAULT_SPINE);
      }
    };
    img.src = url;
    return () => {
      alive = false;
    };
  }, [url]);
  return c;
}
