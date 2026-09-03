use std::path::PathBuf;
use std::process::Command;

const MARKER: &str = "__FRIDAY_PATH__";

/// Finder / 开机自启拉起的进程 PATH 极简，用登录 shell 取用户真实 PATH。
pub fn login_shell_path() -> String {
    let out = Command::new("/bin/zsh")
        .args(["-ilc", &format!("printf '{MARKER}%s' \"$PATH\"")])
        .output();
    let parsed = out.ok().and_then(|o| {
        let s = String::from_utf8_lossy(&o.stdout);
        s.rsplit_once(MARKER).map(|(_, p)| p.trim().to_string())
    });
    match parsed {
        Some(p) if !p.is_empty() => p,
        _ => fallback_path(),
    }
}

fn fallback_path() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let current = std::env::var("PATH").unwrap_or_default();
    format!("{home}/.local/bin:{home}/.volta/bin:/opt/homebrew/bin:/usr/local/bin:{current}")
}

pub fn find_in_path(bin: &str, path: &str) -> Option<PathBuf> {
    path.split(':')
        .map(|dir| PathBuf::from(dir).join(bin))
        .find(|p| p.is_file())
}
