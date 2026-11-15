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
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewWindow};

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
    island: Mutex<IslandState>,
}

/// 灵动岛窗口的状态
#[derive(Default)]
struct IslandState {
    visible: bool,
    /// 锁定：鼠标穿透，鼠标移上去时隐身
    locked: bool,
    /// 贴在屏幕顶边
    docked: bool,
    /// 锁定时鼠标正停在岛上
    hover: bool,
    /// 窗口最后一次移动的时间；停下来、松开鼠标后检查要不要吸附到顶边
    last_move: Option<std::time::Instant>,
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
    // 桌面歌词窗口还没建的话先记着，建的时候会照这个状态设
    if let Some(win) = app.get_webview_window("desktop") {
        win.set_ignore_cursor_events(locked)
            .map_err(|e| e.to_string())?;
    }
    state.snapshot.lock().unwrap().desktop_locked = locked;
    app.emit("desktop-locked", locked).map_err(|e| e.to_string())
}

/// 拾音灯的反应速度（0~100），后端平滑频谱时用
#[tauri::command]
fn set_light_response(value: u8) {
    audio::RESPONSE.store(value.min(100), std::sync::atomic::Ordering::Relaxed);
}

/// 灵动岛显示 / 隐藏、锁定 / 不锁定。返回现在是不是贴在顶边。
/// 第一次显示时才创建窗口（所以是异步命令：Windows 上不能在同步命令里建窗口）
#[tauri::command]
async fn island_set(app: AppHandle, visible: bool, locked: bool) -> Result<bool, String> {
    let win = if visible { Some(ensure_window(&app, "island")?) } else { app.get_webview_window("island") };
    if let Some(win) = &win {
        win.set_ignore_cursor_events(locked).map_err(|e| e.to_string())?;
        let result = if visible { win.show() } else { win.hide() };
        result.map_err(|e| e.to_string())?;
    }
    let state = app.state::<AppState>();
    let mut st = state.island.lock().unwrap();
    st.visible = visible;
    st.locked = locked;
    if !locked {
        st.hover = false;
    }
    // 窗口还没建过：建出来时会放在顶边
    let docked = win.is_none() || st.docked;
    Ok(docked)
}

/// 改灵动岛窗口大小（逻辑像素）。保持水平居中位置和顶边不动，展开时往下长
#[tauri::command]
fn island_layout(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    let win = app.get_webview_window("island").ok_or("找不到灵动岛窗口")?;
    let scale = win.scale_factor().map_err(|e| e.to_string())?;
    let pos = win.outer_position().map_err(|e| e.to_string())?;
    let size = win.outer_size().map_err(|e| e.to_string())?;
    let w = (width * scale).round().max(1.0) as u32;
    let h = (height * scale).round().max(1.0) as u32;
    if w == size.width && h == size.height {
        return Ok(());
    }
    if w != size.width {
        let cx = pos.x + size.width as i32 / 2;
        win.set_position(PhysicalPosition::new(cx - w as i32 / 2, pos.y)).map_err(|e| e.to_string())?;
    }
    win.set_size(PhysicalSize::new(w, h)).map_err(|e| e.to_string())?;
    // 有的系统上"不可调整大小"的窗口改不了尺寸：临时打开再改一次，改完关回去
    if win.outer_size().map_or(false, |s| s.width != w || s.height != h) {
        let _ = win.set_resizable(true);
        let _ = win.set_size(PhysicalSize::new(w, h));
        let _ = win.set_resizable(false);
    }
    Ok(())
}

/// 桌面歌词窗口的高度跟着内容走：字调大以后，歌词条上面的播放控制栏不会被窗口顶边切掉。
/// 底边不动、往上长，用户摆好的歌词位置保持不变；宽度不改
#[tauri::command]
fn desktop_fit(app: AppHandle, height: f64) -> Result<(), String> {
    let Some(win) = app.get_webview_window("desktop") else { return Ok(()) };
    let scale = win.scale_factor().map_err(|e| e.to_string())?;
    let pos = win.outer_position().map_err(|e| e.to_string())?;
    let size = win.outer_size().map_err(|e| e.to_string())?;
    let h = (height * scale).round().max(1.0) as u32;
    if (h as i32 - size.height as i32).abs() <= 1 {
        return Ok(());
    }
    let bottom = pos.y + size.height as i32;
    win.set_size(PhysicalSize::new(size.width, h)).map_err(|e| e.to_string())?;
    win.set_position(PhysicalPosition::new(pos.x, bottom - h as i32)).map_err(|e| e.to_string())
}

/// 异步命令：第一次显示时要创建窗口，Windows 上不能在同步命令里建
#[tauri::command]
async fn set_desktop_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    show_desktop(&app, visible)
}

// ---------- 缓存 ----------

/// 下载的更新安装包放在这里
fn update_installer_path() -> PathBuf {
    std::env::temp_dir().join("ingfy-update-setup.exe")
}

/// 一个文件或文件夹占多少字节（读不了的跳过）
fn path_size(path: &std::path::Path) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(path) else { return 0 };
    if meta.is_file() {
        return meta.len();
    }
    if !meta.is_dir() {
        return 0;
    }
    let Ok(entries) = std::fs::read_dir(path) else { return 0 };
    entries.flatten().map(|e| path_size(&e.path())).sum()
}

/// 算作缓存的东西：网页内核存在硬盘上的缓存（封面图片等），和下载过的更新安装包。
/// 设置、登录状态不在里面
fn cache_paths(app: &AppHandle) -> Vec<PathBuf> {
    let mut paths = vec![update_installer_path()];
    if let Ok(dir) = app.path().app_local_data_dir() {
        let profile = dir.join("EBWebView").join("Default");
        paths.push(profile.join("Cache"));
        paths.push(profile.join("Code Cache"));
        paths.push(profile.join("GPUCache"));
        paths.push(profile.join("Service Worker").join("CacheStorage"));
    }
    paths
}

/// 缓存占了多少硬盘空间（字节）
#[tauri::command]
async fn cache_size(app: AppHandle) -> u64 {
    cache_paths(&app).iter().map(|p| path_size(p)).sum()
}

/// 清理硬盘上的缓存。网页内核那部分是后台清的，清完发 "cache-cleared"
#[tauri::command]
async fn clear_cache(app: AppHandle) -> Result<(), String> {
    let _ = std::fs::remove_file(update_installer_path());
    // 几个窗口共用一份网页数据，从主窗口清一次就行
    let win = app.get_webview_window("main").ok_or("找不到主窗口")?;
    clear_webview_cache(&app, &win)
}

#[cfg(not(windows))]
fn clear_webview_cache(app: &AppHandle, _win: &WebviewWindow) -> Result<(), String> {
    app.emit("cache-cleared", ()).map_err(|e| e.to_string())
}

/// 让 WebView2 清掉它的硬盘缓存。只清缓存这一类，本地存储（设置等）不受影响
#[cfg(windows)]
fn clear_webview_cache(app: &AppHandle, win: &WebviewWindow) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Profile2, ICoreWebView2_13, COREWEBVIEW2_BROWSING_DATA_KINDS_CACHE_STORAGE,
        COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE,
    };
    use windows_core::Interface;
    let app = app.clone();
    win.with_webview(move |webview| {
        let notify = app.clone();
        let started = (|| -> windows_core::Result<()> {
            unsafe {
                let profile = webview
                    .controller()
                    .CoreWebView2()?
                    .cast::<ICoreWebView2_13>()?
                    .Profile()?
                    .cast::<ICoreWebView2Profile2>()?;
                let done = webview2_com::ClearBrowsingDataCompletedHandler::create(Box::new(move |_| -> windows_core::Result<()> {
                    let _ = notify.emit("cache-cleared", ());
                    Ok(())
                }));
                profile.ClearBrowsingData(
                    COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE | COREWEBVIEW2_BROWSING_DATA_KINDS_CACHE_STORAGE,
                    &done,
                )
            }
        })();
        if let Err(e) = started {
            eprintln!("[cache] 清理网页缓存失败：{e}");
            // 没清成也告诉前端一声，别让按钮一直转
            let _ = app.emit("cache-cleared", ());
        }
    })
    .map_err(|e| e.to_string())
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
    let path = update_installer_path();
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

/// 桌面歌词和灵动岛的窗口启动时不建（配置里 create 是 false），第一次用到才按配置建出来，
/// 没开这两个功能时就少两个网页进程。
/// 注意：Windows 上不能在同步命令或事件回调里建窗口（会卡死），要在异步命令或单独的线程里调用
fn ensure_window(app: &AppHandle, label: &str) -> Result<WebviewWindow, String> {
    // 同一时间只建一个，免得连按两下快捷键建出两个同名窗口
    static BUILDING: Mutex<()> = Mutex::new(());
    let _guard = BUILDING.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(win) = app.get_webview_window(label) {
        return Ok(win);
    }
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == label)
        .ok_or("配置里找不到这个窗口")?;
    let win = tauri::WebviewWindowBuilder::from_config(app, config)
        .and_then(|builder| builder.build())
        .map_err(|e| e.to_string())?;
    match label {
        "desktop" => {
            place_desktop_window(app);
            // 窗口建出来之前就锁定过：补上鼠标穿透
            let locked = app.state::<AppState>().snapshot.lock().unwrap().desktop_locked;
            if locked {
                let _ = win.set_ignore_cursor_events(true);
            }
        }
        "island" => place_island_window(app),
        _ => {}
    }
    Ok(win)
}

/// 显示 / 隐藏桌面歌词，并通知主窗口同步按钮。显示时窗口还没建就先建
fn show_desktop(app: &AppHandle, visible: bool) -> Result<(), String> {
    if visible {
        ensure_window(app, "desktop")?.show().map_err(|e| e.to_string())?;
    } else if let Some(win) = app.get_webview_window("desktop") {
        win.hide().map_err(|e| e.to_string())?;
    }
    app.emit("desktop-visible", visible).map_err(|e| e.to_string())
}

/// 托盘和快捷键用：这两处是事件回调，建窗口要放到单独的线程里
fn toggle_desktop(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let visible = app
            .get_webview_window("desktop")
            .map_or(false, |w| w.is_visible().unwrap_or(false));
        if let Err(e) = show_desktop(&app, !visible) {
            eprintln!("[desktop] {e}");
        }
    });
}

fn control_async(action: &'static str) {
    std::thread::spawn(move || {
        let _ = do_control(action);
    });
}

/// 界面语言是不是英文（前端在设置里切换时通知过来），托盘菜单和登录回调页用
pub(crate) static UI_EN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub(crate) fn ui_en() -> bool {
    UI_EN.load(std::sync::atomic::Ordering::Relaxed)
}

fn tray_menu<R: tauri::Runtime, M: Manager<R>>(m: &M, en: bool) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    let tr = |zh: &'static str, e: &'static str| if en { e } else { zh };
    let show = MenuItem::with_id(m, "show", tr("显示主窗口", "Show ingfy"), true, None::<&str>)?;
    let desk = MenuItem::with_id(m, "desktop", tr("显示 / 隐藏桌面歌词", "Show / hide desktop lyrics"), true, None::<&str>)?;
    let island = MenuItem::with_id(m, "island", tr("显示 / 隐藏灵动岛", "Show / hide Dynamic Island"), true, None::<&str>)?;
    let prev = MenuItem::with_id(m, "prev", tr("上一首", "Previous"), true, None::<&str>)?;
    let toggle = MenuItem::with_id(m, "toggle", tr("播放 / 暂停", "Play / pause"), true, None::<&str>)?;
    let next = MenuItem::with_id(m, "next", tr("下一首", "Next"), true, None::<&str>)?;
    let quit = MenuItem::with_id(m, "quit", tr("退出 ingfy", "Quit ingfy"), true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(m)?;
    let sep2 = PredefinedMenuItem::separator(m)?;
    Menu::with_items(m, &[&show, &desk, &island, &sep1, &prev, &toggle, &next, &sep2, &quit])
}

/// 前端切换语言时调用：记下语言，并把托盘菜单换成对应语言
#[tauri::command]
fn set_language(app: AppHandle, lang: String) -> Result<(), String> {
    let en = lang == "en";
    UI_EN.store(en, std::sync::atomic::Ordering::Relaxed);
    if let Some(tray) = app.tray_by_id("ingfy") {
        let menu = tray_menu(&app, en).map_err(|e| e.to_string())?;
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    let menu = tray_menu(app, ui_en())?;
    let mut builder = TrayIconBuilder::with_id("ingfy")
        .tooltip("ingfy")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "desktop" => toggle_desktop(app),
            // 灵动岛开关存在前端设置里，交给主窗口切换（灵动岛窗口可能还没建）
            "island" => {
                let _ = app.emit("island-toggle", ());
            }
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

/// 把灵动岛放到主屏幕顶部正中，贴着顶边
fn place_island_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("island") else { return };
    let (Ok(Some(monitor)), Ok(size)) = (win.primary_monitor(), win.outer_size()) else { return };
    let m_pos = monitor.position();
    let x = m_pos.x + (monitor.size().width as i32 - size.width as i32) / 2;
    let _ = win.set_position(PhysicalPosition::new(x, m_pos.y));
    app.state::<AppState>().island.lock().unwrap().docked = true;
}

#[cfg(windows)]
fn left_button_down() -> bool {
    // 最高位是 1 表示鼠标左键现在按着
    unsafe { (windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(0x01) as u16 & 0x8000) != 0 }
}
#[cfg(not(windows))]
fn left_button_down() -> bool {
    false
}

/// 鼠标在屏幕上的位置（物理像素）
#[cfg(windows)]
fn cursor_position() -> Option<(i32, i32)> {
    let mut p = windows::Win32::Foundation::POINT::default();
    unsafe { windows::Win32::UI::WindowsAndMessaging::GetCursorPos(&mut p) }.ok()?;
    Some((p.x, p.y))
}
#[cfg(not(windows))]
fn cursor_position() -> Option<(i32, i32)> {
    None
}

/// 拖动结束后：离屏幕顶边很近就吸上去（变成刘海形状），并告诉前端现在贴没贴边
fn settle_island(app: &AppHandle, win: &WebviewWindow) {
    let (Ok(pos), Ok(Some(monitor))) = (win.outer_position(), win.current_monitor()) else { return };
    let top = monitor.position().y;
    let snap = (24.0 * monitor.scale_factor()) as i32;
    let docked = pos.y - top < snap;
    if docked && pos.y != top {
        let _ = win.set_position(PhysicalPosition::new(pos.x, top));
    }
    let changed = {
        let state = app.state::<AppState>();
        let mut st = state.island.lock().unwrap();
        let changed = st.docked != docked;
        st.docked = docked;
        changed
    };
    if changed {
        let _ = app.emit("island-dock", docked);
    }
}

/// 灵动岛的后台线程：拖完后吸附顶边；锁定时看鼠标在不在岛上，在就让它隐身
fn spawn_island_watcher(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(50));
        let (visible, locked, last_move) = {
            let state = app.state::<AppState>();
            let st = state.island.lock().unwrap();
            (st.visible, st.locked, st.last_move)
        };
        if !visible {
            continue;
        }
        let Some(win) = app.get_webview_window("island") else { continue };
        if let Some(t) = last_move {
            if t.elapsed() >= std::time::Duration::from_millis(150) && !left_button_down() {
                app.state::<AppState>().island.lock().unwrap().last_move = None;
                settle_island(&app, &win);
            }
        }
        if locked {
            let inside = match (cursor_position(), win.outer_position(), win.outer_size()) {
                (Some((x, y)), Ok(p), Ok(s)) => x >= p.x && x < p.x + s.width as i32 && y >= p.y && y < p.y + s.height as i32,
                _ => false,
            };
            let changed = {
                let state = app.state::<AppState>();
                let mut st = state.island.lock().unwrap();
                let changed = st.hover != inside;
                st.hover = inside;
                changed
            };
            if changed {
                let _ = app.emit("island-hover", inside);
            }
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
            // 灵动岛被拖动：记下时间，停下来后再判断要不要吸附顶边
            if window.label() == "island" {
                if let tauri::WindowEvent::Moved(_) = event {
                    window.state::<AppState>().island.lock().unwrap().last_move = Some(std::time::Instant::now());
                }
            }
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
            island_set,
            island_layout,
            desktop_fit,
            set_light_response,
            cache_size,
            clear_cache,
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
            open_url,
            set_language
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
            // 桌面歌词和灵动岛的窗口这里不建，第一次打开时才建（见 ensure_window）
            spawn_island_watcher(handle.clone());
            if let Err(e) = setup_tray(app) {
                eprintln!("[tray] 创建托盘图标失败：{e}");
            }
            if let Err(e) = setup_shortcuts(app) {
                eprintln!("[shortcut] 初始化失败：{e}");
            }
            // 主窗口在配置里默认隐藏，免得开机自启时闪一下
            if std::env::args().any(|a| a == "--autostart") {
                if let Err(e) = show_desktop(&handle, true) {
                    eprintln!("[desktop] {e}");
                }
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
