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
    /// 用户自己填的 Spotify Client ID，没填为 None（用自带的）
    client_id: Mutex<Option<String>>,
    client_path: Mutex<PathBuf>,
    /// 登录已过期：续期被 Spotify 拒绝了，需要重新连接
    spotify_expired: Mutex<bool>,
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
    let custom_client = state.client_id.lock().unwrap().is_some();
    let expired = *state.spotify_expired.lock().unwrap();
    match state.spotify.lock().unwrap().as_ref() {
        Some(t) => AccountStatus {
            logged_in: true,
            display_name: t.display_name.clone(),
            needs_reauth: expired || t.needs_reauth(),
            expired,
            custom_client,
        },
        None => AccountStatus { custom_client, ..Default::default() },
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientInfo {
    /// 自己填的 Client ID，没填为 null
    client_id: Option<String>,
    redirect_uri: String,
}

#[tauri::command]
fn spotify_client_get(state: State<AppState>) -> ClientInfo {
    ClientInfo { client_id: state.client_id.lock().unwrap().clone(), redirect_uri: spotify::REDIRECT_URI.into() }
}

/// 设置或清除自己的 Client ID。换了应用以后旧的登录不能再用，顺便断开。
#[tauri::command]
fn spotify_client_set(app: AppHandle, state: State<AppState>, client_id: Option<String>) -> Result<AccountStatus, String> {
    let id = client_id.map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty());
    if let Some(id) = &id {
        if !spotify::client_id_valid(id) {
            return Err("Client ID 应该是 32 位的字母和数字，复制的时候检查一下有没有多余的字符".into());
        }
    }
    let changed = *state.client_id.lock().unwrap() != id;
    let path = state.client_path.lock().unwrap().clone();
    spotify::save_client_id(&path, id.as_deref())?;
    *state.client_id.lock().unwrap() = id;
    if changed {
        let tokens_path = state.tokens_path.lock().unwrap().clone();
        spotify::delete_tokens(&tokens_path);
        *state.spotify.lock().unwrap() = None;
        *state.spotify_expired.lock().unwrap() = false;
    }
    let status = account_status(&state);
    let _ = app.emit("spotify-account", status.clone());
    Ok(status)
}

/// 用系统浏览器打开链接（只允许 https，比如 Spotify 开发者后台）
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("只能打开 https 链接".into());
    }
    open::that(url).map_err(|e| e.to_string())
}

#[tauri::command]
fn spotify_status(state: State<AppState>) -> AccountStatus {
    account_status(&state)
}

#[tauri::command]
async fn spotify_login(app: AppHandle) -> Result<AccountStatus, String> {
    let state = app.state::<AppState>();
    let client_id = state.client_id.lock().unwrap().clone().unwrap_or_else(|| spotify::CLIENT_ID.to_string());
    let tokens = spotify::login(&client_id).await?;
    let path = state.tokens_path.lock().unwrap().clone();
    spotify::save_tokens(&path, &tokens)?;
    *state.spotify.lock().unwrap() = Some(tokens);
    *state.spotify_expired.lock().unwrap() = false;
    let status = account_status(&state);
    let _ = app.emit("spotify-account", status.clone());
    Ok(status)
}

#[tauri::command]
fn spotify_logout(app: AppHandle, state: State<AppState>) -> AccountStatus {
    let path = state.tokens_path.lock().unwrap().clone();
    spotify::delete_tokens(&path);
    *state.spotify.lock().unwrap() = None;
    *state.spotify_expired.lock().unwrap() = false;
    let status = account_status(&state);
    let _ = app.emit("spotify-account", status.clone());
    status
}

const EXPIRED_MSG: &str = "Spotify 登录已过期，请在设置里重新连接";

/// 拿一个有效的 access_token，需要时自动续期并保存
async fn access_token(app: &AppHandle) -> Result<Option<String>, String> {
    let state = app.state::<AppState>();
    let Some(mut tokens) = state.spotify.lock().unwrap().clone() else { return Ok(None) };
    if *state.spotify_expired.lock().unwrap() {
        return Err(EXPIRED_MSG.into());
    }
    match spotify::ensure_fresh(&mut tokens).await {
        Ok(true) => {
            let path = state.tokens_path.lock().unwrap().clone();
            let _ = spotify::save_tokens(&path, &tokens);
            *state.spotify.lock().unwrap() = Some(tokens.clone());
        }
        Ok(false) => {}
        Err(spotify::RefreshError::Expired) => {
            // 记下来并通知界面：设置里显示"登录已过期"，各处的 Spotify 功能提示重新连接
            *state.spotify_expired.lock().unwrap() = true;
            let _ = app.emit("spotify-account", account_status(&state));
            return Err(EXPIRED_MSG.into());
        }
        Err(spotify::RefreshError::Other(e)) => return Err(e),
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

/// 正在播放的专辑 / 歌单里的所有歌；没在 Spotify 播放时返回 null
#[tauri::command]
async fn spotify_now_list(app: AppHandle) -> Result<Option<spotify::NowList>, String> {
    let token = access_token(&app).await?.ok_or("还没有连接 Spotify 账号")?;
    spotify::now_list(&token).await
}

#[tauri::command]
async fn spotify_context_tracks(app: AppHandle, uri: String) -> Result<spotify::NowList, String> {
    let token = access_token(&app).await?.ok_or("还没有连接 Spotify 账号")?;
    spotify::context_list(&token, &uri).await
}

#[tauri::command]
async fn spotify_play_track(app: AppHandle, context_uri: Option<String>, track_uri: String) -> Result<(), String> {
    let token = access_token(&app).await?.ok_or("还没有连接 Spotify 账号")?;
    spotify::play_track(&token, context_uri.as_deref(), &track_uri).await
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

// ---------- 歌词：手动换一个 ----------

#[tauri::command]
async fn lyrics_options(title: String, artist: String, duration_ms: i64) -> Vec<lyrics::LyricOption> {
    lyrics::options(&title, &artist, duration_ms).await
}

#[tauri::command]
async fn lyrics_by_id(source: String, id: String) -> Result<Option<lyrics::LyricsResult>, String> {
    lyrics::fetch_by(&source, &id).await.map_err(|e| e.to_string())
}

// ---------- 分享卡片：保存到"图片\ingfy" ----------

#[tauri::command]
fn save_share_image(app: AppHandle, png_base64: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(png_base64.trim_start_matches("data:image/png;base64,"))
        .map_err(|e| e.to_string())?;
    let dir = app
        .path()
        .picture_dir()
        .or_else(|_| app.path().download_dir())
        .map_err(|e| e.to_string())?
        .join("ingfy");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let path = dir.join(format!("ingfy-歌词-{stamp}.png"));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// 在资源管理器里打开图片所在的文件夹
#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    let dir = if p.is_dir() { p } else { p.parent().unwrap_or(p) };
    open::that(dir).map_err(|e| e.to_string())
}

// ---------- 开机自启 ----------

#[tauri::command]
fn autostart_enabled(app: AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    let m = app.autolaunch();
    let r = if enabled { m.enable() } else { m.disable() };
    r.map_err(|e| e.to_string())?;
    Ok(m.is_enabled().unwrap_or(enabled))
}

// ---------- 更新：查 GitHub 上的最新版本，下载安装程序并运行 ----------

const RELEASES_API: &str = "https://api.github.com/repos/Ingram5656/ingFY/releases/latest";

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    current: String,
    latest: String,
    has_update: bool,
    /// 安装程序下载地址（*-setup.exe）
    installer_url: Option<String>,
    page_url: Option<String>,
    notes: String,
}

fn version_tuple(v: &str) -> Vec<u64> {
    v.trim_start_matches(|c: char| c == 'v' || c == 'V').split(|c: char| c == '.' || c == '-').map(|x| x.parse().unwrap_or(0)).take(3).collect()
}

#[tauri::command]
async fn check_update(app: AppHandle) -> Result<UpdateInfo, String> {
    let current = app.package_info().version.to_string();
    let client = reqwest::Client::builder()
        .user_agent("ingfy-updater")
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(RELEASES_API).send().await.map_err(|_| "连不上 GitHub，稍后再试".to_string())?;
    if resp.status().as_u16() == 404 {
        return Ok(UpdateInfo { current: current.clone(), latest: current, has_update: false, installer_url: None, page_url: None, notes: String::new() });
    }
    if !resp.status().is_success() {
        return Err(format!("检查更新失败（GitHub 返回 {}）", resp.status().as_u16()));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let latest = v.get("tag_name").and_then(|t| t.as_str()).unwrap_or("").trim_start_matches(|c: char| c == 'v' || c == 'V').to_string();
    let installer_url = v
        .get("assets")
        .and_then(|a| a.as_array())
        .and_then(|xs| {
            xs.iter().find_map(|x| {
                let name = x.get("name")?.as_str()?.to_lowercase();
                if name.ends_with("-setup.exe") || name.ends_with(".exe") {
                    x.get("browser_download_url")?.as_str().map(str::to_string)
                } else {
                    None
                }
            })
        });
    Ok(UpdateInfo {
        has_update: !latest.is_empty() && version_tuple(&latest) > version_tuple(&current),
        current,
        latest,
        installer_url,
        page_url: v.get("html_url").and_then(|x| x.as_str()).map(str::to_string),
        notes: v.get("body").and_then(|x| x.as_str()).unwrap_or("").to_string(),
    })
}

/// 下载安装程序到临时文件夹并运行，然后退出 ingfy（安装程序需要替换正在运行的文件）
#[tauri::command]
async fn install_update(app: AppHandle, url: String) -> Result<(), String> {
    if !url.starts_with("https://github.com/") && !url.starts_with("https://objects.githubusercontent.com/") {
        return Err("更新地址不对".into());
    }
    let client = reqwest::Client::builder()
        .user_agent("ingfy-updater")
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;
    let bytes = client
        .get(&url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|_| "下载更新失败，检查一下网络".to_string())?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;
    let path = std::env::temp_dir().join("ingfy-update-setup.exe");
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    std::process::Command::new(&path).spawn().map_err(|e| format!("无法启动安装程序：{e}"))?;
    app.exit(0);
    Ok(())
}

// ---------- 托盘、快捷键、窗口 ----------

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn toggle_desktop(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("desktop") {
        let visible = !w.is_visible().unwrap_or(false);
        let _ = if visible { w.show() } else { w.hide() };
        let _ = app.emit("desktop-visible", visible);
    }
}

fn control_async(action: &'static str) {
    std::thread::spawn(move || {
        let _ = do_control(action);
    });
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let desk = MenuItem::with_id(app, "desktop", "显示 / 隐藏桌面歌词", true, None::<&str>)?;
    let prev = MenuItem::with_id(app, "prev", "上一首", true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle", "播放 / 暂停", true, None::<&str>)?;
    let next = MenuItem::with_id(app, "next", "下一首", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 ingfy", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show, &desk, &sep1, &prev, &toggle, &next, &sep2, &quit])?;
    let mut builder = TrayIconBuilder::with_id("ingfy")
        .tooltip("ingfy")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "desktop" => toggle_desktop(app),
            "prev" => control_async("previous"),
            "toggle" => control_async("toggle"),
            "next" => control_async("next"),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// 全局快捷键：在任何程序里都能用
/// Ctrl+Alt+L 显示/隐藏桌面歌词，Ctrl+Alt+P 播放/暂停，Ctrl+Alt+←/→ 上一首/下一首，Ctrl+Alt+K 收藏
fn setup_shortcuts(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
    let m = Some(Modifiers::CONTROL | Modifiers::ALT);
    let desk = Shortcut::new(m, Code::KeyL);
    let play = Shortcut::new(m, Code::KeyP);
    let prev = Shortcut::new(m, Code::ArrowLeft);
    let next = Shortcut::new(m, Code::ArrowRight);
    let like = Shortcut::new(m, Code::KeyK);
    let all = [desk.clone(), play.clone(), prev.clone(), next.clone(), like.clone()];
    app.handle().plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, shortcut, event| {
                if !matches!(event.state(), ShortcutState::Pressed) {
                    return;
                }
                if shortcut == &desk {
                    toggle_desktop(app);
                } else if shortcut == &play {
                    control_async("toggle");
                } else if shortcut == &prev {
                    let _ = app.emit("shortcut", "previous");
                    control_async("previous");
                } else if shortcut == &next {
                    let _ = app.emit("shortcut", "next");
                    control_async("next");
                } else if shortcut == &like {
                    // 收藏要用前端里的 Spotify 状态，交给主窗口处理
                    let _ = app.emit("shortcut", "like");
                }
            })
            .build(),
    )?;
    // 某个组合被别的程序占用时跳过它，其他照常注册
    for s in all {
        if let Err(e) = app.global_shortcut().register(s) {
            eprintln!("[shortcut] 注册失败：{e}");
        }
    }
    Ok(())
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
        // 已经开着的时候再启动一次：不开第二个，直接把已有的主窗口叫出来
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        // 开机自启时带上 --autostart，启动后只显示桌面歌词、主窗口留在托盘
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .manage(AppState::default())
        // 点主窗口的关闭按钮：缩到托盘继续运行（桌面歌词和快捷键都还在），从托盘菜单退出
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
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
            spotify_now_list,
            spotify_play_track,
            spotify_context_tracks,
            set_desktop_locked,
            set_desktop_visible,
            lyrics_options,
            lyrics_by_id,
            save_share_image,
            reveal_path,
            autostart_enabled,
            set_autostart,
            check_update,
            install_update,
            spotify_client_get,
            spotify_client_set,
            open_url
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            // 读取之前保存的 Spotify 登录状态
            if let Ok(dir) = app.path().app_config_dir() {
                let path = dir.join("spotify.json");
                let state = app.state::<AppState>();
                *state.spotify.lock().unwrap() = spotify::load_tokens(&path);
                *state.client_id.lock().unwrap() = spotify::load_client_id(&dir.join("spotify_client.txt"));
                *state.client_path.lock().unwrap() = dir.join("spotify_client.txt");
                *state.tokens_path.lock().unwrap() = path;
            }
            place_desktop_window(&handle);
            if let Err(e) = setup_tray(app) {
                eprintln!("[tray] 创建托盘图标失败：{e}");
            }
            if let Err(e) = setup_shortcuts(app) {
                eprintln!("[shortcut] 初始化失败：{e}");
            }
            // 主窗口在配置里默认隐藏，免得开机自启时闪一下
            if std::env::args().any(|a| a == "--autostart") {
                if let Some(w) = app.get_webview_window("desktop") {
                    let _ = w.show();
                }
                let _ = handle.emit("desktop-visible", true);
            } else {
                show_main(&handle);
            }
            // 拾音：采集系统声音做频谱，驱动拾音灯
            audio::start(handle.clone());
            #[cfg(windows)]
            spawn_media_watcher(handle);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("ingfy 启动失败");
}
