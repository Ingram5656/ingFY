import { useEffect, useRef, useState, type ComponentProps } from "react";
import { useCrossfade, useDragReorder, useIdle, useSegThumb } from "../lib/motion";
import { LibraryView } from "../components/Shelf";
import { NowListPanel } from "../components/NowList";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Lights, type LightStyle } from "../components/Lights";
import { FitText } from "../components/FitText";
import { LyricScroller } from "../components/LyricScroller";
import { SeekBar } from "../components/SeekBar";
import { SettingsPanel } from "../components/SettingsPanel";
import { VinylView } from "../components/Vinyl";
import { markDirection } from "../lib/vinyl";
import { DesktopLyricsIcon, GearIcon, HeartIcon, LockIcon, NextIcon, PauseIcon, PlayIcon, PrevIcon } from "../components/Icons";
import { findLineIndex, lineProgress } from "../lib/lrc";
import { mediaControl, useAlbumPalette, useLyrics, usePlayer } from "../lib/player";
import { PlayheadProvider, usePlayhead, usePositionRef } from "../lib/playhead";
import type { LyricLine } from "../lib/types";
import { applyShortcuts, shortcutsOf } from "../lib/shortcuts";
import { lightOrderOf, lightPalette, loadBackgroundImage, thickScale, useApplySettings, useSettings } from "../lib/settings";
import { useSpotify } from "../lib/spotify";
import { setLyricPref, useLyricPref } from "../lib/lyricPrefs";
import { trackKey } from "../lib/types";
import { SLEEP_FADE_MS, sleepLabel, useSleepTimer } from "../lib/sleep";
import { MoreMenu } from "../components/MoreMenu";
import { Presence } from "../components/Presence";
import { LyricPicker } from "../components/LyricPicker";
import { ShareSheet } from "../components/ShareSheet";
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

// ---- 跟着播放进度走的三块：各自订阅进度，每帧只重绘它们自己 ----

function LiveSeekBar({ duration }: { duration: number }) {
  const { position, seek, setPreview } = usePlayhead();
  return <SeekBar position={position} duration={duration} onPreview={setPreview} onSeek={seek} />;
}

function LiveLyrics(p: { lines: LyricLine[]; offset: number; duration: number; showTranslation: boolean }) {
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
    />
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
  const offset = pref.offset ?? 0;
  const palette = useAlbumPalette(artwork);
  const scale = useStageScale();
  const [settings, update] = useSettings();
  useApplySettings(settings);
  const bgImage = useBackgroundImage();
  const spotify = useSpotify(now);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [vinylMenuOpen, setVinylMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
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
    const un = listen<boolean>("desktop-visible", (e) => setDesktopVisible(e.payload));
    return () => void un.then((f) => f());
  }, []);
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
  // 全局快捷键按设置里存的组合注册（后端启动时先用默认组合）
  const shortcutKey = JSON.stringify(settings.shortcuts);
  useEffect(() => {
    void applyShortcuts(shortcutsOf(settings.shortcuts));
  }, [shortcutKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // 托盘里点了"显示 / 隐藏灵动岛"
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
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

  const toggleDesktop = () => {
    const v = !desktopVisible;
    setDesktopVisible(v);
    invoke("set_desktop_visible", { visible: v });
  };

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
  const idle = useIdle(3000, settingsOpen || vinylMenuOpen || searchOpen || listOpen || moreOpen || pickerOpen || shareOpen);
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
  const showImage = bg === "image" && bgImage;
  const showCover = bg === "cover" && artwork;

  return (
    <div className={`fs${idle ? " is-idle" : ""}${sleepFading ? " is-sleeping" : ""}${ink ? " is-ink" : ""}`}>
      {/* 背景层：铺满整个窗口 */}
      {(bg === "fluid" || (bg === "image" && !bgImage) || (bg === "cover" && !artwork)) && (
        <>
          <div className="fs-blob fs-blob--a" />
          <div className="fs-blob fs-blob--b" />
          <div className="fs-blob fs-blob--c" />
        </>
      )}
      {bg === "gradient" && <div className="fs-bg fs-bg--gradient" />}
      {showImage && <div className="fs-bg fs-bg--image" style={{ backgroundImage: `url(${bgImage})` }} />}
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
          <div className={`seg seg--lights glass${settings.lightsOn ? "" : " is-off"}`} role="group" aria-label={t("拾音灯")}>
            {/* 拾音灯总开关，和灯效切换共用一条工具栏 */}
            <button
              className="seg-toggle"
              role="switch"
              aria-checked={settings.lightsOn}
              aria-label={settings.lightsOn ? t("关闭拾音灯") : t("打开拾音灯")}
              title={settings.lightsOn ? t("关闭拾音灯") : t("打开拾音灯")}
              onClick={() => update({ lightsOn: !settings.lightsOn })}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M6 18V9M10 18V5M14 18v-7M18 18V8" />
                {!settings.lightsOn && <path d="M4 4l16 16" />}
              </svg>
            </button>
            <span className="seg-sep" aria-hidden="true" />
            <div ref={lightSegRef} className="seg-group" role="radiogroup" aria-label={t("拾音灯效果")} onClickCapture={reorder.onClickCapture}>
              <span className="seg-thumb" aria-hidden="true" />
              {lightOrder.map((id) => (
                <button
                  key={id}
                  data-seg
                  data-reorder={id}
                  role="radio"
                  aria-checked={settings.lightStyle === id}
                  className={settings.lightStyle === id ? "is-on" : ""}
                  title={t("拖动可以调整顺序")}
                  onClick={() => update({ lightStyle: id, lightsOn: true })}
                  {...reorder.itemProps}
                >
                  {t(STYLE_LABEL[id])}
                </button>
              ))}
            </div>
            <span className="seg-sep" aria-hidden="true" />
            {/* 歌词、专辑信息的显示开关。拾音灯关着时不能关（不然画面就空了），强制都显示 */}
            <div className="seg-vis" role="group" aria-label={t("显示内容")}>
              {(
                [
                  ["showLyrics", t("歌词"), <LyricsGlyph key="l" />],
                  ["showAlbum", t("专辑信息"), <AlbumGlyph key="a" />],
                ] as const
              ).map(([k, label, icon]) => {
                const on = !settings.lightsOn || settings[k];
                return (
                  <button
                    key={k}
                    className={`seg-vis-btn${on ? " is-on" : ""}`}
                    role="switch"
                    aria-checked={on}
                    aria-disabled={!settings.lightsOn}
                    aria-label={t(on ? "隐藏{x}" : "显示{x}", { x: t(label) })}
                    title={settings.lightsOn ? t(on ? "隐藏{x}" : "显示{x}", { x: t(label) }) : t("打开拾音灯后才能隐藏{x}", { x: t(label) })}
                    onClick={() => settings.lightsOn && update({ [k]: !settings[k] } as Partial<typeof settings>)}
                  >
                    {icon}
                  </button>
                );
              })}
            </div>
          </div>
          )}
          <div className="pill glass">
            {library && (
              <button
                className="ibtn"
                aria-label={searchOpen ? t("关闭搜索") : t("搜索")}
                aria-pressed={searchOpen}
                onClick={() => setSearchOpen((v) => !v)}
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
                  <circle cx="11" cy="11" r="7" />
                  <path d="M20 20l-3.5-3.5" />
                </svg>
              </button>
            )}
            {vinyl && (
              <button
                className="ibtn"
                aria-label={t("自定义唱片")}
                aria-expanded={vinylMenuOpen}
                aria-pressed={vinylMenuOpen}
                onClick={() => setVinylMenuOpen((v) => !v)}
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" />
                  <circle cx="12" cy="12" r="3" />
                  <path d="M12 3a9 9 0 0 1 8.5 6" />
                </svg>
              </button>
            )}
            <button className="ibtn" aria-label={desktopVisible ? t("隐藏桌面歌词") : t("显示桌面歌词")} aria-pressed={desktopVisible} onClick={toggleDesktop}>
              <DesktopLyricsIcon />
            </button>
            <button
              className="ibtn"
              aria-label={desktopLocked ? t("解锁桌面歌词") : t("锁定桌面歌词")}
              aria-pressed={desktopLocked}
              onClick={() => invoke("set_desktop_locked", { locked: !desktopLocked })}
            >
              <LockIcon open={!desktopLocked} />
            </button>
            <button
              className={`ibtn more-btn${sleep.mode !== "off" ? " has-badge" : ""}`}
              aria-label={t("更多")}
              aria-expanded={moreOpen}
              aria-pressed={moreOpen}
              title={sleep.mode !== "off" ? sleepLabel(sleep.mode, sleep.left) : t("更多")}
              onClick={() => setMoreOpen((v) => !v)}
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
              onCloseMenu={() => setVinylMenuOpen(false)}
            />
            ) : (
              <>
                {lightLayers
                  .filter((l) => l.key !== "off")
                  .map((l) => (
                    <div key={l.key} className={`light-layer${l.leaving ? " is-leaving" : " is-entering"}`}>
                      <div className="light-dim">
                        <Lights palette={lightPalette(settings, palette)} style={l.key as LightStyle} playing={!!now?.playing} reactive={settings.beat} thickness={thickScale(settings.lightThickness ?? 50)} />
                      </div>
                    </div>
                  ))}
                <section className={`fs-track${showAlbum ? "" : " is-hidden"}${layout === "album" ? " is-solo" : ""}`} aria-hidden={!showAlbum || undefined}>
                  {artwork ? <img key={artwork.dataUrl.length + (now?.title ?? "")} className="cover cover-in" src={artwork.dataUrl} alt="" /> : <div className="cover cover--empty" />}
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

                <section className={`fs-lyrics${showLyrics ? "" : " is-hidden"}${layout === "lyrics" ? " is-solo" : ""}`} aria-live="polite" aria-hidden={!showLyrics || undefined}>
                  {lyrics.status === "loading" && <p className="hint">{t("正在找歌词…")}</p>}
                  {(lyrics.status === "none" || lyrics.status === "error") && now && (
                    <p className="hint">{lyrics.status === "error" ? t("歌词加载失败，检查一下网络") : lyrics.instrumental ? t("纯音乐，没有歌词") : t("没找到这首歌的歌词")}</p>
                  )}
                  {lyrics.status === "ready" && !lyrics.synced && (
                    <div className="plain">{lines.map((l, i) => <p key={i}>{l.text}</p>)}</div>
                  )}
                  {lyrics.status === "ready" && lyrics.synced && <LiveLyrics lines={lines} offset={offset} duration={now?.durationMs ?? 0} showTranslation={settings.showTranslation} />}
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

        <Presence show={moreOpen}>
          <MoreMenu
            onClose={() => setMoreOpen(false)}
            offset={offset}
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
          />
        </Presence>

        {/* 右下角：播放列表（正在播放的专辑 / 歌单里的所有歌） */}
        <button
          className={`fs-list glass${listOpen ? " is-on" : ""}`}
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

        {/* 左下角：全屏（无边框铺满屏幕），Esc 退出 */}
        <button
          className="fs-full glass"
          aria-label={fullscreen.full ? t("退出全屏") : t("全屏")}
          title={fullscreen.full ? t("退出全屏（Esc）") : t("全屏")}
          aria-pressed={fullscreen.full}
          onClick={fullscreen.toggle}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {fullscreen.full ? (
              <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
            ) : (
              <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
            )}
          </svg>
        </button>

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
          <button
            className={`ibtn heart${spotify.liked ? " is-liked" : ""}`}
            aria-label={!spotify.account.loggedIn ? t("连接 Spotify 后可收藏") : spotify.liked ? t("从 Spotify 收藏中移除") : t("收藏到 Spotify")}
            aria-pressed={!!spotify.liked}
            disabled={heartDisabled}
            title={heartDisabled ? t("当前不是在 Spotify 播放") : undefined}
            onClick={onHeart}
          >
            <HeartIcon filled={!!spotify.liked} />
          </button>
        </footer>

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

function LyricsGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
      <path d="M4 6.5h16M4 12h11M4 17.5h14" />
    </svg>
  );
}

function AlbumGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="12" cy="12" r="0.8" fill="currentColor" />
    </svg>
  );
}
