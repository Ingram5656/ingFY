import { useEffect, useRef, useState, type ComponentProps, type CSSProperties } from "react";
import { useCrossfade, useDragReorder, useIdle, useSegThumb } from "../lib/motion";
import { LibraryView } from "../components/Shelf";
import { NowListPanel } from "../components/NowList";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Lights, type LightStyle } from "../components/Lights";
import { Lights3D } from "../components/Lights3D";
import { InkCover } from "../components/InkCover";
import { FitText } from "../components/FitText";
import { LyricScroller } from "../components/LyricScroller";
import { SeekBar } from "../components/SeekBar";
import { SettingsPanel } from "../components/SettingsPanel";
import { VinylView } from "../components/Vinyl";
import { markDirection } from "../lib/vinyl";
import { GearIcon, HeartIcon, NextIcon, PauseIcon, PlayIcon, PrevIcon } from "../components/Icons";
import { findLineIndex, lineProgress } from "../lib/lrc";
import { mediaControl, useAlbumPalette, useLyrics, usePlayer } from "../lib/player";
import { PlayheadProvider, usePlayhead, usePositionRef } from "../lib/playhead";
import type { LyricLine } from "../lib/types";
import { applyShortcuts, shortcutsOf } from "../lib/shortcuts";
import { useBackgroundVideo } from "../lib/bgvideo";
import { DEFAULT_BASE, deepTone } from "../lib/palette";
import { baseOf, lightOrderOf, lightPalette, loadBackgroundImage, lyricScale, thickScale, useApplySettings, useSettings } from "../lib/settings";
import { useSpotify } from "../lib/spotify";
import { setLyricPref, useLyricPref } from "../lib/lyricPrefs";
import { trackKey } from "../lib/types";
import { SLEEP_FADE_MS, sleepLabel, useSleepTimer } from "../lib/sleep";
import { MoreMenu } from "../components/MoreMenu";
import { WindowsMenu } from "../components/WindowsMenu";
import { Presence } from "../components/Presence";
import { LyricPicker } from "../components/LyricPicker";
import { ShareSheet } from "../components/ShareSheet";
import { Sheet } from "../components/Sheet";
import type { UpdateInfo } from "../components/SettingsPanel";
import { t, tMsg, useLang } from "../lib/i18n";

const STYLE_LABEL: Record<LightStyle, string> = { ink: "墨晕", hist: "直方图", ring: "圆环", wave: "声波" };

/** 设计稿尺寸。整个界面按这个尺寸排版，再等比缩放到窗口大小，各部分比例位置始终不变 */
const STAGE_W = 1440;
const STAGE_H = 900;

function useStageScale() {
  const calc = () => Math.min(window.innerWidth / STAGE_W, window.innerHeight / STAGE_H);
  const [scale, setScale] = useState(calc);
  useEffect(() => {
    const onResize = () => setScale(calc());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return scale;
}

/** 全屏：无边框铺满整个屏幕。按 Esc 退出 */
function useFullscreen() {
  const [full, setFull] = useState(false);
  const set = (v: boolean) => {
    getCurrentWindow()
      .setFullscreen(v)
      .then(() => setFull(v))
      .catch(() => {});
  };
  useEffect(() => {
    const win = getCurrentWindow();
    // 窗口大小变化时同步一下（比如被系统退出全屏）
    const sync = () => win.isFullscreen().then(setFull).catch(() => {});
    sync();
    window.addEventListener("resize", sync);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") win.isFullscreen().then((f) => f && set(false));
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", sync);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  return { full, toggle: () => set(!full) };
}

function useBackgroundImage() {
  const [img, setImg] = useState<string | null>(loadBackgroundImage);
  useEffect(() => {
    const un = listen("bg-image-changed", () => setImg(loadBackgroundImage()));
    return () => {
      un.then((u) => u());
    };
  }, []);
  return img;
}

/**
 * 视频背景：静音循环铺满。窗口藏起来、最小化，或者被墨晕的宣纸盖住时暂停，不在后台白白解码
 */
function BackgroundVideo({ src, paused }: { src: string; paused: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const sync = () => {
      if (paused || document.hidden) v.pause();
      else void v.play().catch(() => {});
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, [paused, src]);
  return <video ref={ref} className="fs-bg fs-bg--video" src={src} muted loop playsInline autoPlay disablePictureInPicture aria-hidden="true" />;
}

// ---- 跟着播放进度走的三块：各自订阅进度，每帧只重绘它们自己 ----

function LiveSeekBar({ duration }: { duration: number }) {
  const { position, seek, setPreview } = usePlayhead();
  return <SeekBar position={position} duration={duration} onPreview={setPreview} onSeek={seek} />;
}

function LiveLyrics(p: { lines: LyricLine[]; offset: number; duration: number; showTranslation: boolean; showRomaji: boolean }) {
  const { position, seek } = usePlayhead();
  const at = position + p.offset;
  const idx = findLineIndex(p.lines, at);
  return (
    <LyricScroller
      lines={p.lines}
      index={idx}
      progress={lineProgress(p.lines, idx, at, p.duration)}
      // 点歌词跳转时扣掉偏移，跳到的位置正好是这句开始
      onSeek={(t) => seek(Math.max(0, t - p.offset))}
      showTranslation={p.showTranslation}
      showRomaji={p.showRomaji}
    />
  );
}

type Lights3DProps = ComponentProps<typeof Lights3D>;
/**
 * 一层拾音灯。平时是原来的 2D 灯；打开 3D 换成画布，镜头从 2D 的样子转过去。
 * 关掉 3D 时画布先留着，等镜头转回 2D 的样子再换回原来的灯，所以开和关都是一次连续的转场。
 */
function LightLayer({ on3d, ...rest }: Omit<Lights3DProps, "onFlat">) {
  const [canvasOn, setCanvasOn] = useState(on3d);
  useEffect(() => {
    if (on3d) setCanvasOn(true);
  }, [on3d]);
  if (canvasOn) return <Lights3D {...rest} on3d={on3d} onFlat={() => setCanvasOn(false)} />;
  return (
    <div className="light-2d">
      <Lights palette={rest.palette} style={rest.style} playing={rest.playing} reactive={rest.reactive} thickness={rest.thickness} />
    </div>
  );
}

type VinylProps = ComponentProps<typeof VinylView>;
function LiveVinyl({
  lines,
  synced,
  offset,
  ...rest
}: Omit<VinylProps, "position" | "lyricText" | "onPreview" | "onSeek"> & { lines: LyricLine[]; synced: boolean; offset: number }) {
  const { position, seek, setPreview } = usePlayhead();
  const idx = synced ? findLineIndex(lines, position + offset) : -1;
  return <VinylView {...rest} position={position} lyricText={idx >= 0 ? lines[idx].text : rest.now?.title ?? ""} onPreview={setPreview} onSeek={seek} />;
}

export default function FullScreen() {
  const player = usePlayer();
  // 播放进度放在外面这一层，里面的整个界面只在换歌、改设置这些时候才重绘
  return (
    <PlayheadProvider now={player.now}>
      <FullScreenBody {...player} />
    </PlayheadProvider>
  );
}

function FullScreenBody({ now, artwork, desktopLocked }: ReturnType<typeof usePlayer>) {
  useLang(); // 切换语言时整页重绘
  const positionRef = usePositionRef();
  const track = now?.title ? trackKey(now) : "";
  // 这首歌单独的歌词设置：时间偏移、手动选的歌词版本
  const pref = useLyricPref(track);
  const lyrics = useLyrics(now, pref);
  const songOffset = pref.offset ?? 0;
  const palette = useAlbumPalette(artwork);
  const scale = useStageScale();
  const [settings, update] = useSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  // 实际用的偏移 = 这首歌自己的微调 + 设置里的整体延迟
  const offset = songOffset + (settings.lyricDelay ?? 0);
  useApplySettings(settings);
  const bgImage = useBackgroundImage();
  const bgVideo = useBackgroundVideo(settings.background === "video");
  const spotify = useSpotify(now);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [vinylMenuOpen, setVinylMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [winOpen, setWinOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const sleep = useSleepTimer(now);
  const fullscreen = useFullscreen();
  // 启动时桌面歌词默认不显示，点右上角按钮打开
  const [desktopVisible, setDesktopVisible] = useState(false);

  const lines = lyrics.lines;

  // 托盘或快捷键改了桌面歌词的显示状态，同步按钮
  useEffect(() => {
    const un = listen<boolean>("desktop-visible", (e) => {
      setDesktopVisible(e.payload);
      if (settingsRef.current.desktopOn !== e.payload) update({ desktopOn: e.payload });
    });
    // 上次关软件时桌面歌词开着：接着显示（位置后端会记住）
    if (settingsRef.current.desktopOn) invoke("set_desktop_visible", { visible: true }).catch(() => {});
    return () => void un.then((f) => f());
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // 关主窗口：第一次问一下留在托盘还是退出，之后照选的来
  const [closeAsk, setCloseAsk] = useState(false);
  useEffect(() => {
    const un = listen("main-close-requested", () => {
      const a = settingsRef.current.closeAction;
      if (a === "quit") void invoke("quit_app");
      else if (a === "tray") void getCurrentWindow().hide();
      else setCloseAsk(true);
    });
    return () => void un.then((f) => f());
  }, []);
  const closeWith = (a: "tray" | "quit") => {
    update({ closeAction: a });
    setCloseAsk(false);
    if (a === "quit") void invoke("quit_app");
    else void getCurrentWindow().hide();
  };
  // 全局快捷键：收藏要用这里的 Spotify 状态；切歌时记下方向给唱片动画用
  const spotifyRef = useRef(spotify);
  spotifyRef.current = spotify;
  useEffect(() => {
    const un = listen<string>("shortcut", (e) => {
      const sp = spotifyRef.current;
      if (e.payload === "like" && sp.account.loggedIn && !sp.account.needsReauth) void sp.toggleLike();
      else if (e.payload === "next") markDirection(1);
      else if (e.payload === "previous") markDirection(-1);
    });
    return () => void un.then((f) => f());
  }, []);
  // 灵动岛窗口用到时才创建，所以开关由主窗口来管：打开时让后端把窗口建出来
  useEffect(() => {
    invoke("island_set", { visible: settings.islandOn, locked: settings.islandLocked }).catch(() => {});
  }, [settings.islandOn, settings.islandLocked]);
  // 聊天模式窗口也是用到时才建：开关在设置里，由主窗口告诉后端
  useEffect(() => {
    invoke("chat_set", { visible: settings.chatWindowOn }).catch(() => {});
  }, [settings.chatWindowOn]);
  // 聊天窗口自己点了关闭（后端已经把它藏起来），或者托盘里点了显示 / 隐藏
  useEffect(() => {
    const a = listen("chat-closed", () => update({ chatWindowOn: false }));
    const b = listen("chat-toggle", () => update({ chatWindowOn: !settingsRef.current.chatWindowOn }));
    return () => {
      void a.then((f) => f());
      void b.then((f) => f());
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // 全局快捷键按设置里存的组合注册（后端启动时先用默认组合）
  const shortcutKey = JSON.stringify(settings.shortcuts);
  useEffect(() => {
    void applyShortcuts(shortcutsOf(settings.shortcuts));
  }, [shortcutKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // 托盘里点了"显示 / 隐藏灵动岛"
  useEffect(() => {
    const un = listen("island-toggle", () => update({ islandOn: !settingsRef.current.islandOn }));
    return () => void un.then((f) => f());
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // 启动时悄悄检查一次更新，有新版本就在设置按钮上点个小红点
  useEffect(() => {
    invoke<UpdateInfo>("check_update")
      .then((r) => setUpdateInfo(r))
      .catch(() => {});
  }, []);

  const setDesktop = (v: boolean) => {
    setDesktopVisible(v);
    invoke("set_desktop_visible", { visible: v });
  };
  const anyWindow = desktopVisible || settings.islandOn || settings.chatWindowOn;

  // 没连接 Spotify 时点爱心，直接打开设置去连接
  const onHeart = () =>
    spotify.account.loggedIn && !spotify.account.needsReauth ? spotify.toggleLike() : setSettingsOpen(true);
  const heartDisabled = spotify.account.loggedIn && !spotify.account.needsReauth && spotify.liked === null;

  // 曲库和专辑只在登录 Spotify 后出现（登录过期也留着，里面会提示重新连接）
  const libraryAvailable = spotify.account.loggedIn;
  const savedLibrary = settings.viewMode === "playlists" || settings.viewMode === "albums";
  // 退出登录时正停在曲库/专辑，就回到歌词。等后端报了真实状态再改，免得启动时把记住的视图冲掉
  const viewMode = savedLibrary && !libraryAvailable ? "lyrics" : settings.viewMode;
  useEffect(() => {
    if (spotify.ready && savedLibrary && !libraryAvailable) update({ viewMode: "lyrics" });
  }, [spotify.ready, savedLibrary, libraryAvailable]); // eslint-disable-line react-hooks/exhaustive-deps
  const vinyl = viewMode === "vinyl";
  const library = viewMode === "playlists" || viewMode === "albums";
  // 歌词界面显示什么：拾音灯关着时两样都显示（开关也锁住）
  const showLyrics = !settings.lightsOn || settings.showLyrics;
  const showAlbum = !settings.lightsOn || settings.showAlbum;
  const layout = showLyrics && showAlbum ? "both" : showAlbum ? "album" : showLyrics ? "lyrics" : "none";
  // 歌词 ⇄ 唱片：新旧两层同时淡入淡出，320ms 内完成
  const modeLayers = useCrossfade(viewMode, 320);
  // 灯效切换：旧灯效收起、新灯效展开
  // 关掉拾音灯也走同一套：旧灯效收起淡出，而不是直接消失
  const lightLayers = useCrossfade(settings.lightsOn ? settings.lightStyle : "off", 420);
  const modeSegRef = useRef<HTMLDivElement>(null);
  const lightSegRef = useRef<HTMLDivElement>(null);
  // 3 秒没动鼠标就收起上下栏，只留中间；开着面板或菜单时不收
  const tipWindows = !settings.tipWindowsSeen && !settingsOpen;
  const idle = useIdle(
    3000,
    settingsOpen || vinylMenuOpen || searchOpen || listOpen || moreOpen || winOpen || pickerOpen || shareOpen || closeAsk || tipWindows,
    // 鼠标停在这些按钮上时不收起来
    ".fs-top, .fs-bar, .lib-search-btn, .vinyl-edit",
  );
  const sleepFading = sleep.left !== null && sleep.left <= SLEEP_FADE_MS;
  // 上下栏收起再出现时也重新量一次滑块位置
  useSegThumb(modeSegRef, `${viewMode}|${idle}|${libraryAvailable}`);
  // 灯效选项可以拖动排序；顺序变了滑块也要重新定位
  const lightOrder = lightOrderOf(settings.lightOrder);
  useSegThumb(lightSegRef, `${settings.lightsOn ? settings.lightStyle : "off"}|${idle}|${lightOrder.join(",")}`);
  const reorder = useDragReorder(lightSegRef, lightOrder, (next) => update({ lightOrder: next }));
  const bg = settings.background;
  // 墨晕自带一整套配色：宣纸底、深色字，不用背景和颜色设置。只在歌词界面生效
  const ink = !vinyl && !library && settings.lightsOn && settings.lightStyle === "ink";
  // 底色：默认深紫、跟随专辑（封面颜色压暗）、自己挑的颜色，或者透明（不加底色）。每种背景各有一份。
  // 图片、视频、封面还没有时临时显示的是专辑流体，这时用专辑流体的底色（流体必须有底色）
  const fluidShown = bg === "fluid" || (bg === "image" && !bgImage) || (bg === "video" && !bgVideo) || (bg === "cover" && !artwork);
  const basePref = baseOf(settings, fluidShown ? "fluid" : bg);
  const clear = basePref.mode === "transparent" && !ink;
  const base = clear
    ? "transparent"
    : basePref.mode === "album"
      ? deepTone(palette)
      : basePref.mode === "custom"
        ? basePref.color
        : DEFAULT_BASE;
  // 3D 模式：只在歌词界面、拾音灯开着时生效
  const d3 = settings.light3d && settings.lightsOn && !vinyl && !library;
  // 有时间轴的歌词在 3D 里画进场景，界面上原来那一列收起来；没有时间轴的照旧显示
  const lyrics3d = d3 && showLyrics && lyrics.status === "ready" && lyrics.synced;
  // 唱过的字的颜色（和 --lyric-sung 一个算法）
  const c0 = /^#[0-9a-f]{6}$/i.test(palette[0] ?? "") ? palette[0] : "#FF9BB3";
  const sungHex = settings.lyricColorMode === "custom" && /^#[0-9a-f]{6}$/i.test(settings.lyricColor) ? settings.lyricColor : c0;
  const sungMix = settings.lyricColorMode === "custom" ? 0 : 0.45;
  const sung = [1, 3, 5].map((i) => Math.round(255 * sungMix + parseInt(sungHex.slice(i, i + 2), 16) * (1 - sungMix))) as [number, number, number];
  const showImage = bg === "image" && bgImage;
  const showCover = bg === "cover" && artwork;

  return (
    <div
      onDoubleClick={(e) => {
        // 只认背景、空白处的双击，按钮、歌词、唱片上的不算
        const el = e.target as HTMLElement;
        if (el.matches(".fs, .fs-stage, .mode-layer, .fs-dim, .fs-paper, .light-layer, .light-dim, .light-2d, canvas")) fullscreen.toggle();
      }}
      className={`fs${idle ? " is-idle" : ""}${settings.lightsOn && !ink && !vinyl && !library ? " has-lights" : ""}${sleepFading ? " is-sleeping" : ""}${ink ? " is-ink" : ""}${clear ? " is-clear" : ""}`} style={{ "--base": base } as CSSProperties}>
      {/* 背景层：铺满整个窗口 */}
      {(bg === "fluid" || (bg === "image" && !bgImage) || (bg === "video" && !bgVideo) || (bg === "cover" && !artwork)) && (
        <>
          <div className="fs-blob fs-blob--a" />
          <div className="fs-blob fs-blob--b" />
          <div className="fs-blob fs-blob--c" />
        </>
      )}
      {bg === "gradient" && <div className="fs-bg fs-bg--gradient" />}
      {showImage && <div className="fs-bg fs-bg--image" style={{ backgroundImage: `url(${bgImage})` }} />}
      {bg === "video" && bgVideo && <BackgroundVideo src={bgVideo} paused={ink} />}
      {showCover && <div className="fs-bg fs-bg--cover" style={{ backgroundImage: `url(${artwork!.dataUrl})` }} />}
      <div className="fs-dim" />
      <div className="fs-paper" aria-hidden="true" />

      <div className="fs-stage" style={{ transform: `scale(${scale})` }}>
        <header className="fs-top">
          <div ref={modeSegRef} className="seg seg--left glass" role="radiogroup" aria-label={t("显示方式")}>
            <span className="seg-thumb" aria-hidden="true" />
            {(
              [
                ["lyrics", t("歌词")],
                ["vinyl", t("唱片")],
                ["playlists", t("曲库")],
                ["albums", t("专辑")],
              ] as const
            )
              .filter(([id]) => libraryAvailable || (id !== "playlists" && id !== "albums"))
              .map(([id, name]) => (
              <button
                key={id}
                data-seg
                role="radio"
                aria-checked={viewMode === id}
                className={`${viewMode === id ? "is-on" : ""}${id === "playlists" || id === "albums" ? " seg-extra" : ""}`}
                onClick={() => {
                  update({ viewMode: id });
                  setVinylMenuOpen(false);
                  setSearchOpen(false);
                }}
              >
                {name}
              </button>
            ))}
          </div>
          {viewMode === "lyrics" && (
          <div className="seg seg--lights glass" role="group" aria-label={t("拾音灯")}>
            {/* 拾音灯：「关」和各种灯效放在同一组里，一次只能选一个 */}
            <div ref={lightSegRef} className="seg-group" role="radiogroup" aria-label={t("拾音灯效果")} onClickCapture={reorder.onClickCapture}>
              <span className="seg-thumb" aria-hidden="true" />
              <button data-seg role="radio" aria-checked={!settings.lightsOn} className={settings.lightsOn ? "" : "is-on"} onClick={() => update({ lightsOn: false })}>
                {t("关")}
              </button>
              {lightOrder.map((id) => {
                const on = settings.lightsOn && settings.lightStyle === id;
                return (
                  <button
                    key={id}
                    data-seg
                    data-reorder={id}
                    role="radio"
                    aria-checked={on}
                    className={on ? "is-on" : ""}
                    title={t("拖动可以调整顺序")}
                    onClick={() => update({ lightStyle: id, lightsOn: true })}
                    {...reorder.itemProps}
                  >
                    {t(STYLE_LABEL[id])}
                  </button>
                );
              })}
            </div>
            {/* 3D 模式：镜头转过去，灯、场景和歌词都变成立体的。灯关着时用不了，就不显示 */}
            {settings.lightsOn && (
              <>
                <span className="seg-sep" aria-hidden="true" />
                <button
                  className={`seg-3d${settings.light3d ? " is-on" : ""}`}
                  role="switch"
                  aria-checked={settings.light3d}
                  aria-label={t(settings.light3d ? "关闭 3D 模式" : "打开 3D 模式")}
                  title={t(settings.light3d ? "关闭 3D 模式" : "打开 3D 模式")}
                  onClick={() => update({ light3d: !settings.light3d })}
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 2.8 20 7.4v9.2L12 21.2 4 16.6V7.4z" />
                    <path d="M4 7.4 12 12l8-4.6M12 12v9.2" />
                  </svg>
                  <span>3D</span>
                </button>
              </>
            )}
          </div>
          )}
          <div className="pill glass">
            <button
              className={`ibtn win-btn${anyWindow ? " has-dot-on" : ""}`}
              aria-label={t("小窗口")}
              title={t("桌面歌词、灵动岛、聊天模式")}
              aria-expanded={winOpen}
              aria-pressed={winOpen}
              onClick={() => {
                setWinOpen((v) => !v);
                setMoreOpen(false);
                if (!settings.tipWindowsSeen) update({ tipWindowsSeen: true });
              }}
            >
              <WindowsIcon />
            </button>
            <button
              className={`ibtn more-btn${sleep.mode !== "off" ? " has-badge" : ""}`}
              aria-label={t("更多")}
              aria-expanded={moreOpen}
              aria-pressed={moreOpen}
              title={sleep.mode !== "off" ? sleepLabel(sleep.mode, sleep.left) : t("更多")}
              onClick={() => {
                setMoreOpen((v) => !v);
                setWinOpen(false);
              }}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <circle cx="5.5" cy="12" r="1.7" />
                <circle cx="12" cy="12" r="1.7" />
                <circle cx="18.5" cy="12" r="1.7" />
              </svg>
            </button>
            <button
              className={`ibtn${updateInfo?.hasUpdate || (spotify.account.loggedIn && spotify.account.needsReauth) ? " has-dot" : ""}`}
              aria-label={updateInfo?.hasUpdate ? t("设置（有新版本）") : spotify.account.loggedIn && spotify.account.needsReauth ? t("设置（Spotify 需要重新连接）") : t("设置")}
              onClick={() => setSettingsOpen(true)}
            >
              <GearIcon />
            </button>
          </div>
        </header>

        {modeLayers.map(({ key, leaving }) => (
          <div key={key} className={`mode-layer${leaving ? " is-leaving" : " is-entering"}`} aria-hidden={leaving || undefined}>
            {key === "playlists" || key === "albums" ? (
              <LibraryView
                kind={key === "albums" ? "album" : "playlist"}
                loggedIn={spotify.account.loggedIn}
                needsReauth={spotify.account.needsReauth}
                loginBusy={spotify.busy}
                onLogin={spotify.login}
                searchOpen={searchOpen && !leaving}
                onOpenSearch={() => setSearchOpen(true)}
                onCloseSearch={() => setSearchOpen(false)}
              />
            ) : key === "vinyl" ? (
            <LiveVinyl
              now={now}
              artworkUrl={artwork?.dataUrl ?? null}
              palette={palette}
              settings={settings}
              update={update}
              lines={lines}
              synced={lyrics.synced}
              offset={offset}
              menuOpen={vinylMenuOpen}
              onToggleMenu={() => setVinylMenuOpen((v) => !v)}
              onCloseMenu={() => setVinylMenuOpen(false)}
            />
            ) : (
              <>
                {lightLayers
                  .filter((l) => l.key !== "off")
                  .map((l) => (
                    <div key={l.key} className={`light-layer${l.leaving ? " is-leaving" : " is-entering"}`}>
                      <div className="light-dim">
                        <LightLayer
                          style={l.key as LightStyle}
                          palette={lightPalette(settings, palette)}
                          base={clear ? DEFAULT_BASE : base}
                          alpha={0.25 + (settings.lightBrightness / 100) * 0.75}
                          thickness={thickScale(settings.lightThickness ?? 50)}
                          playing={!!now?.playing}
                          reactive={settings.beat}
                          on3d={d3}
                          lines={lyrics3d ? lines : null}
                          offset={offset}
                          duration={now?.durationMs ?? 0}
                          lyricScale={lyricScale(settings.lyricSize)}
                          sung={sung}
                          cover={artwork?.dataUrl ?? null}
                        />
                      </div>
                    </div>
                  ))}
                {/* 3D 时：墨晕把专辑缩小挪到左上的天空里，另外三种灯效把专辑收起来 */}
                <section
                  className={`fs-track${showAlbum && !(d3 && !ink) ? "" : " is-hidden"}${layout === "album" ? " is-solo" : d3 && ink ? " is-ink3d" : ""}`}
                  aria-hidden={!showAlbum || (d3 && !ink) || undefined}
                >
                  {artwork ? (
                    // 墨晕里封面过一遍水墨滤镜
                    ink ? (
                      <InkCover key={artwork.dataUrl.length + (now?.title ?? "")} className="cover cover--ink cover-in" src={artwork.dataUrl} />
                    ) : (
                      <img key={artwork.dataUrl.length + (now?.title ?? "")} className="cover cover-in" src={artwork.dataUrl} alt="" />
                    )
                  ) : (
                    <div className="cover cover--empty" />
                  )}
                  <FitText key={now?.title ?? ""} className="title text-in" fitKey={now?.title ?? ""} minScale={0.7} wrap={false}>
                    {now?.title || t("没有在播放")}
                  </FitText>
                  <p className="artist">{now?.artist || t("在 Spotify 或其他播放器里放一首歌")}</p>
                  {now?.album && <p className="album">{now.album}</p>}
                  {lyrics.status === "ready" && (
                    <p className="lyric-src">
                      {t("歌词来自{src}", { src: tMsg(lyrics.source) })}
                      {lyrics.wordSync ? t("，逐字同步") : lyrics.synced ? "" : t("，没有时间轴")}
                    </p>
                  )}
                </section>

                <section className={`fs-lyrics${showLyrics && !lyrics3d ? "" : " is-hidden"}${layout === "lyrics" ? " is-solo" : ""}`} aria-live="polite" aria-hidden={!showLyrics || undefined}>
                  {lyrics.status === "loading" && <p className="hint">{t("正在找歌词…")}</p>}
                  {(lyrics.status === "none" || lyrics.status === "error") && now && (
                    <div className="hint">
                      <p>{lyrics.status === "error" ? t("歌词加载失败，检查一下网络") : lyrics.instrumental ? t("纯音乐，没有歌词") : t("没找到这首歌的歌词")}</p>
                      {lyrics.status === "none" && !lyrics.instrumental && (
                        <button className="hint-btn glass" onClick={() => setPickerOpen(true)}>
                          {t("手动搜索歌词")}
                        </button>
                      )}
                    </div>
                  )}
                  {lyrics.status === "ready" && !lyrics.synced && (
                    <div className="plain">{lines.map((l, i) => <p key={i}>{l.text}</p>)}</div>
                  )}
                  {lyrics.status === "ready" && lyrics.synced && <LiveLyrics lines={lines} offset={offset} duration={now?.durationMs ?? 0} showTranslation={settings.showTranslation} showRomaji={settings.showRomaji} />}
                </section>
              </>
            )}
          </div>
        ))}

        <Presence show={!!spotify.message}>
          {spotify.message && (
            <div className={`toast glass${spotify.message.kind === "error" ? " toast--error" : ""}`} role="status">
              {spotify.message.text}
            </div>
          )}
        </Presence>

        {/* 第一次打开时指一下小窗口按钮在哪 */}
        <Presence show={tipWindows && !winOpen}>
          <div className="tip-bubble glass glass--thick" role="note">
            <p>{t("桌面歌词、灵动岛和聊天模式在这里打开")}</p>
            <button onClick={() => update({ tipWindowsSeen: true })}>{t("知道了")}</button>
          </div>
        </Presence>

        <Presence show={winOpen}>
          <WindowsMenu
            onClose={() => setWinOpen(false)}
            desktop={desktopVisible}
            onDesktop={setDesktop}
            locked={desktopLocked}
            onLocked={(v) => invoke("set_desktop_locked", { locked: v })}
            island={settings.islandOn}
            onIsland={(v) => update({ islandOn: v })}
            chat={settings.chatWindowOn}
            onChat={(v) => update({ chatWindowOn: v })}
          />
        </Presence>

        <Presence show={moreOpen}>
          <MoreMenu
            onClose={() => setMoreOpen(false)}
            offset={songOffset}
            canAdjust={!!track && lyrics.status === "ready" && lyrics.synced}
            onOffset={(ms) => setLyricPref(track, { offset: Math.max(-10000, Math.min(10000, Math.round(ms / 100) * 100)) })}
            canPickLyrics={!!now?.title}
            onPickLyrics={() => {
              setMoreOpen(false);
              setPickerOpen(true);
            }}
            canShare={lyrics.status === "ready" && lines.some((l) => l.text.trim())}
            onShare={() => {
              setMoreOpen(false);
              setShareOpen(true);
            }}
            sleep={sleep.mode}
            sleepLeft={sleepLabel(sleep.mode, sleep.left)}
            onSleep={sleep.start}
            view={
              viewMode === "lyrics" && settings.lightsOn
                ? {
                    showLyrics: settings.showLyrics,
                    showAlbum: settings.showAlbum,
                    onLyrics: (v) => update({ showLyrics: v }),
                    onAlbum: (v) => update({ showAlbum: v }),
                  }
                : null
            }
            fullscreen={fullscreen.full}
            onFullscreen={() => {
              setMoreOpen(false);
              fullscreen.toggle();
            }}
          />
        </Presence>

        <Presence show={listOpen}>
        <NowListPanel
          open
          onClose={() => setListOpen(false)}
          loggedIn={spotify.account.loggedIn}
          needsReauth={spotify.account.needsReauth}
          onLogin={spotify.login}
          trackKey={now ? `${now.title}|${now.artist}` : ""}
          currentTitle={now?.title ?? ""}
        />
        </Presence>

        <footer className="fs-bar glass">
          <div className="controls">
            <button
              className="ibtn"
              aria-label={t("上一首")}
              onClick={() => {
                markDirection(-1);
                mediaControl("previous");
              }}
            >
              <PrevIcon />
            </button>
            <button className="play" aria-label={now?.playing ? t("暂停") : t("播放")} onClick={() => mediaControl("toggle")}>
              {now?.playing ? <PauseIcon size={26} /> : <PlayIcon size={26} />}
            </button>
            <button
              className="ibtn"
              aria-label={t("下一首")}
              onClick={() => {
                markDirection(1);
                mediaControl("next");
              }}
            >
              <NextIcon />
            </button>
          </div>
          <LiveSeekBar duration={now?.durationMs ?? 0} />
          {/* 不是在 Spotify 播放时收藏用不了，就不显示（没连接时点它去连接） */}
          {!heartDisabled && (
            <button
              className={`ibtn heart${spotify.liked ? " is-liked" : ""}`}
              aria-label={!spotify.account.loggedIn ? t("连接 Spotify 后可收藏") : spotify.liked ? t("从 Spotify 收藏中移除") : t("收藏到 Spotify")}
              aria-pressed={!!spotify.liked}
              onClick={onHeart}
            >
              <HeartIcon filled={!!spotify.liked} />
            </button>
          )}
          <button
            className={`ibtn list-btn${listOpen ? " is-on" : ""}`}
            aria-label={listOpen ? t("关闭播放列表") : t("播放列表")}
            title={t("播放列表")}
            aria-pressed={listOpen}
            aria-expanded={listOpen}
            onClick={() => setListOpen((v) => !v)}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 6h11M4 11h11M4 16h7" />
              <path d="M18 9v8.5" />
              <circle cx="16" cy="17.5" r="2" />
              <path d="M18 9l3-1" />
            </svg>
          </button>
        </footer>

        <KeyControls
          enabled={!settingsOpen && !pickerOpen && !shareOpen}
          lines={lyrics.synced ? lines : null}
          offset={offset}
          duration={now?.durationMs ?? 0}
          onFullscreen={fullscreen.toggle}
        />

        <Presence show={settingsOpen} ms={260}>
          <SettingsPanel
            updateInfo={updateInfo}
            settings={settings}
            update={update}
            palette={palette}
            artworkUrl={artwork?.dataUrl ?? null}
            bgImage={bgImage}
            account={spotify.account}
            accountBusy={spotify.busy}
            onLogin={spotify.login}
            onLogout={spotify.logout}
            onClose={() => setSettingsOpen(false)}
          />
        </Presence>

        <Presence show={closeAsk} ms={260}>
          <Sheet title={t("关掉窗口后")} onClose={() => setCloseAsk(false)}>
            <div className="close-ask">
              <p>{t("ingfy 可以留在托盘里，继续显示桌面歌词和灵动岛。想退出时，右键托盘图标选「退出 ingfy」。")}</p>
              <div className="close-ask-btns">
                <button className="st-btn" onClick={() => closeWith("quit")}>
                  {t("直接退出")}
                </button>
                <button className="st-btn st-btn--primary" onClick={() => closeWith("tray")}>
                  {t("留在托盘")}
                </button>
              </div>
              <small>{t("以后可以在设置的「通用」里改")}</small>
            </div>
          </Sheet>
        </Presence>

        <Presence show={pickerOpen && !!now} ms={260}>
          {now && (
          <LyricPicker
            now={now}
            current={pref}
            onPick={(c) => {
              setLyricPref(track, c ? { source: c.source, id: c.id } : { source: undefined, id: undefined });
              setPickerOpen(false);
            }}
            onClose={() => setPickerOpen(false)}
          />
          )}
        </Presence>
        <Presence show={shareOpen && !!now} ms={260}>
          {now && (
          <ShareSheet
            now={now}
            lines={lines}
            // 打开分享的那一刻唱到哪一句
            index={lyrics.synced ? findLineIndex(lines, positionRef.current + offset) : -1}
            artworkUrl={artwork?.dataUrl ?? null}
            palette={palette}
            onClose={() => setShareOpen(false)}
          />
          )}
        </Presence>
      </div>
    </div>
  );
}

function WindowsIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="13" height="10" rx="2.5" />
      <rect x="11" y="10" width="10" height="10" rx="2.5" fill="currentColor" fillOpacity="0.18" />
    </svg>
  );
}

/**
 * 主窗口的键盘操作：空格播放 / 暂停，← → 快退快进 5 秒，↑ ↓ 跳到上一句 / 下一句歌词，F11 全屏。
 * 输入框里、或者焦点在按钮滑块上时交给它们自己处理。开着设置、换歌词、分享这些面板时不管。
 */
function KeyControls(p: { enabled: boolean; lines: LyricLine[] | null; offset: number; duration: number; onFullscreen: () => void }) {
  const playhead = usePlayhead();
  const latest = useRef({ ...p, playhead });
  latest.current = { ...p, playhead };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { enabled, lines, offset, duration, onFullscreen, playhead: ph } = latest.current;
      if (e.key === "F11") {
        e.preventDefault();
        onFullscreen();
        return;
      }
      if (!enabled || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || e.repeat && e.key === " ") return;
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [contenteditable='true'], [role='slider'], [role='dialog']")) return;
      if (e.key === " ") {
        if (el.closest("button, [role='button'], [role='switch'], [role='radio']")) return;
        e.preventDefault();
        mediaControl("toggle");
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        if (duration <= 0 || el.closest("[role='radiogroup']")) return;
        e.preventDefault();
        ph.seek(Math.max(0, Math.min(duration, ph.position + (e.key === "ArrowRight" ? 5000 : -5000))));
      } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && lines?.length) {
        e.preventDefault();
        const idx = findLineIndex(lines, ph.position + offset);
        const next = Math.max(0, Math.min(lines.length - 1, idx + (e.key === "ArrowDown" ? 1 : -1)));
        ph.seek(Math.max(0, lines[next].time - offset));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return null;
}
