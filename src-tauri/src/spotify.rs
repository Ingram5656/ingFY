//! Spotify 账号：PKCE 登录（不需要 Client Secret）、token 保存与自动续期、收藏当前歌曲。
//!
//! 登录流程：
//! 1. 生成随机 code_verifier 和对应的 code_challenge
//! 2. 在 127.0.0.1:43821 起一个一次性的本地 HTTP 服务等回调
//! 3. 用系统浏览器打开 Spotify 授权页
//! 4. 用户同意后浏览器跳回 http://127.0.0.1:43821/callback?code=...
//! 5. 用 code + code_verifier 换 access_token / refresh_token，存到本地
//!
//! 收藏用 2026 年 2 月之后的新接口 /me/library（参数是 spotify:track:xxx 形式的 URI）。
//! 曲库：读取收藏的专辑、自己的歌单，搜索 Spotify 曲库，从某张专辑 / 某个歌单开始播放。

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const CLIENT_ID: &str = "b8fb12eb68ea41f6abaf0b18d42613f7";
const REDIRECT_URI: &str = "http://127.0.0.1:43821/callback";
const LISTEN_ADDR: &str = "127.0.0.1:43821";
/// 2026 年 2 月的新收藏接口 /me/library 合并了歌曲、专辑、关注、歌单，
/// 官方文档要求同时具备 user-library-modify、user-follow-modify、playlist-modify-public 三个权限，
/// 查询接口 /me/library/contains 同理需要对应的读取权限。
/// 曲库页面点封面播放需要 user-modify-playback-state（只有 Premium 账号能用）。
const SCOPES: &str = "user-library-read user-library-modify user-follow-read user-follow-modify \
playlist-read-private playlist-modify-public user-read-currently-playing user-read-playback-state \
user-modify-playback-state";
/// 判断旧登录是否缺少现在需要的权限，缺了就提示重新连接
const REQUIRED_SCOPES: &[&str] = &["playlist-modify-public", "user-modify-playback-state"];

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: String,
    /// 过期时间（Unix 秒）
    pub expires_at: u64,
    #[serde(default)]
    pub display_name: String,
    /// 授权时实际拿到的权限，空格分隔
    #[serde(default)]
    pub scope: String,
}

impl Tokens {
    /// 旧版本登录时没有申请新收藏接口需要的权限，需要重新连接
    pub fn needs_reauth(&self) -> bool {
        REQUIRED_SCOPES.iter().any(|need| !self.scope.split_whitespace().any(|s| s == *need))
    }
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    pub logged_in: bool,
    pub display_name: String,
    /// 已登录但权限不够，需要重新连接
    pub needs_reauth: bool,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: u64,
    scope: Option<String>,
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn random_string(len_bytes: usize) -> Result<String, String> {
    let mut buf = vec![0u8; len_bytes];
    getrandom::getrandom(&mut buf).map_err(|e| e.to_string())?;
    Ok(b64url(&buf))
}

// ---------- token 存取 ----------

pub fn load_tokens(path: &PathBuf) -> Option<Tokens> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn save_tokens(path: &PathBuf, t: &Tokens) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(t).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| e.to_string())
}

pub fn delete_tokens(path: &PathBuf) {
    let _ = std::fs::remove_file(path);
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("ingfy/1.0")
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())
}

// ---------- 登录 ----------

/// 等浏览器回调：返回 (code, state)。最多等 3 分钟。
fn wait_for_callback(listener: TcpListener) -> Result<(String, String), String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let deadline = std::time::Instant::now() + Duration::from_secs(180);
    loop {
        match listener.accept() {
            Ok((mut stream, _)) => {
                stream.set_nonblocking(false).ok();
                stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let path = req.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("");
                if !path.starts_with("/callback") {
                    // 浏览器顺带请求的 favicon 之类，忽略
                    let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
                    continue;
                }
                let url = reqwest::Url::parse(&format!("http://127.0.0.1{path}")).map_err(|e| e.to_string())?;
                let mut code = None;
                let mut state = None;
                let mut error = None;
                for (k, v) in url.query_pairs() {
                    match k.as_ref() {
                        "code" => code = Some(v.to_string()),
                        "state" => state = Some(v.to_string()),
                        "error" => error = Some(v.to_string()),
                        _ => {}
                    }
                }
                let (title, msg) = if code.is_some() {
                    ("登录成功", "已经连接到 ingfy，可以关闭这个页面了。")
                } else {
                    ("没有登录", "你取消了授权，或者授权出错了。可以回到 ingfy 重新连接。")
                };
                let body = format!(
                    "<!doctype html><meta charset=utf-8><title>{title}</title>\
                     <body style=\"font-family:'Microsoft YaHei UI',sans-serif;background:#1a1238;color:#fff;\
                     display:grid;place-items:center;height:100vh;margin:0\"><div style=text-align:center>\
                     <h1 style=font-size:28px>{title}</h1><p style=opacity:.75>{msg}</p></div>"
                );
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.as_bytes().len(),
                    body
                );
                let _ = stream.write_all(resp.as_bytes());
                return match (code, state) {
                    (Some(c), Some(s)) => Ok((c, s)),
                    _ => Err(format!("授权没有完成：{}", error.unwrap_or_else(|| "未知原因".into()))),
                };
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if std::time::Instant::now() > deadline {
                    return Err("等待登录超时（3 分钟），请重试".into());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

/// 完整登录流程：打开浏览器授权，等回调，换取 token。
pub async fn login() -> Result<Tokens, String> {
    let verifier = random_string(48)?;
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
    let state = random_string(16)?;

    let listener = TcpListener::bind(LISTEN_ADDR)
        .map_err(|_| "端口 43821 被占用了，关掉占用它的程序后再试".to_string())?;

    let auth_url = reqwest::Url::parse_with_params(
        "https://accounts.spotify.com/authorize",
        &[
            ("client_id", CLIENT_ID),
            ("response_type", "code"),
            ("redirect_uri", REDIRECT_URI),
            ("code_challenge_method", "S256"),
            ("code_challenge", challenge.as_str()),
            ("state", state.as_str()),
            ("scope", SCOPES),
        ],
    )
    .map_err(|e| e.to_string())?;
    open::that(auth_url.as_str()).map_err(|e| format!("打不开浏览器：{e}"))?;

    let (code, got_state) = tauri::async_runtime::spawn_blocking(move || wait_for_callback(listener))
        .await
        .map_err(|e| e.to_string())??;
    if got_state != state {
        return Err("授权校验失败（state 不一致），请重试".into());
    }

    let resp: TokenResponse = client()?
        .post("https://accounts.spotify.com/api/token")
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("redirect_uri", REDIRECT_URI),
            ("client_id", CLIENT_ID),
            ("code_verifier", verifier.as_str()),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| format!("换取登录凭证失败：{e}"))?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    let mut tokens = Tokens {
        access_token: resp.access_token,
        refresh_token: resp.refresh_token.unwrap_or_default(),
        expires_at: now_secs() + resp.expires_in.saturating_sub(60),
        display_name: String::new(),
        scope: resp.scope.unwrap_or_default(),
    };
    tokens.display_name = fetch_display_name(&tokens.access_token).await.unwrap_or_default();
    Ok(tokens)
}

async fn fetch_display_name(access: &str) -> Result<String, String> {
    #[derive(Deserialize)]
    struct Me {
        display_name: Option<String>,
        id: String,
    }
    let me: Me = client()?
        .get("https://api.spotify.com/v1/me")
        .bearer_auth(access)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    Ok(me.display_name.filter(|s| !s.is_empty()).unwrap_or(me.id))
}

/// access_token 快过期时用 refresh_token 续期。返回是否更新过。
pub async fn ensure_fresh(tokens: &mut Tokens) -> Result<bool, String> {
    if now_secs() < tokens.expires_at {
        return Ok(false);
    }
    let resp: TokenResponse = client()?
        .post("https://accounts.spotify.com/api/token")
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", tokens.refresh_token.as_str()),
            ("client_id", CLIENT_ID),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|_| "登录已失效，请在设置里重新连接 Spotify".to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    tokens.access_token = resp.access_token;
    if let Some(r) = resp.refresh_token {
        tokens.refresh_token = r;
    }
    if let Some(sc) = resp.scope {
        tokens.scope = sc;
    }
    tokens.expires_at = now_secs() + resp.expires_in.saturating_sub(60);
    Ok(true)
}

// ---------- 收藏 ----------

/// 当前在 Spotify 播放的歌曲 URI（spotify:track:xxx）。没有在 Spotify 放歌时返回 None。
pub async fn current_track_uri(access: &str) -> Result<Option<String>, String> {
    #[derive(Deserialize)]
    struct Item {
        uri: String,
        #[serde(rename = "type")]
        kind: Option<String>,
    }
    #[derive(Deserialize)]
    struct Playing {
        item: Option<Item>,
    }
    let resp = client()?
        .get("https://api.spotify.com/v1/me/player/currently-playing")
        .bearer_auth(access)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if resp.status() == reqwest::StatusCode::NO_CONTENT {
        return Ok(None);
    }
    let playing: Playing = resp
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    Ok(playing
        .item
        .filter(|i| i.kind.as_deref().unwrap_or("track") == "track")
        .map(|i| i.uri))
}

pub async fn is_saved(access: &str, uri: &str) -> Result<bool, String> {
    let list: Vec<bool> = client()?
        .get("https://api.spotify.com/v1/me/library/contains")
        .query(&[("uris", uri)])
        .bearer_auth(access)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    Ok(list.first().copied().unwrap_or(false))
}

pub async fn set_saved(access: &str, uri: &str, saved: bool) -> Result<(), String> {
    let c = client()?;
    let req = if saved {
        c.put("https://api.spotify.com/v1/me/library")
    } else {
        c.delete("https://api.spotify.com/v1/me/library")
    };
    // 没有请求体的 PUT，Spotify 的服务器要求必须带 "Content-Length: 0"，否则返回 411。
    // 空 body 时 HTTP 库不会自动加这个头，所以手动写上。
    let resp = req
        .query(&[("uris", uri)])
        .bearer_auth(access)
        .header(reqwest::header::CONTENT_LENGTH, "0")
        .send()
        .await
        .map_err(|_| "连不上 Spotify，检查一下网络".to_string())?;
    let status = resp.status();
    if status.is_success() {
        return Ok(());
    }
    let action = if saved { "收藏" } else { "取消收藏" };
    Err(match status.as_u16() {
        401 => "登录已失效，请在设置里重新连接 Spotify".to_string(),
        403 => "Spotify 拒绝了：新版收藏接口需要更多权限。打开设置，在 Spotify 账号那里点“重新连接”".to_string(),
        429 => format!("操作太频繁了，等几秒再{action}"),
        code => format!("{action}失败（Spotify 返回 {code}），稍后再试"),
    })
}

// ---------- 曲库 ----------

/// 唱片架上的一张：专辑或歌单
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShelfItem {
    /// spotify:album:xxx / spotify:playlist:xxx，播放时用
    pub uri: String,
    pub name: String,
    /// 专辑是歌手，歌单是创建者
    pub subtitle: String,
    pub image: Option<String>,
    pub kind: String,
}

/// 封面挑一张 300px 左右的，够清晰又不会太大
fn pick_image(v: &serde_json::Value) -> Option<String> {
    let imgs = v.get("images")?.as_array()?;
    let mut best: Option<(i64, String)> = None;
    for img in imgs {
        let Some(url) = img.get("url").and_then(|u| u.as_str()) else { continue };
        let w = img.get("width").and_then(|w| w.as_i64()).unwrap_or(300);
        let score = (w - 320).abs();
        if best.as_ref().map_or(true, |(b, _)| score < *b) {
            best = Some((score, url.to_string()));
        }
    }
    best.map(|(_, u)| u)
}

fn album_item(a: &serde_json::Value) -> Option<ShelfItem> {
    let artists = a
        .get("artists")
        .and_then(|x| x.as_array())
        .map(|xs| xs.iter().filter_map(|x| x.get("name")?.as_str()).collect::<Vec<_>>().join(" · "))
        .unwrap_or_default();
    Some(ShelfItem {
        uri: a.get("uri")?.as_str()?.to_string(),
        name: a.get("name")?.as_str()?.to_string(),
        subtitle: artists,
        image: pick_image(a),
        kind: "album".into(),
    })
}

fn playlist_item(p: &serde_json::Value) -> Option<ShelfItem> {
    let owner = p
        .pointer("/owner/display_name")
        .and_then(|x| x.as_str())
        .or_else(|| p.pointer("/owner/id").and_then(|x| x.as_str()))
        .unwrap_or("")
        .to_string();
    Some(ShelfItem {
        uri: p.get("uri")?.as_str()?.to_string(),
        name: p.get("name")?.as_str()?.to_string(),
        subtitle: owner,
        image: pick_image(p),
        kind: "playlist".into(),
    })
}

/// 把 Spotify 的错误码翻译成能看懂的话
fn api_error(status: u16, what: &str) -> String {
    match status {
        401 => "登录已失效，请在设置里重新连接 Spotify".to_string(),
        403 => format!("Spotify 拒绝了{what}：可能需要重新连接 Spotify 授权新权限，播放还需要 Premium 账号"),
        404 => format!("{what}失败：没找到可以播放的设备，先打开 Spotify 客户端"),
        429 => "请求太频繁了，等几秒再试".to_string(),
        code => format!("{what}失败（Spotify 返回 {code}），稍后再试"),
    }
}

async fn get_json(url: &str, query: &[(&str, String)], access: &str, what: &str) -> Result<serde_json::Value, String> {
    let resp = client()?
        .get(url)
        .query(query)
        .bearer_auth(access)
        .send()
        .await
        .map_err(|_| "连不上 Spotify，检查一下网络".to_string())?;
    let status = resp.status();
    if !status.is_success() {
        return Err(api_error(status.as_u16(), what));
    }
    resp.json().await.map_err(|e| e.to_string())
}

/// 收藏的专辑（最多 300 张，按收藏时间从新到旧）
pub async fn saved_albums(access: &str) -> Result<Vec<ShelfItem>, String> {
    let mut out = Vec::new();
    for page in 0..6 {
        let v = get_json(
            "https://api.spotify.com/v1/me/albums",
            &[("limit", "50".into()), ("offset", (page * 50).to_string())],
            access,
            "读取收藏的专辑",
        )
        .await?;
        let items = v.get("items").and_then(|x| x.as_array()).cloned().unwrap_or_default();
        out.extend(items.iter().filter_map(|it| it.get("album").and_then(album_item)));
        if v.get("next").map_or(true, |n| n.is_null()) {
            break;
        }
    }
    Ok(out)
}

/// "已点赞的歌曲"：在接口里不是歌单，而是单独的收藏夹。
/// 播放时用 spotify:user:<用户 id>:collection 作为 context。
async fn liked_songs_item(access: &str) -> Result<ShelfItem, String> {
    let me = get_json("https://api.spotify.com/v1/me", &[], access, "读取账号").await?;
    let id = me.get("id").and_then(|x| x.as_str()).ok_or("读取账号失败")?.to_string();
    let total = get_json("https://api.spotify.com/v1/me/tracks", &[("limit", "1".into())], access, "读取已点赞的歌曲")
        .await
        .ok()
        .and_then(|v| v.get("total").and_then(|t| t.as_i64()));
    Ok(ShelfItem {
        uri: format!("spotify:user:{id}:collection"),
        name: "已点赞的歌曲".into(),
        subtitle: total.map(|n| format!("{n} 首")).unwrap_or_default(),
        image: None,
        kind: "liked".into(),
    })
}

/// 自己创建和关注的歌单（最多 300 个），最前面固定放"已点赞的歌曲"
pub async fn my_playlists(access: &str) -> Result<Vec<ShelfItem>, String> {
    let mut out = Vec::new();
    if let Ok(liked) = liked_songs_item(access).await {
        out.push(liked);
    }
    for page in 0..6 {
        let v = get_json(
            "https://api.spotify.com/v1/me/playlists",
            &[("limit", "50".into()), ("offset", (page * 50).to_string())],
            access,
            "读取歌单",
        )
        .await?;
        let items = v.get("items").and_then(|x| x.as_array()).cloned().unwrap_or_default();
        out.extend(items.iter().filter_map(playlist_item));
        if v.get("next").map_or(true, |n| n.is_null()) {
            break;
        }
    }
    Ok(out)
}

/// 搜索 Spotify 曲库。2026 年 2 月起每页最多 10 条，这里取两页共 20 条。
pub async fn search(access: &str, query: &str, kind: &str) -> Result<Vec<ShelfItem>, String> {
    let kind = if kind == "album" { "album" } else { "playlist" };
    let mut out = Vec::new();
    for offset in [0, 10] {
        let v = get_json(
            "https://api.spotify.com/v1/search",
            &[("q", query.to_string()), ("type", kind.into()), ("limit", "10".into()), ("offset", offset.to_string())],
            access,
            "搜索",
        )
        .await?;
        // 歌单搜索结果里偶尔会有 null，跳过
        let items = v.pointer(&format!("/{kind}s/items")).and_then(|x| x.as_array()).cloned().unwrap_or_default();
        let before = out.len();
        out.extend(items.iter().filter(|x| !x.is_null()).filter_map(|x| if kind == "album" { album_item(x) } else { playlist_item(x) }));
        if out.len() - before < 10 && items.len() < 10 {
            break;
        }
    }
    Ok(out)
}

/// 从某张专辑 / 某个歌单开始播放（需要 Premium）。
/// 没有正在使用的设备时，挑一个设备（优先这台电脑）再播；一个设备都没有就先打开 Spotify 客户端。
pub async fn play_context(access: &str, context_uri: &str) -> Result<(), String> {
    play_body(access, serde_json::json!({ "context_uri": context_uri })).await
}

/// 播放列表里点某一首：在原来的专辑 / 歌单里跳到这首（后面接着播同一个列表）；
/// 没有专辑 / 歌单（比如播放队列）时只播这一首。
pub async fn play_track(access: &str, context_uri: Option<&str>, track_uri: &str) -> Result<(), String> {
    let body = match context_uri {
        Some(ctx) => serde_json::json!({ "context_uri": ctx, "offset": { "uri": track_uri } }),
        None => serde_json::json!({ "uris": [track_uri] }),
    };
    play_body(access, body).await
}

async fn play_body(access: &str, body: serde_json::Value) -> Result<(), String> {
    let try_play = |device: Option<String>| {
        let body = body.clone();
        async move {
            let c = client()?;
            let mut req = c.put("https://api.spotify.com/v1/me/player/play").bearer_auth(access).json(&body);
            if let Some(id) = device {
                req = req.query(&[("device_id", id)]);
            }
            let resp = req.send().await.map_err(|_| "连不上 Spotify，检查一下网络".to_string())?;
            Ok::<u16, String>(resp.status().as_u16())
        }
    };

    let status = try_play(None).await?;
    if (200..300).contains(&status) {
        return Ok(());
    }
    if status != 404 {
        return Err(api_error(status, "播放"));
    }

    // 没有活动设备：找一个
    for attempt in 0..2 {
        let v = get_json("https://api.spotify.com/v1/me/player/devices", &[], access, "查找播放设备").await?;
        let devices = v.get("devices").and_then(|d| d.as_array()).cloned().unwrap_or_default();
        let pick = devices
            .iter()
            .find(|d| d.get("type").and_then(|t| t.as_str()) == Some("Computer"))
            .or_else(|| devices.first())
            .and_then(|d| d.get("id").and_then(|i| i.as_str()).map(str::to_string));
        if let Some(id) = pick {
            let status = try_play(Some(id)).await?;
            return if (200..300).contains(&status) { Ok(()) } else { Err(api_error(status, "播放")) };
        }
        if attempt == 0 {
            // 一个设备都没有：打开 Spotify 客户端，等它连上
            let _ = open::that("spotify:");
            wait_for(Duration::from_secs(4)).await;
        }
    }
    Err("没找到可以播放的设备：打开 Spotify 客户端后再点一次".to_string())
}

/// 异步等待：放到后台线程里睡，不占用异步运行时
async fn wait_for(d: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await;
}

// ---------- 播放列表（正在播放的专辑 / 歌单里的所有歌） ----------

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListTrack {
    pub uri: String,
    pub name: String,
    pub artists: String,
    pub duration_ms: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NowList {
    /// "album" / "playlist" / "liked"（已点赞的歌曲）/ "queue"（其他情况，显示接下来的播放队列）
    pub kind: String,
    /// 点某首歌时要带上的专辑 / 歌单 URI；播放队列为空
    pub context_uri: Option<String>,
    pub title: String,
    pub subtitle: String,
    pub image: Option<String>,
    pub tracks: Vec<ListTrack>,
    /// 正在播放的那首
    pub current_uri: Option<String>,
    /// 读取歌单内容失败时的说明（比如别人的歌单 Spotify 不再开放内容）
    pub note: Option<String>,
}

fn list_track(t: &serde_json::Value) -> Option<ListTrack> {
    if t.is_null() {
        return None;
    }
    // 播客单集没有 artists，用节目名代替
    let artists = t
        .get("artists")
        .and_then(|x| x.as_array())
        .map(|xs| xs.iter().filter_map(|x| x.get("name")?.as_str()).collect::<Vec<_>>().join(" · "))
        .filter(|s| !s.is_empty())
        .or_else(|| t.pointer("/show/name").and_then(|x| x.as_str()).map(str::to_string))
        .unwrap_or_default();
    Some(ListTrack {
        uri: t.get("uri")?.as_str()?.to_string(),
        name: t.get("name")?.as_str()?.to_string(),
        artists,
        duration_ms: t.get("duration_ms").and_then(|d| d.as_i64()).unwrap_or(0),
    })
}

/// spotify:album:xxx → ("album", "xxx")
fn split_uri(uri: &str) -> Option<(&str, &str)> {
    let mut it = uri.split(':');
    if it.next()? != "spotify" {
        return None;
    }
    let kind = it.next()?;
    let id = it.next()?;
    Some((kind, id))
}

/// 正在播放的歌所在的专辑 / 歌单，以及里面所有的歌（专辑最多 200 首，歌单最多 500 首）。
/// 没在 Spotify 播放时返回 None。
pub async fn now_list(access: &str) -> Result<Option<NowList>, String> {
    let resp = client()?
        .get("https://api.spotify.com/v1/me/player")
        .bearer_auth(access)
        .send()
        .await
        .map_err(|_| "连不上 Spotify，检查一下网络".to_string())?;
    if resp.status() == reqwest::StatusCode::NO_CONTENT {
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(api_error(resp.status().as_u16(), "读取播放状态"));
    }
    let player: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let current_uri = player.pointer("/item/uri").and_then(|x| x.as_str()).map(str::to_string);
    let context_uri = player.pointer("/context/uri").and_then(|x| x.as_str()).map(str::to_string);

    let mut note = None;
    if let Some(ctx) = context_uri.as_deref() {
        if ctx.ends_with(":collection") {
            match liked_list(access, ctx).await {
                Ok(mut l) => {
                    l.current_uri = current_uri;
                    return Ok(Some(l));
                }
                Err(e) => note = Some(e),
            }
        }
        match split_uri(ctx) {
            Some(("album", id)) => match album_list(access, id, ctx).await {
                Ok(mut l) => {
                    l.current_uri = current_uri;
                    return Ok(Some(l));
                }
                Err(e) => note = Some(e),
            },
            Some(("playlist", id)) => match playlist_list(access, id, ctx).await {
                Ok(mut l) => {
                    l.current_uri = current_uri;
                    return Ok(Some(l));
                }
                Err(e) => note = Some(e),
            },
            _ => {}
        }
    }

    // 其他情况（单曲、电台、"已点赞的歌曲"、读不到的歌单）：显示播放队列
    let mut l = queue_list(access).await?;
    l.current_uri = current_uri;
    l.note = note;
    Ok(Some(l))
}

async fn album_list(access: &str, id: &str, ctx: &str) -> Result<NowList, String> {
    let album = get_json(&format!("https://api.spotify.com/v1/albums/{id}"), &[], access, "读取专辑").await?;
    let mut tracks: Vec<ListTrack> = album
        .pointer("/tracks/items")
        .and_then(|x| x.as_array())
        .map(|xs| xs.iter().filter_map(list_track).collect())
        .unwrap_or_default();
    // 超过 50 首的专辑接着往下取
    let total = album.pointer("/tracks/total").and_then(|x| x.as_i64()).unwrap_or(0) as usize;
    let mut offset = tracks.len();
    while offset < total.min(200) {
        let v = get_json(
            &format!("https://api.spotify.com/v1/albums/{id}/tracks"),
            &[("limit", "50".into()), ("offset", offset.to_string())],
            access,
            "读取专辑",
        )
        .await?;
        let page: Vec<ListTrack> = v.get("items").and_then(|x| x.as_array()).map(|xs| xs.iter().filter_map(list_track).collect()).unwrap_or_default();
        if page.is_empty() {
            break;
        }
        offset += page.len();
        tracks.extend(page);
    }
    let item = album_item(&album);
    Ok(NowList {
        kind: "album".into(),
        context_uri: Some(ctx.to_string()),
        title: item.as_ref().map(|i| i.name.clone()).unwrap_or_default(),
        subtitle: item.as_ref().map(|i| i.subtitle.clone()).unwrap_or_default(),
        image: item.and_then(|i| i.image),
        tracks,
        current_uri: None,
        note: None,
    })
}

async fn playlist_list(access: &str, id: &str, ctx: &str) -> Result<NowList, String> {
    let meta = get_json(
        &format!("https://api.spotify.com/v1/playlists/{id}"),
        &[("fields", "uri,name,owner(display_name,id),images".into())],
        access,
        "读取歌单",
    )
    .await?;
    let mut tracks = Vec::new();
    for page in 0..10 {
        let v = get_json(
            &format!("https://api.spotify.com/v1/playlists/{id}/items"),
            &[("limit", "50".into()), ("offset", (page * 50).to_string())],
            access,
            "读取歌单里的歌",
        )
        .await?;
        let items = v.get("items").and_then(|x| x.as_array()).cloned().unwrap_or_default();
        // 2026 年 2 月起每一项里的 track 改名为 item，两种都认
        tracks.extend(items.iter().filter_map(|it| it.get("item").or_else(|| it.get("track")).and_then(list_track)));
        if v.get("next").map_or(true, |n| n.is_null()) {
            break;
        }
    }
    let item = playlist_item(&meta);
    Ok(NowList {
        kind: "playlist".into(),
        context_uri: Some(ctx.to_string()),
        title: item.as_ref().map(|i| i.name.clone()).unwrap_or_default(),
        subtitle: item.as_ref().map(|i| i.subtitle.clone()).unwrap_or_default(),
        image: item.and_then(|i| i.image),
        tracks,
        current_uri: None,
        note: None,
    })
}

/// 已点赞的歌曲（按点赞时间从新到旧，最多 500 首）
async fn liked_list(access: &str, ctx: &str) -> Result<NowList, String> {
    let mut tracks = Vec::new();
    let mut total = 0;
    for page in 0..10 {
        let v = get_json(
            "https://api.spotify.com/v1/me/tracks",
            &[("limit", "50".into()), ("offset", (page * 50).to_string())],
            access,
            "读取已点赞的歌曲",
        )
        .await?;
        total = v.get("total").and_then(|t| t.as_i64()).unwrap_or(0);
        let items = v.get("items").and_then(|x| x.as_array()).cloned().unwrap_or_default();
        tracks.extend(items.iter().filter_map(|it| it.get("track").or_else(|| it.get("item")).and_then(list_track)));
        if v.get("next").map_or(true, |n| n.is_null()) {
            break;
        }
    }
    let shown = tracks.len() as i64;
    Ok(NowList {
        kind: "liked".into(),
        context_uri: Some(ctx.to_string()),
        title: "已点赞的歌曲".into(),
        subtitle: if total > shown { format!("共 {total} 首，这里列出最近的 {shown} 首") } else { String::new() },
        image: None,
        tracks,
        current_uri: None,
        note: None,
    })
}

async fn queue_list(access: &str) -> Result<NowList, String> {
    let v = get_json("https://api.spotify.com/v1/me/player/queue", &[], access, "读取播放队列").await?;
    let mut tracks: Vec<ListTrack> = Vec::new();
    if let Some(cur) = v.get("currently_playing").and_then(list_track) {
        tracks.push(cur);
    }
    if let Some(xs) = v.get("queue").and_then(|x| x.as_array()) {
        tracks.extend(xs.iter().filter_map(list_track));
    }
    Ok(NowList {
        kind: "queue".into(),
        context_uri: None,
        title: "播放队列".into(),
        subtitle: "接下来要播的歌".into(),
        image: None,
        tracks,
        current_uri: None,
        note: None,
    })
}
