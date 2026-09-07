use std::io::{Read, Write};
use std::net::TcpStream;
use std::thread;
use std::time::Duration;

use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

/// 每 20 秒从 sidecar 取一次待发通知（Slack 待回复等），用系统通知弹出。
/// core 自己弹不了系统通知，只能由壳代劳。
pub fn start(app: AppHandle, port: u16) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(20));
        for (title, body) in fetch(port) {
            match app.notification().builder().title(&title).body(&body).show() {
                Ok(()) => eprintln!("[friday] 通知已发出：{title}"),
                Err(e) => eprintln!("[friday] 通知发送失败：{e}"),
            }
        }
    });
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
