mod audio;
mod lyrics;
mod media;
mod spotify;
#[cfg(windows)]
mod smtc;

use media::{Artwork, NowPlaying, Snapshot};
use spotify::{AccountStatus, Tokens};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State};

#[derive(Default)]
struct AppState {
    snapshot: Mutex<Snapshot>,
    spotify: Mutex<Option<Tokens>>,
    tokens_path: Mutex<PathBuf>,
}

// ---------- 命令（前端用 invoke 调用） ----------

#[tauri::command]
fn get_snapshot(state: State<AppState>) -> Snapshot {
    state.snapshot.lock().unwrap().clone()
}

#[tauri::command]
async fn media_control(action: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || do_control(&action))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn media_seek(position_ms: i64) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || do_seek(position_ms))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(windows)]
fn do_seek(position_ms: i64) -> Result<bool, String> {
    smtc::init_thread();
    smtc::seek(position_ms).map_err(|e| e.to_string())
}

#[cfg(not(windows))]
fn do_seek(_position_ms: i64) -> Result<bool, String> {
    Err("只支持 Windows".into())
}

#[cfg(windows)]
fn do_control(action: &str) -> Result<bool, String> {
    smtc::init_thread();
    smtc::control(action).map_err(|e| e.to_string())
}

#[cfg(not(windows))]
fn do_control(_action: &str) -> Result<bool, String> {
    Err("只支持 Windows".into())
}

#[tauri::command]
async fn fetch_lyrics(
    title: String,
    artist: String,
    album: String,
    duration_ms: i64,
) -> Result<Option<lyrics::LyricsResult>, String> {
    lyrics::fetch(&title, &artist, &album, duration_ms)
        .await
        .map_err(|e| e.to_string())
}

/// 锁定后桌面歌词窗口鼠标穿透，只能从主窗口解锁
#[tauri::command]
fn set_desktop_locked(app: AppHandle, state: State<AppState>, locked: bool) -> Result<(), String> {
    let win = app
        .get_webview_window("desktop")
        .ok_or("找不到桌面歌词窗口")?;
    win.set_ignore_cursor_events(locked)
        .map_err(|e| e.to_string())?;
    state.snapshot.lock().unwrap().desktop_locked = locked;
    app.emit("desktop-locked", locked).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_desktop_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    let win = app
        .get_webview_window("desktop")
        .ok_or("找不到桌面歌词窗口")?;
    let result = if visible { win.show() } else { win.hide() };
    result.map_err(|e| e.to_string())?;
    app.emit("desktop-visible", visible).map_err(|e| e.to_string())
}


// ---------- Spotify 账号 ----------

fn account_status(state: &AppState) -> AccountStatus {
    match state.spotify.lock().unwrap().as_ref() {
        Some(t) => AccountStatus { logged_in: true, display_name: t.display_name.clone(), needs_reauth: t.needs_reauth() },
        None => AccountStatus::default(),
    }
}

#[tauri::command]
fn spotify_status(state: State<AppState>) -> AccountStatus {
    account_status(&state)
}

#[tauri::command]
async fn spotify_login(app: AppHandle) -> Result<AccountStatus, String> {
    let tokens = spotify::login().await?;
    let state = app.state::<AppState>();
    let path = state.tokens_path.lock().unwrap().clone();
    spotify::save_tokens(&path, &tokens)?;
    *state.spotify.lock().unwrap() = Some(tokens);
    let status = account_status(&state);
    let _ = app.emit("spotify-account", status.clone());
    Ok(status)
}

#[tauri::command]
fn spotify_logout(app: AppHandle, state: State<AppState>) -> AccountStatus {
    let path = state.tokens_path.lock().unwrap().clone();
    spotify::delete_tokens(&path);
    *state.spotify.lock().unwrap() = None;
    let status = AccountStatus::default();
    let _ = app.emit("spotify-account", status.clone());
    status
}

/// 拿一个有效的 access_token，需要时自动续期并保存
async fn access_token(app: &AppHandle) -> Result<Option<String>, String> {
    let state = app.state::<AppState>();
    let Some(mut tokens) = state.spotify.lock().unwrap().clone() else { return Ok(None) };
    if spotify::ensure_fresh(&mut tokens).await? {
        let path = state.tokens_path.lock().unwrap().clone();
        let _ = spotify::save_tokens(&path, &tokens);
        *state.spotify.lock().unwrap() = Some(tokens.clone());
    }
    Ok(Some(tokens.access_token))
}

/// 当前歌曲是否已收藏。没登录、或者当前不是在 Spotify 放歌时返回 null。
#[tauri::command]
async fn spotify_liked(app: AppHandle) -> Result<Option<bool>, String> {
    let Some(token) = access_token(&app).await? else { return Ok(None) };
    let Some(uri) = spotify::current_track_uri(&token).await? else { return Ok(None) };
    spotify::is_saved(&token, &uri).await.map(Some)
}

// ---------- 曲库 ----------

/// 曲库里的专辑（kind = "album"）或歌单（kind = "playlist"）
#[tauri::command]
async fn spotify_library(app: AppHandle, kind: String) -> Result<Vec<spotify::ShelfItem>, String> {
    let token = access_token(&app).await?.ok_or("还没有连接 Spotify 账号")?;
    if kind == "album" {
        spotify::saved_albums(&token).await
    } else {
        spotify::my_playlists(&token).await
    }
}

#[tauri::command]
async fn spotify_search(app: AppHandle, query: String, kind: String) -> Result<Vec<spotify::ShelfItem>, String> {
    let token = access_token(&app).await?.ok_or("还没有连接 Spotify 账号")?;
    spotify::search(&token, query.trim(), &kind).await
}

#[tauri::command]
async fn spotify_play(app: AppHandle, uri: String) -> Result<(), String> {
    let token = access_token(&app).await?.ok_or("还没有连接 Spotify 账号")?;
    spotify::play_context(&token, &uri).await
}

#[tauri::command]
async fn spotify_set_liked(app: AppHandle, liked: bool) -> Result<bool, String> {
    let token = access_token(&app).await?.ok_or("还没有连接 Spotify 账号")?;
    let uri = spotify::current_track_uri(&token)
        .await?
        .ok_or("Spotify 现在没有在放歌，收藏只对 Spotify 里正在播放的歌有效")?;
    spotify::set_saved(&token, &uri, liked).await?;
    let _ = app.emit("liked-changed", liked);
    Ok(liked)
}

// ---------- 后台线程：轮询 SMTC ----------

#[cfg(windows)]
fn spawn_media_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        smtc::init_thread();
        let mut manager = None;
        let mut last_now: Option<NowPlaying> = None;
        let mut artwork_key = String::new();
        let mut artwork_tries = 0u32;

        loop {
            if manager.is_none() {
                manager = smtc::manager().ok();
            }
            let session = manager.as_ref().and_then(smtc::current_session);
            let now = session.as_ref().and_then(|s| smtc::read_now_playing(s).ok());

            // 换歌后取封面。Spotify 的封面有时晚几百毫秒才就绪，所以失败会重试几次。
            if let (Some(s), Some(n)) = (session.as_ref(), now.as_ref()) {
                let key = n.track_key();
                if key != artwork_key {
                    artwork_key = key.clone();
                    artwork_tries = 0;
                }
                let have = app
                    .state::<AppState>()
                    .snapshot
                    .lock()
                    .unwrap()
                    .artwork
                    .as_ref()
                    .map_or(false, |a| a.track_key == key);
                if !have && artwork_tries < 8 {
                    artwork_tries += 1;
                    if let Ok(Some(data_url)) = smtc::read_artwork(s) {
                        let art = Artwork { track_key: key, data_url };
                        app.state::<AppState>().snapshot.lock().unwrap().artwork = Some(art.clone());
                        let _ = app.emit("artwork", art);
                    }
                }
            }

            if now != last_now {
                app.state::<AppState>().snapshot.lock().unwrap().now = now.clone();
                let _ = app.emit("now-playing", now.clone());
                last_now = now;
            }

            // 拿不到会话时可能是管理器失效了，下一轮重建
            if session.is_none() {
                manager = None;
            }
            std::thread::sleep(std::time::Duration::from_millis(300));
        }
    });
}

/// 把桌面歌词窗口放到主屏幕底部居中
fn place_desktop_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("desktop") else { return };
    let (Ok(Some(monitor)), Ok(size)) = (win.primary_monitor(), win.outer_size()) else { return };
    let m_pos = monitor.position();
    let m_size = monitor.size();
    let margin = (110.0 * monitor.scale_factor()) as i32;
    let x = m_pos.x + (m_size.width as i32 - size.width as i32) / 2;
    let y = m_pos.y + m_size.height as i32 - size.height as i32 - margin;
    let _ = win.set_position(PhysicalPosition::new(x, y));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            media_control,
            media_seek,
            fetch_lyrics,
            spotify_status,
            spotify_login,
            spotify_logout,
            spotify_liked,
            spotify_set_liked,
            spotify_library,
            spotify_search,
            spotify_play,
            set_desktop_locked,
            set_desktop_visible
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            // 读取之前保存的 Spotify 登录状态
            if let Ok(dir) = app.path().app_config_dir() {
                let path = dir.join("spotify.json");
                let state = app.state::<AppState>();
                *state.spotify.lock().unwrap() = spotify::load_tokens(&path);
                *state.tokens_path.lock().unwrap() = path;
            }
            place_desktop_window(&handle);
            // 拾音：采集系统声音做频谱，驱动拾音灯
            audio::start(handle.clone());
            #[cfg(windows)]
            spawn_media_watcher(handle);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("ingfy 启动失败");
}
