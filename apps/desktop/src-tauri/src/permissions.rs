use serde::Serialize;
use std::time::{Duration, Instant};

#[derive(Serialize, Default)]
pub struct PermissionStatus {
    pub accessibility: bool,
    pub automation: bool,
    pub screen: bool,
}

pub fn status() -> PermissionStatus {
    PermissionStatus {
        accessibility: accessibility_trusted(),
        automation: automation_ok(),
        screen: screen_ok(),
    }
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
