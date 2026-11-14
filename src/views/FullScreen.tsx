import { useEffect, useRef, useState } from "react";
import { useCrossfade, useIdle, useSegThumb } from "../lib/motion";
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
import { mediaControl, useAlbumPalette, useLyrics, usePlayer, usePosition, useSeek } from "../lib/player";
import { lightPalette, loadBackgroundImage, useApplySettings, useSettings } from "../lib/settings";
import { useSpotify } from "../lib/spotify";

const STYLES: { id: LightStyle; label: string }[] = [
  { id: "tube", label: "灯管" },
  { id: "hist", label: "直方图" },
  { id: "ring", label: "圆环" },
  { id: "wave", label: "声波" },
];

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

export default function FullScreen() {
  const { now, artwork, desktopLocked } = usePlayer();
  const rawPosition = usePosition(now);
  const { position, seek, setPreview } = useSeek(now, rawPosition);
  const lyrics = useLyrics(now);
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
  const fullscreen = useFullscreen();
  // 启动时桌面歌词默认不显示，点右上角按钮打开
  const [desktopVisible, setDesktopVisible] = useState(false);

  const lines = lyrics.lines;
  const idx = lyrics.synced ? findLineIndex(lines, position) : -1;
  const progress = lyrics.synced ? lineProgress(lines, idx, position, now?.durationMs ?? 0) : 0;

  const toggleDesktop = () => {
    const v = !desktopVisible;
    setDesktopVisible(v);
    invoke("set_desktop_visible", { visible: v });
  };

  // 没连接 Spotify 时点爱心，直接打开设置去连接
  const onHeart = () =>
    spotify.account.loggedIn && !spotify.account.needsReauth ? spotify.toggleLike() : setSettingsOpen(true);
  const heartDisabled = spotify.account.loggedIn && !spotify.account.needsReauth && spotify.liked === null;

  const vinyl = settings.viewMode === "vinyl";
  const library = settings.viewMode === "playlists" || settings.viewMode === "albums";
  // 歌词 ⇄ 唱片：新旧两层同时淡入淡出，320ms 内完成
  const modeLayers = useCrossfade(settings.viewMode, 320);
  // 灯效切换：旧灯效收起、新灯效展开
  const lightLayers = useCrossfade(settings.lightStyle, 420);
  const modeSegRef = useRef<HTMLDivElement>(null);
  const lightSegRef = useRef<HTMLDivElement>(null);
  // 3 秒没动鼠标就收起上下栏，只留中间；开着面板或菜单时不收
  const idle = useIdle(3000, settingsOpen || vinylMenuOpen || searchOpen || listOpen);
  // 上下栏收起再出现时也重新量一次滑块位置
  useSegThumb(modeSegRef, `${settings.viewMode}|${idle}`);
  useSegThumb(lightSegRef, `${settings.lightsOn ? settings.lightStyle : "off"}|${idle}`);
  const bg = settings.background;
  const showImage = bg === "image" && bgImage;
  const showCover = bg === "cover" && artwork;

  return (
    <div className={`fs${idle ? " is-idle" : ""}`}>
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

      <div className="fs-stage" style={{ transform: `scale(${scale})` }}>
        <header className="fs-top">
          <div ref={modeSegRef} className="seg seg--left glass" role="radiogroup" aria-label="显示方式">
            <span className="seg-thumb" aria-hidden="true" />
            {(
              [
                ["lyrics", "歌词"],
                ["vinyl", "唱片"],
                ["playlists", "曲库"],
                ["albums", "专辑"],
              ] as const
            ).map(([id, name]) => (
              <button
                key={id}
                data-seg
                role="radio"
                aria-checked={settings.viewMode === id}
                className={settings.viewMode === id ? "is-on" : ""}
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
          {settings.viewMode === "lyrics" && (
          <div className={`seg seg--lights glass${settings.lightsOn ? "" : " is-off"}`} role="group" aria-label="拾音灯">
            {/* 拾音灯总开关，和灯效切换共用一条工具栏 */}
            <button
              className="seg-toggle"
              role="switch"
              aria-checked={settings.lightsOn}
              aria-label={settings.lightsOn ? "关闭拾音灯" : "打开拾音灯"}
              title={settings.lightsOn ? "关闭拾音灯" : "打开拾音灯"}
              onClick={() => update({ lightsOn: !settings.lightsOn })}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M6 18V9M10 18V5M14 18v-7M18 18V8" />
                {!settings.lightsOn && <path d="M4 4l16 16" />}
              </svg>
            </button>
            <span className="seg-sep" aria-hidden="true" />
            <div ref={lightSegRef} className="seg-group" role="radiogroup" aria-label="拾音灯效果">
              <span className="seg-thumb" aria-hidden="true" />
              {STYLES.map((s) => (
                <button
                  key={s.id}
                  data-seg
                  role="radio"
                  aria-checked={settings.lightStyle === s.id}
                  className={settings.lightStyle === s.id ? "is-on" : ""}
                  onClick={() => update({ lightStyle: s.id, lightsOn: true })}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          )}
          <div className="pill glass">
            {library && (
              <button
                className="ibtn"
                aria-label={searchOpen ? "关闭搜索" : "搜索"}
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
                aria-label="自定义唱片"
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
            <button className="ibtn" aria-label={desktopVisible ? "隐藏桌面歌词" : "显示桌面歌词"} aria-pressed={desktopVisible} onClick={toggleDesktop}>
              <DesktopLyricsIcon />
            </button>
            <button
              className="ibtn"
              aria-label={desktopLocked ? "解锁桌面歌词" : "锁定桌面歌词"}
              aria-pressed={desktopLocked}
              onClick={() => invoke("set_desktop_locked", { locked: !desktopLocked })}
            >
              <LockIcon open={!desktopLocked} />
            </button>
            <button className="ibtn" aria-label="设置" onClick={() => setSettingsOpen(true)}>
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
            <VinylView
              now={now}
              position={position}
              artworkUrl={artwork?.dataUrl ?? null}
              palette={palette}
              settings={settings}
              update={update}
              lyricText={lyrics.synced && idx >= 0 ? lines[idx].text : now?.title ?? ""}
              menuOpen={vinylMenuOpen}
              onCloseMenu={() => setVinylMenuOpen(false)}
              onPreview={setPreview}
              onSeek={seek}
            />
            ) : (
              <>
                {settings.lightsOn &&
                  lightLayers.map((l) => (
                    <div key={l.key} className={`light-layer${l.leaving ? " is-leaving" : " is-entering"}`}>
                      <Lights palette={lightPalette(settings, palette)} style={l.key} playing={!!now?.playing} reactive={settings.beat} />
                    </div>
                  ))}
                <section className="fs-track">
                  {artwork ? <img className="cover" src={artwork.dataUrl} alt="" /> : <div className="cover cover--empty" />}
                  <FitText className="title" fitKey={now?.title ?? ""} minScale={0.7} wrap={false}>
                    {now?.title || "没有在播放"}
                  </FitText>
                  <p className="artist">{now?.artist || "在 Spotify 或其他播放器里放一首歌"}</p>
                  {now?.album && <p className="album">{now.album}</p>}
                  {lyrics.status === "ready" && (
                    <p className="lyric-src">
                      歌词来自{lyrics.source}
                      {lyrics.wordSync ? "，逐字同步" : lyrics.synced ? "" : "，没有时间轴"}
                    </p>
                  )}
                </section>

                <section className="fs-lyrics" aria-live="polite">
                  {lyrics.status === "loading" && <p className="hint">正在找歌词…</p>}
                  {(lyrics.status === "none" || lyrics.status === "error") && now && (
                    <p className="hint">{lyrics.status === "error" ? "歌词加载失败，检查一下网络" : lyrics.instrumental ? "纯音乐，没有歌词" : "没找到这首歌的歌词"}</p>
                  )}
                  {lyrics.status === "ready" && !lyrics.synced && (
                    <div className="plain">{lines.map((l, i) => <p key={i}>{l.text}</p>)}</div>
                  )}
                  {lyrics.status === "ready" && lyrics.synced && <LyricScroller lines={lines} index={idx} progress={progress} onSeek={seek} showTranslation={settings.showTranslation} />}
                </section>
              </>
            )}
          </div>
        ))}

        {spotify.message && (
          <div className={`toast glass${spotify.message.kind === "error" ? " toast--error" : ""}`} role="status">
            {spotify.message.text}
          </div>
        )}

        {/* 右下角：播放列表（正在播放的专辑 / 歌单里的所有歌） */}
        <button
          className={`fs-list glass${listOpen ? " is-on" : ""}`}
          aria-label={listOpen ? "关闭播放列表" : "播放列表"}
          title="播放列表"
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
        <NowListPanel
          open={listOpen}
          onClose={() => setListOpen(false)}
          loggedIn={spotify.account.loggedIn}
          needsReauth={spotify.account.needsReauth}
          onLogin={spotify.login}
          trackKey={now ? `${now.title}|${now.artist}` : ""}
          currentTitle={now?.title ?? ""}
        />

        {/* 左下角：全屏（无边框铺满屏幕），Esc 退出 */}
        <button
          className="fs-full glass"
          aria-label={fullscreen.full ? "退出全屏" : "全屏"}
          title={fullscreen.full ? "退出全屏（Esc）" : "全屏"}
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
              aria-label="上一首"
              onClick={() => {
                markDirection(-1);
                mediaControl("previous");
              }}
            >
              <PrevIcon />
            </button>
            <button className="play" aria-label={now?.playing ? "暂停" : "播放"} onClick={() => mediaControl("toggle")}>
              {now?.playing ? <PauseIcon size={26} /> : <PlayIcon size={26} />}
            </button>
            <button
              className="ibtn"
              aria-label="下一首"
              onClick={() => {
                markDirection(1);
                mediaControl("next");
              }}
            >
              <NextIcon />
            </button>
          </div>
          <SeekBar position={position} duration={now?.durationMs ?? 0} onPreview={setPreview} onSeek={seek} />
          <button
            className={`ibtn heart${spotify.liked ? " is-liked" : ""}`}
            aria-label={!spotify.account.loggedIn ? "连接 Spotify 后可收藏" : spotify.liked ? "从 Spotify 收藏中移除" : "收藏到 Spotify"}
            aria-pressed={!!spotify.liked}
            disabled={heartDisabled}
            title={heartDisabled ? "当前不是在 Spotify 播放" : undefined}
            onClick={onHeart}
          >
            <HeartIcon filled={!!spotify.liked} />
          </button>
        </footer>

        {settingsOpen && (
          <SettingsPanel
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
        )}
      </div>
    </div>
  );
}
