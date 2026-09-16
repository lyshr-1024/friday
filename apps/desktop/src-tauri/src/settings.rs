use std::path::PathBuf;

pub const DEFAULT_HOTKEY: &str = "CmdOrCtrl+Shift+Space";

pub fn data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("FRIDAY_DATA_DIR") {
        return PathBuf::from(dir);
    }
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join("Library/Application Support/Friday")
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
