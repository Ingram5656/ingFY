//! Windows 系统媒体传输控件（SMTC）：读取正在播放、控制播放。
//! Spotify、网易云、QQ 音乐、浏览器等只要接入了系统媒体控件都能读到。

use crate::media::NowPlaying;
use base64::Engine;
use windows::core::Result;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as Manager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
};
use windows::Storage::Streams::DataReader;

/// WinRT 的 TimeSpan / DateTime 单位是 100 纳秒
const TICKS_PER_MS: i64 = 10_000;
/// 1601-01-01 到 1970-01-01 的毫秒数
const EPOCH_DIFF_MS: i64 = 11_644_473_600_000;

/// 每个调用 WinRT 的线程先初始化一次（多线程套间）。重复调用无害。
pub fn init_thread() {
    unsafe {
        let _ = windows::Win32::System::WinRT::RoInitialize(
            windows::Win32::System::WinRT::RO_INIT_MULTITHREADED,
        );
    }
}

pub fn manager() -> Result<Manager> {
    Manager::RequestAsync()?.get()
}

pub fn current_session(manager: &Manager) -> Option<Session> {
    manager.GetCurrentSession().ok()
}

pub fn read_now_playing(session: &Session) -> Result<NowPlaying> {
    let props = session.TryGetMediaPropertiesAsync()?.get()?;
    let timeline = session.GetTimelineProperties()?;
    let info = session.GetPlaybackInfo()?;

    let start = timeline.StartTime()?.Duration / TICKS_PER_MS;
    let end = timeline.EndTime()?.Duration / TICKS_PER_MS;
    let position = timeline.Position()?.Duration / TICKS_PER_MS;
    let updated = timeline.LastUpdatedTime()?.UniversalTime / TICKS_PER_MS - EPOCH_DIFF_MS;

    Ok(NowPlaying {
        title: props.Title()?.to_string(),
        artist: props.Artist()?.to_string(),
        album: props.AlbumTitle()?.to_string(),
        duration_ms: (end - start).max(0),
        position_ms: (position - start).max(0),
        updated_at_ms: updated,
        playing: info.PlaybackStatus()? == Status::Playing,
        source_app: session.SourceAppUserModelId()?.to_string(),
    })
}

/// 读取封面并转成 data URL。没有封面时返回 Ok(None)。
pub fn read_artwork(session: &Session) -> Result<Option<String>> {
    let props = session.TryGetMediaPropertiesAsync()?.get()?;
    let thumb = match props.Thumbnail() {
        Ok(t) => t,
        Err(_) => return Ok(None),
    };
    let stream = thumb.OpenReadAsync()?.get()?;
    let size = stream.Size()? as u32;
    if size == 0 {
        return Ok(None);
    }
    let reader = DataReader::CreateDataReader(&stream)?;
    reader.LoadAsync(size)?.get()?;
    let mut buf = vec![0u8; size as usize];
    reader.ReadBytes(&mut buf)?;

    let mime = stream
        .ContentType()
        .map(|s| s.to_string())
        .unwrap_or_default();
    let mime = if mime.is_empty() { "image/png".to_string() } else { mime };
    let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
    Ok(Some(format!("data:{mime};base64,{b64}")))
}

/// action: "toggle" | "next" | "previous"
pub fn control(action: &str) -> Result<bool> {
    let session = manager()?.GetCurrentSession()?;
    let op = match action {
        "toggle" => session.TryTogglePlayPauseAsync()?,
        "next" => session.TrySkipNextAsync()?,
        "previous" => session.TrySkipPreviousAsync()?,
        _ => return Ok(false),
    };
    op.get()
}

/// 跳转到指定位置（毫秒）
pub fn seek(position_ms: i64) -> Result<bool> {
    let session = manager()?.GetCurrentSession()?;
    session
        .TryChangePlaybackPositionAsync(position_ms.max(0) * TICKS_PER_MS)?
        .get()
}
