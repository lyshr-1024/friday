use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

#[derive(Serialize, Default, Clone, Copy)]
pub struct PermissionStatus {
    pub accessibility: bool,
    pub automation: bool,
    pub screen: bool,
}

const CACHE_TTL: Duration = Duration::from_secs(5);

fn cache() -> &'static Mutex<Option<(PermissionStatus, Instant)>> {
    static CACHE: OnceLock<Mutex<Option<(PermissionStatus, Instant)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// `automation_ok()` 每次都要 spawn osascript（约 120ms），挡在热键按下和 HUD 出现之间会明显卡顿；
/// 权限状态几秒内不会变（去系统设置授权需要好几秒，且授权后 HUD 通常已经关了再重开），缓存 5 秒足够。
pub fn status() -> PermissionStatus {
    if let Some((cached, at)) = *cache().lock().unwrap() {
        if at.elapsed() < CACHE_TTL {
            return cached;
        }
    }
    status_fresh()
}

/// 绕过缓存强制重查，给设置页「检查权限」按钮用——用户刚去授权完回来要立刻看到最新状态。
pub fn status_fresh() -> PermissionStatus {
    let fresh = PermissionStatus {
        accessibility: accessibility_trusted(),
        automation: automation_ok(),
        screen: screen_ok(),
    };
    *cache().lock().unwrap() = Some((fresh, Instant::now()));
    fresh
}

fn accessibility_trusted() -> bool {
    unsafe { objc2_application_services::AXIsProcessTrusted() }
}

fn screen_ok() -> bool {
    objc2_core_graphics::CGPreflightScreenCaptureAccess()
}

/// 自动化权限没有纯查询 API，只能试调一次最轻的脚本看成功与否；
/// 首次调用本身可能触发系统授权框，这是 macOS 的行为，无法避免。
/// 用户没有立刻点掉弹框时子进程不会退出，正常探测是毫秒级，超过 2 秒必然是在等用户，
/// 这时 kill 掉并判定为未授权——安全的降级，用户真的授权后下次查询会拿到 true。
fn automation_ok() -> bool {
    let mut child = match std::process::Command::new("osascript")
        .args(["-e", "tell application \"System Events\" to return name of first process"])
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return false,
    };

    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return false;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => return false,
        }
    }
}

pub fn open_pane(kind: &str) {
    let anchor = match kind {
        "accessibility" => "Privacy_Accessibility",
        "automation" => "Privacy_Automation",
        "screen" => "Privacy_ScreenCapture",
        _ => return,
    };
    let _ = std::process::Command::new("open")
        .arg(format!("x-apple.systempreferences:com.apple.preference.security?{anchor}"))
        .spawn();
}
