use serde::Serialize;

/// 当前播放的歌曲。时间单位都是毫秒。
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_ms: i64,
    /// 播放器上次报告的进度
    pub position_ms: i64,
    /// 播放器报告这个进度的时间点（Unix 毫秒）。前端用它插值出实时进度。
    pub updated_at_ms: i64,
    pub playing: bool,
    /// 来源应用，比如 Spotify.exe
    pub source_app: String,
}

impl NowPlaying {
    pub fn track_key(&self) -> String {
        format!("{}\u{1f}{}\u{1f}{}", self.title, self.artist, self.album)
    }
}

/// 专辑封面，data URL 形式，前端直接塞进 <img> 并取色。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Artwork {
    pub track_key: String,
    pub data_url: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub now: Option<NowPlaying>,
    pub artwork: Option<Artwork>,
    pub desktop_locked: bool,
}
