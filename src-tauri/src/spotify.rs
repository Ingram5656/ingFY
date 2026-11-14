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
const SCOPES: &str = "user-library-read user-library-modify user-follow-read user-follow-modify \
playlist-read-private playlist-modify-public user-read-currently-playing user-read-playback-state";
/// 判断旧登录是否缺少新接口需要的权限
const REQUIRED_SCOPE: &str = "playlist-modify-public";

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
        !self.scope.split_whitespace().any(|s| s == REQUIRED_SCOPE)
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
