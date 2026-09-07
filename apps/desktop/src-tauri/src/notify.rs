use std::io::{Read, Write};
use std::net::TcpStream;
use std::thread;
use std::time::Duration;

use tauri::AppHandle;

/// 每 20 秒从 sidecar 取一次待发通知（Slack 待回复等），用系统通知弹出。
/// core 自己弹不了系统通知，只能由壳代劳。
pub fn start(app: AppHandle, port: u16) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(20));
        for (title, body) in fetch(port) {
            let handle = app.clone();
            // UN 接口要在主线程调。
            let _ = app.run_on_main_thread(move || show(&handle, title, body));
        }
    });
}

/// macOS 26 起 Tauri 通知插件底层的 NSUserNotification 已失效（返回成功但不显示），
/// 打包运行时直接走 UNUserNotificationCenter；dev 模式没有 bundle，退回插件。
fn show(app: &AppHandle, title: String, body: String) {
    if cfg!(debug_assertions) {
        use tauri_plugin_notification::NotificationExt;
        let r = app.notification().builder().title(&title).body(&body).show();
        log(&format!("dev 通知 {title}: {r:?}"));
        return;
    }
    un::show(&title, &body);
    log(&format!("通知已提交 UNUserNotificationCenter：{title}"));
}

mod un {
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSError, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotificationRequest, UNNotificationSound, UNUserNotificationCenter,
    };

    pub fn show(title: &str, body: &str) {
        let title = NSString::from_str(title);
        let body = NSString::from_str(body);
        unsafe {
            let center = UNUserNotificationCenter::currentNotificationCenter();
            let handler = RcBlock::new(move |granted: Bool, err: *mut NSError| {
                if !granted.as_bool() {
                    super::log(&format!("通知未获授权 err={:?}", err.as_ref().map(|e| e.localizedDescription().to_string())));
                    return;
                }
                let content = UNMutableNotificationContent::new();
                content.setTitle(&title);
                content.setBody(&body);
                content.setSound(Some(&UNNotificationSound::defaultSound()));
                let id = NSString::from_str(&format!("friday-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)));
                let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&id, &content, None);
                let done = RcBlock::new(|err: *mut NSError| {
                    if let Some(e) = err.as_ref() {
                        super::log(&format!("通知提交失败：{}", e.localizedDescription()));
                    }
                });
                UNUserNotificationCenter::currentNotificationCenter().addNotificationRequest_withCompletionHandler(&request, Some(&done));
            });
            center.requestAuthorizationWithOptions_completionHandler(UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound, &handler);
        }
    }
}

fn fetch(port: u16) -> Vec<(String, String)> {
    let Ok(mut s) = TcpStream::connect_timeout(&format!("127.0.0.1:{port}").parse().unwrap(), Duration::from_millis(500)) else {
        return vec![];
    };
    let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
    if s.write_all(b"GET /notifications HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n").is_err() {
        return vec![];
    }
    let mut raw = String::new();
    let _ = s.read_to_string(&mut raw);
    let Some(body) = raw.split("\r\n\r\n").nth(1) else { return vec![] };
    let Ok(list) = serde_json::from_str::<Vec<serde_json::Value>>(body) else { return vec![] };
    list.iter()
        .filter_map(|n| Some((n.get("title")?.as_str()?.to_string(), n.get("body")?.as_str()?.to_string())))
        .collect()
}

/// 打包后的壳没有可见的 stderr，通知结果写到记忆库目录的 logs/shell.log 便于排查。
fn log(line: &str) {
    eprintln!("[friday] {line}");
    let path = crate::settings::data_dir().join("logs").join("shell.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let _ = writeln!(f, "{ts} {line}");
    }
}
