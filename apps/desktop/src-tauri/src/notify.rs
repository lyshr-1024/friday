use std::io::{Read, Write};
use std::net::TcpStream;
use std::thread;
use std::time::Duration;

use tauri::AppHandle;

struct Notice {
    title: String,
    body: String,
    task_id: Option<String>,
}

/// 每 20 秒从 sidecar 取一次待发通知（Slack 待回复等），用系统通知弹出。
/// core 自己弹不了系统通知，只能由壳代劳。
pub fn start(app: AppHandle, port: u16) {
    if !cfg!(debug_assertions) {
        un::listen_clicks(app.clone());
    }
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(20));
        for n in fetch(port) {
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || show(&handle, n));
        }
    });
}

/// macOS 26 起 Tauri 通知插件底层的 NSUserNotification 已失效（返回成功但不显示），
/// 打包运行时直接走 UNUserNotificationCenter；dev 模式没有 bundle，退回插件（收不到点击，dev 点通知不会定位任务）。
fn show(app: &AppHandle, n: Notice) {
    if cfg!(debug_assertions) {
        use tauri_plugin_notification::NotificationExt;
        let r = app.notification().builder().title(&n.title).body(&n.body).show();
        log(&format!("dev 通知 {}: {r:?}", n.title));
        return;
    }
    un::show(&n.title, &n.body, n.task_id.as_deref());
    log(&format!("通知已提交 UNUserNotificationCenter：{}", n.title));
}

mod un {
    use std::sync::OnceLock;

    use block2::{DynBlock, RcBlock};
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{define_class, msg_send, ClassType};
    use objc2_foundation::{NSError, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotificationRequest, UNNotificationResponse, UNNotificationSound,
        UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };
    use tauri::AppHandle;

    // 任务 id 编进通知标识（`friday-<毫秒>:<taskId>`），点开时从 response 里读回来
    const TASK_SEP: char = ':';

    static APP: OnceLock<AppHandle> = OnceLock::new();

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "FridayNotificationDelegate"]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl UNUserNotificationCenterDelegate for Delegate {
            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive(&self, _center: &UNUserNotificationCenter, response: &UNNotificationResponse, done: &DynBlock<dyn Fn()>) {
                let id = response.notification().request().identifier().to_string();
                let task_id = id.split_once(TASK_SEP).map(|(_, t)| t.to_string()).filter(|t| !t.is_empty());
                super::log(&format!("点开通知 {id}"));
                if let Some(app) = APP.get() {
                    match task_id {
                        Some(t) => crate::window::open_task(app, t),
                        None => crate::window::show_main(app),
                    }
                }
                done.call(());
            }
        }
    );

    /// center 对 delegate 是弱引用，得一直持有
    pub fn listen_clicks(app: AppHandle) {
        let _ = APP.set(app);
        let delegate: Retained<Delegate> = unsafe { msg_send![Delegate::class(), new] };
        UNUserNotificationCenter::currentNotificationCenter().setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        std::mem::forget(delegate);
    }

    pub fn show(title: &str, body: &str, task_id: Option<&str>) {
        let title = NSString::from_str(title);
        let body = NSString::from_str(body);
        let task_id = task_id.map(|t| format!("{TASK_SEP}{t}")).unwrap_or_default();
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
                let id = NSString::from_str(&format!("friday-{}{task_id}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)));
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

fn fetch(port: u16) -> Vec<Notice> {
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
        .filter_map(|n| {
            Some(Notice {
                title: n.get("title")?.as_str()?.to_string(),
                body: n.get("body")?.as_str()?.to_string(),
                task_id: n.get("taskId").and_then(|t| t.as_str()).map(str::to_string),
            })
        })
        .collect()
}

/// 打包后的壳没有可见的 stderr，通知结果写到记忆库目录的 logs/shell.log 便于排查。
pub fn log(line: &str) {
    eprintln!("[friday] {line}");
    let path = crate::settings::data_dir().join("logs").join("shell.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let _ = writeln!(f, "{ts} {line}");
    }
}
