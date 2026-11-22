//! 和 ingclock（番茄钟）联动：灵动岛上显示番茄、点按钮控制番茄。
//!
//! 两个软件通过 `%APPDATA%\ing-series\` 里的几个小文件互相知道对方的状态。不开端口、不联网。
//! 对方没开，文件就不会更新，超过几秒没更新就当它不在，灵动岛照常只显示音乐。
//!
//! - `ingclock.json`：ingclock 写，这里读。现在是哪一段、还剩多久、当前任务、最近一次到点
//! - `ingfy.json`：这里写，ingclock 读。灵动岛开没开（开着时 ingclock 的小组件让位）
//! - `ingclock-command.json`：这里写，ingclock 读。灵动岛上点了暂停、跳过、开始休息、再专注几分钟
//!
//! 字段的写法和 ingclock 的 src-tauri/src/link.rs 一致，改一边要改另一边。

use serde::Serialize;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

use crate::AppState;

/// ingclock 的文件超过这么久没更新，就当它没开
const FRESH_MS: u64 = 5_000;

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn dir() -> Option<PathBuf> {
    let roaming = std::env::var_os("APPDATA")?;
    Some(PathBuf::from(roaming).join("ing-series"))
}

/// 先写临时文件再改名，对方读的时候不会读到写了一半的内容
fn write_atomic(name: &str, text: &str) -> Result<(), String> {
    let dir = dir().ok_or("找不到数据文件夹")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("{name}.tmp"));
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dir.join(name)).map_err(|e| e.to_string())
}

/// ingclock 现在的状态。它没开（或者好几秒没更新）时是 None。原样交给灵动岛的界面
#[tauri::command]
pub fn ingclock_status() -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(dir()?.join("ingclock.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let updated = value.get("updatedAt")?.as_u64()?;
    (now_ms().saturating_sub(updated) < FRESH_MS).then_some(value)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Command<'a> {
    id: u64,
    at: u64,
    cmd: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    minutes: Option<u32>,
}

/// 灵动岛上点了番茄的按钮：toggle（暂停 / 继续）、skip（跳过这一段）、start（开始下一段）、extend（再专注几分钟）
#[tauri::command]
pub fn ingclock_command(cmd: String, minutes: Option<u32>) -> Result<(), String> {
    if !matches!(cmd.as_str(), "toggle" | "skip" | "start" | "extend") {
        return Err("不认识的番茄命令".into());
    }
    let at = now_ms();
    let text = serde_json::to_string(&Command { id: at, at, cmd: &cmd, minutes }).map_err(|e| e.to_string())?;
    write_atomic("ingclock-command.json", &text).map_err(|_| "没能告诉 ingclock，请再试一次".to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Heartbeat {
    v: u32,
    updated_at: u64,
    island: bool,
}

fn beat(island: bool) {
    if let Ok(text) = serde_json::to_string(&Heartbeat { v: 1, updated_at: now_ms(), island }) {
        let _ = write_atomic("ingfy.json", &text);
    }
}

/// 每两秒告诉 ingclock 一次灵动岛开没开
pub fn spawn_heartbeat(app: AppHandle) {
    std::thread::spawn(move || loop {
        let island = app.state::<AppState>().island.lock().unwrap().visible;
        beat(island);
        std::thread::sleep(Duration::from_secs(2));
    });
}

/// 退出前告诉 ingclock 灵动岛不在了，它的小组件马上就能回来
pub fn goodbye() {
    beat(false);
}
