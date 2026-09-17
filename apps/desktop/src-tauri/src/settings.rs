use std::path::PathBuf;

pub const DEFAULT_HOTKEY: &str = "CmdOrCtrl+Shift+Space";

pub fn is_dev_mode() -> bool {
    std::env::var("FRIDAY_DEV").is_ok_and(|v| v == "1")
}

// FRIDAY_DEV=1 时隔离到 Friday-dev，壳与 sidecar 共用这一处判断：
// 两边各写一份的话，漏了哪边就会一半读 dev 目录一半读生产目录。
pub fn data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("FRIDAY_DATA_DIR") {
        return PathBuf::from(dir);
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let name = if is_dev_mode() { "Friday-dev" } else { "Friday" };
    PathBuf::from(home).join("Library/Application Support").join(name)
}

/// 读 <data_dir>/settings.json 的 "hotkey"，缺失或非法时回退默认值。
pub fn hotkey() -> String {
    std::fs::read_to_string(data_dir().join("settings.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("hotkey")?.as_str().map(str::to_owned))
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_HOTKEY.to_string())
}

/// 读 <data_dir>/settings.json 的 "summon.screenshotFallback"，缺省 true。
pub fn screenshot_fallback() -> bool {
    std::fs::read_to_string(data_dir().join("settings.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("summon")?.get("screenshotFallback")?.as_bool())
        .unwrap_or(true)
}
