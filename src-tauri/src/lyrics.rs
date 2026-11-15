//! 歌词源：网易云音乐优先（有逐字歌词和翻译），找不到再用 LRCLIB。
//!
//! 网易云没有公开的官方接口，这里用的是网页版自己调用的两个接口：
//! - `/api/cloudsearch/pc`：搜歌，海外 IP 也返回明文结果
//! - `/api/song/lyric/v1`：按歌曲 id 取歌词，含 lrc（逐行）、yrc（逐字）、tlyric（翻译）、romalrc（罗马音）
//! 接口如果哪天变了，这里失败会自动退回 LRCLIB，不影响使用。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricsResult {
    /// LRC 格式的逐行同步歌词
    pub synced: Option<String>,
    pub plain: Option<String>,
    /// 网易云 YRC 逐字歌词：`[行开始,行时长](字开始,字时长,0)字…`
    pub yrc: Option<String>,
    /// 翻译歌词，LRC 格式
    pub translation: Option<String>,
    /// 罗马音（日语歌常有），LRC 格式
    pub romaji: Option<String>,
    pub instrumental: bool,
    pub source: String,
}

impl LyricsResult {
    fn has_synced(&self) -> bool {
        self.synced.is_some() || self.yrc.is_some()
    }
    fn has_any(&self) -> bool {
        self.has_synced() || self.plain.is_some() || self.instrumental
    }
}

fn non_empty(s: Option<String>) -> Option<String> {
    s.filter(|s| !s.trim().is_empty())
}

/// 去掉 Spotify 常见的版本后缀，提高命中率，比如 "Song - Remastered 2011"
fn clean_title(title: &str) -> String {
    let lower = title.to_lowercase();
    for marker in [" - remaster", " - live", " - radio edit", " - mono", " - stereo", " - single version", " - original mix"] {
        if let Some(idx) = lower.find(marker) {
            return title[..idx].trim().to_string();
        }
    }
    title.trim().to_string()
}

pub async fn fetch(
    title: &str,
    artist: &str,
    album: &str,
    duration_ms: i64,
) -> Result<Option<LyricsResult>, reqwest::Error> {
    let title = clean_title(title);

    // 1. 网易云：有逐字或逐行歌词就直接用
    let ne = match netease::fetch(&title, artist, duration_ms).await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[lyrics] 网易云失败，改用 LRCLIB：{e}");
            None
        }
    };
    if ne.as_ref().map_or(false, |r| r.has_synced()) {
        return Ok(ne);
    }

    // 2. LRCLIB；网易云只有纯文本（或标了纯音乐）时，LRCLIB 有同步歌词就优先用 LRCLIB
    let lr = lrclib(&title, artist, album, duration_ms).await;
    match lr {
        Ok(Some(r)) if r.has_synced() => Ok(Some(r)),
        Ok(r) => Ok(ne.or(r)),
        Err(e) => {
            if ne.is_some() {
                Ok(ne)
            } else {
                Err(e)
            }
        }
    }
}

// ---------------------------------------------------------------- 手动换歌词

/// "换一个歌词"列表里的一项
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricOption {
    /// "netease" / "lrclib"
    pub source: String,
    pub id: String,
    pub name: String,
    pub artists: String,
    pub duration_ms: i64,
    /// LRCLIB 能提前知道有没有时间轴；网易云要取了才知道，为 None
    pub synced: Option<bool>,
}

/// 网易云和 LRCLIB 各取最多 10 个候选，按和当前歌曲的相似度排好
pub async fn options(title: &str, artist: &str, duration_ms: i64) -> Vec<LyricOption> {
    let title = clean_title(title);
    let mut out = netease::options(&title, artist, duration_ms).await.unwrap_or_default();
    out.extend(lrclib_options(&title, artist).await.unwrap_or_default());
    out
}

/// 按用户选定的候选取歌词
pub async fn fetch_by(source: &str, id: &str) -> Result<Option<LyricsResult>, reqwest::Error> {
    match source {
        "netease" => match id.parse::<i64>() {
            Ok(n) => netease::fetch_by_id(n).await,
            Err(_) => Ok(None),
        },
        "lrclib" => {
            let client = reqwest::Client::builder()
                .user_agent("ingfy/1.0 (desktop lyrics app)")
                .timeout(Duration::from_secs(10))
                .build()?;
            let resp = client.get(format!("https://lrclib.net/api/get/{id}")).send().await?;
            if !resp.status().is_success() {
                return Ok(None);
            }
            let item: LrcLibItem = resp.json().await?;
            let r: LyricsResult = item.into();
            Ok(if r.has_any() { Some(r) } else { None })
        }
        _ => Ok(None),
    }
}

async fn lrclib_options(title: &str, artist: &str) -> Result<Vec<LyricOption>, reqwest::Error> {
    let client = reqwest::Client::builder()
        .user_agent("ingfy/1.0 (desktop lyrics app)")
        .timeout(Duration::from_secs(10))
        .build()?;
    let resp = client
        .get("https://lrclib.net/api/search")
        .query(&[("track_name", title), ("artist_name", artist)])
        .send()
        .await?;
    if !resp.status().is_success() {
        return Ok(vec![]);
    }
    let items: Vec<LrcLibItem> = resp.json().await?;
    Ok(items
        .into_iter()
        .filter(|i| i.id.is_some())
        .take(10)
        .map(|i| LyricOption {
            source: "lrclib".into(),
            id: i.id.unwrap_or_default().to_string(),
            name: i.track_name.clone().unwrap_or_default(),
            artists: i.artist_name.clone().unwrap_or_default(),
            duration_ms: (i.duration.unwrap_or(0.0) * 1000.0) as i64,
            synced: Some(i.synced_lyrics.as_deref().map_or(false, |s| !s.trim().is_empty())),
        })
        .collect())
}

// ---------------------------------------------------------------- LRCLIB

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LrcLibItem {
    id: Option<i64>,
    track_name: Option<String>,
    artist_name: Option<String>,
    synced_lyrics: Option<String>,
    plain_lyrics: Option<String>,
    instrumental: Option<bool>,
    duration: Option<f64>,
}

impl From<LrcLibItem> for LyricsResult {
    fn from(i: LrcLibItem) -> Self {
        LyricsResult {
            synced: non_empty(i.synced_lyrics),
            plain: non_empty(i.plain_lyrics),
            yrc: None,
            translation: None,
            romaji: None,
            instrumental: i.instrumental.unwrap_or(false),
            source: "LRCLIB".into(),
        }
    }
}

async fn lrclib(title: &str, artist: &str, album: &str, duration_ms: i64) -> Result<Option<LyricsResult>, reqwest::Error> {
    let client = reqwest::Client::builder()
        .user_agent("ingfy/1.0 (desktop lyrics app)")
        .timeout(Duration::from_secs(10))
        .build()?;
    let secs = (duration_ms as f64 / 1000.0).round() as i64;

    // 精确匹配
    let mut query: Vec<(&str, String)> = vec![("track_name", title.to_string()), ("artist_name", artist.to_string())];
    if !album.is_empty() {
        query.push(("album_name", album.to_string()));
    }
    if secs > 0 {
        query.push(("duration", secs.to_string()));
    }
    let resp = client.get("https://lrclib.net/api/get").query(&query).send().await?;
    if resp.status().is_success() {
        let item: LrcLibItem = resp.json().await?;
        let result: LyricsResult = item.into();
        if result.has_any() {
            return Ok(Some(result));
        }
    }

    // 模糊搜索，挑时长最接近且有同步歌词的
    let resp = client
        .get("https://lrclib.net/api/search")
        .query(&[("track_name", title), ("artist_name", artist)])
        .send()
        .await?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    let items: Vec<LrcLibItem> = resp.json().await?;
    let best = items
        .into_iter()
        .filter(|i| i.synced_lyrics.as_deref().map_or(false, |s| !s.trim().is_empty()))
        .min_by_key(|i| ((i.duration.unwrap_or(0.0) - secs as f64).abs() * 1000.0) as i64);
    Ok(best.map(Into::into))
}

// ---------------------------------------------------------------- 网易云

mod netease {
    use super::*;

    const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

    struct Candidate {
        id: i64,
        score: f64,
    }

    pub async fn fetch(title: &str, artist: &str, duration_ms: i64) -> Result<Option<LyricsResult>, reqwest::Error> {
        let client = reqwest::Client::builder()
            .user_agent(UA)
            .timeout(Duration::from_secs(8))
            .build()?;

        let artists = split_artists(artist);
        let first_artist = artists.first().cloned().unwrap_or_default();

        // 先用"歌名 歌手"搜；歌手名对不上（比如 Spotify 显示英文名）再只用歌名搜
        let mut queries = vec![format!("{title} {first_artist}").trim().to_string()];
        if !first_artist.is_empty() {
            queries.push(title.to_string());
        }

        let mut tried: Vec<i64> = Vec::new();
        for q in queries {
            let songs = search(&client, &q).await?;
            let mut cands: Vec<Candidate> = songs
                .iter()
                .filter_map(|s| score(s, title, &artists, duration_ms))
                .filter(|c| !tried.contains(&c.id))
                .collect();
            cands.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));

            // 最多试前两首：第一首偶尔没有歌词（比如版权原因没收录）
            for c in cands.into_iter().take(2) {
                tried.push(c.id);
                if let Some(r) = lyric(&client, c.id).await? {
                    return Ok(Some(r));
                }
            }
        }
        Ok(None)
    }

    fn client() -> Result<reqwest::Client, reqwest::Error> {
        reqwest::Client::builder().user_agent(UA).timeout(Duration::from_secs(8)).build()
    }

    pub async fn fetch_by_id(id: i64) -> Result<Option<LyricsResult>, reqwest::Error> {
        lyric(&client()?, id).await
    }

    /// 手动换歌词用：把搜索结果都列出来（不过滤翻唱等），自动匹配会选的排在前面
    pub async fn options(title: &str, artist: &str, duration_ms: i64) -> Result<Vec<LyricOption>, reqwest::Error> {
        let client = client()?;
        let artists = split_artists(artist);
        let first = artists.first().cloned().unwrap_or_default();
        let songs = search(&client, format!("{title} {first}").trim()).await?;
        let mut scored: Vec<(f64, LyricOption)> = songs
            .iter()
            .filter_map(|s| {
                let id = s.get("id")?.as_i64()?;
                let name = s.get("name")?.as_str()?.to_string();
                let ar = s
                    .get("ar")
                    .and_then(|a| a.as_array())
                    .map(|xs| xs.iter().filter_map(|x| x.get("name")?.as_str()).collect::<Vec<_>>().join(" / "))
                    .unwrap_or_default();
                let sc = score(s, title, &artists, duration_ms).map_or(0.0, |c| c.score);
                Some((
                    sc,
                    LyricOption {
                        source: "netease".into(),
                        id: id.to_string(),
                        name,
                        artists: ar,
                        duration_ms: s.get("dt").and_then(|d| d.as_i64()).unwrap_or(0),
                        synced: None,
                    },
                ))
            })
            .collect();
        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        Ok(scored.into_iter().take(10).map(|(_, o)| o).collect())
    }

    async fn search(client: &reqwest::Client, q: &str) -> Result<Vec<Value>, reqwest::Error> {
        let resp = client
            .get("https://music.163.com/api/cloudsearch/pc")
            .header("Referer", "https://music.163.com/")
            .query(&[("s", q), ("type", "1"), ("limit", "20"), ("offset", "0")])
            .send()
            .await?;
        if !resp.status().is_success() {
            return Ok(vec![]);
        }
        let v: Value = resp.json().await?;
        Ok(v.pointer("/result/songs").and_then(|s| s.as_array()).cloned().unwrap_or_default())
    }

    async fn lyric(client: &reqwest::Client, id: i64) -> Result<Option<LyricsResult>, reqwest::Error> {
        let resp = client
            .get("https://music.163.com/api/song/lyric/v1")
            .header("Referer", "https://music.163.com/")
            .query(&[
                ("id", id.to_string()),
                ("lv", "-1".into()),
                ("tv", "-1".into()),
                ("yv", "-1".into()),
                ("kv", "-1".into()),
                ("rv", "-1".into()),
                ("cp", "false".into()),
            ])
            .send()
            .await?;
        if !resp.status().is_success() {
            return Ok(None);
        }
        let v: Value = resp.json().await?;
        let get = |k: &str| non_empty(v.pointer(&format!("/{k}/lyric")).and_then(|s| s.as_str()).map(str::to_string));

        let lrc = get("lrc");
        let yrc = get("yrc").filter(|s| s.lines().any(|l| l.starts_with('[')));
        let translation = get("tlyric").filter(|s| has_time_tags(s));
        let romaji = get("romalrc").filter(|s| has_time_tags(s));
        let instrumental = v.get("nolyric").and_then(|b| b.as_bool()).unwrap_or(false)
            || v.get("pureMusic").and_then(|b| b.as_bool()).unwrap_or(false);

        let (synced, plain) = match lrc {
            Some(l) if has_time_tags(&l) => (Some(l), None),
            Some(l) => (None, Some(l)),
            None => (None, None),
        };
        let r = LyricsResult {
            synced,
            plain,
            yrc,
            translation,
            romaji,
            instrumental,
            source: "网易云音乐".into(),
        };
        Ok(if r.has_any() { Some(r) } else { None })
    }

    fn has_time_tags(s: &str) -> bool {
        s.lines().any(|l| {
            let b = l.as_bytes();
            b.len() > 3 && b[0] == b'[' && b[1].is_ascii_digit()
        })
    }

    /// 给一首搜索结果打分；明显不是这首歌的返回 None
    fn score(song: &Value, title: &str, artists: &[String], duration_ms: i64) -> Option<Candidate> {
        let id = song.get("id")?.as_i64()?;
        let name = song.get("name")?.as_str()?.to_string();

        // 歌名：原名、别名、译名任意一个对上都算
        let mut names = vec![name.clone()];
        for key in ["alia", "tns"] {
            if let Some(arr) = song.get(key).and_then(|a| a.as_array()) {
                names.extend(arr.iter().filter_map(|x| x.as_str().map(str::to_string)));
            }
        }
        let want = norm(&base_title(title));
        if want.is_empty() {
            return None;
        }
        let title_score = names
            .iter()
            .map(|n| {
                let got = norm(&base_title(n));
                if got == want {
                    1.0
                } else if !got.is_empty() && (got.contains(&want) || want.contains(&got)) {
                    0.5
                } else {
                    0.0
                }
            })
            .fold(0.0, f64::max);
        if title_score == 0.0 {
            return None;
        }

        // 歌手：网易云的歌手名、别名、译名，和 Spotify 的任意一位歌手对上
        let mut ne_artists: Vec<String> = Vec::new();
        if let Some(arr) = song.get("ar").and_then(|a| a.as_array()) {
            for a in arr {
                if let Some(n) = a.get("name").and_then(|n| n.as_str()) {
                    ne_artists.push(n.to_string());
                }
                for key in ["alias", "alia", "tns"] {
                    if let Some(xs) = a.get(key).and_then(|x| x.as_array()) {
                        ne_artists.extend(xs.iter().filter_map(|x| x.as_str().map(str::to_string)));
                    }
                }
            }
        }
        let artist_hit = artists.iter().map(|a| norm(a)).filter(|a| !a.is_empty()).any(|a| {
            ne_artists.iter().map(|n| norm(n)).any(|n| {
                !n.is_empty() && (n == a || (n.chars().count() >= 2 && a.contains(&n)) || (a.chars().count() >= 2 && n.contains(&a)))
            })
        });
        let artist_score = if artist_hit { 1.0 } else { 0.0 };

        // 时长：Spotify 和网易云同一版本一般差 1~2 秒
        let dur_score = match song.get("dt").and_then(|d| d.as_i64()) {
            Some(dt) if duration_ms > 0 => {
                let diff = (dt - duration_ms).abs();
                if diff <= 2500 {
                    1.0
                } else if diff <= 6000 {
                    0.5
                } else if diff <= 15000 {
                    0.0
                } else {
                    return None; // 差太多，基本是别的版本
                }
            }
            _ => 0.3,
        };

        // 翻唱、伴奏、Live、DJ 版、变速版这些，除非 Spotify 的歌名里本来就有
        let lower_name = name.to_lowercase();
        let lower_title = title.to_lowercase();
        let mut penalty = 0.0;
        for bad in [
            "翻唱", "原唱", "cover", "伴奏", "纯音乐", "instrumental", "inst.", "live", "现场", "dj", "remix", "女版", "男版",
            "片段", "加速", "降速", "倍速", "sped up", "slowed", "reverb", "钢琴版", "八音盒", "铃声", "karaoke",
        ] {
            if lower_name.contains(bad) && !lower_title.contains(bad) {
                penalty += 1.5;
            }
        }

        // 歌手对不上时，必须歌名完全一致且时长很接近才敢用
        if !artist_hit && !(title_score == 1.0 && dur_score >= 1.0) {
            return None;
        }
        let total = 2.0 * title_score + 2.0 * artist_score + 1.5 * dur_score - penalty;
        if total < 3.0 {
            return None;
        }
        Some(Candidate { id, score: total })
    }

    /// Spotify 的歌手字段可能是 "A, B" / "A & B" / "A feat. B"
    fn split_artists(s: &str) -> Vec<String> {
        let mut out = vec![s.to_string()];
        for sep in [",", "，", "、", "&", ";", "/", " feat. ", " feat ", " ft. ", " x ", " X "] {
            out = out.iter().flat_map(|p| p.split(sep).map(str::to_string).collect::<Vec<_>>()).collect();
        }
        out.into_iter().map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect()
    }

    /// 去掉括号里的说明和 " - xxx" 后缀，只留歌名本体
    fn base_title(s: &str) -> String {
        let mut out = String::new();
        let mut depth = 0i32;
        for ch in s.chars() {
            match ch {
                '(' | '（' | '[' | '【' | '〔' | '「' => depth += 1,
                ')' | '）' | ']' | '】' | '〕' | '」' => depth = (depth - 1).max(0),
                _ if depth == 0 => out.push(ch),
                _ => {}
            }
        }
        if let Some(i) = out.find(" - ") {
            out.truncate(i);
        }
        let trimmed = out.trim();
        if trimmed.is_empty() {
            s.trim().to_string()
        } else {
            trimmed.to_string()
        }
    }

    /// 比较用：全角转半角、转小写、只留字母数字和汉字
    fn norm(s: &str) -> String {
        s.chars()
            .map(|c| {
                let u = c as u32;
                if (0xFF01..=0xFF5E).contains(&u) {
                    char::from_u32(u - 0xFEE0).unwrap_or(c)
                } else {
                    c
                }
            })
            .flat_map(|c| c.to_lowercase())
            .filter(|c| c.is_alphanumeric())
            .collect()
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use serde_json::json;

        #[test]
        fn picks_original_over_cover() {
            let cover = json!({"id": 1, "name": "晴天 (原唱 周杰伦)", "ar": [{"name": "某翻唱"}], "dt": 270738});
            let orig = json!({"id": 2, "name": "晴天", "ar": [{"name": "周杰伦", "tns": ["Jay Chou"]}], "dt": 269000});
            let artists = split_artists("Jay Chou");
            assert!(score(&cover, "晴天", &artists, 269_533).is_none());
            assert!(score(&orig, "晴天", &artists, 269_533).is_some());
        }

        #[test]
        fn helpers() {
            assert_eq!(base_title("Song (Live) - Remastered"), "Song");
            assert_eq!(norm("ＡＢＣ 晴天!"), "abc晴天");
            assert_eq!(split_artists("A, B feat. C"), vec!["A", "B", "C"]);
        }
    }
}
