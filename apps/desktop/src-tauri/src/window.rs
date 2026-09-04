use std::thread;
use std::time::Duration;

use tauri::{ActivationPolicy, AppHandle, Emitter, Manager, TitleBarStyle, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub fn toggle_main(app: &AppHandle) {
    // 会话窗开着且没聚焦时，热键优先把会话窗带回来；其余情况切换启动器。
    if let Some(chat) = app.get_webview_window("chat") {
        if chat.is_visible().unwrap_or(false) && !chat.is_focused().unwrap_or(false) {
            activate(app);
            let _ = chat.set_focus();
            return;
        }
    }
    let Some(win) = app.get_webview_window("main") else { return };
    if win.is_visible().unwrap_or(false) && win.is_focused().unwrap_or(false) {
        let _ = win.hide();
    } else {
        show_main(app);
    }
}

pub fn show_main(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else { return };
    activate(app);
    let _ = win.center();
    let _ = win.show();
    let _ = win.set_focus();
    let _ = app.emit("friday://shown", ());
}

/// 失焦即隐藏，但显示瞬间可能先收到一次假的失焦事件，延迟一拍再确认。
pub fn hide_if_unfocused(win: WebviewWindow) {
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(150));
        if !win.is_focused().unwrap_or(true) {
            let _ = win.hide();
        }
    });
}

/// 打开会话窗并让它加载指定会话；`initial_prompt` 由前端在加载后立即发送。
pub fn open_chat(app: &AppHandle, conversation_id: Option<String>, initial_prompt: Option<String>) {
    let payload = serde_json::json!({ "conversationId": conversation_id, "initialPrompt": initial_prompt });
    if let Ok(mut pending) = app.state::<PendingChat>().0.lock() {
        *pending = Some(payload.clone());
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.hide();
    }
    // 会话窗开着时才有 Dock 图标，能 ⌘Tab 切回来；关掉后退回菜单栏应用。
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(ActivationPolicy::Regular);
    activate(app);
    if let Some(win) = app.get_webview_window("chat") {
        let _ = win.show();
        let _ = win.set_focus();
        // 已开着的窗口直接收事件；刚创建的窗口前端就位后自己调 take_pending_chat 取。
        let _ = win.emit("friday://open-conversation", payload);
        return;
    }
    let built = WebviewWindowBuilder::new(app, "chat", WebviewUrl::App("index.html?view=chat".into()))
        .title("Friday")
        .inner_size(920.0, 640.0)
        .min_inner_size(640.0, 440.0)
        .title_bar_style(TitleBarStyle::Overlay)
        .hidden_title(true)
        .center()
        .build();
    if let Ok(win) = built {
        let _ = win.set_focus();
    }
}

pub struct PendingChat(pub std::sync::Mutex<Option<serde_json::Value>>);

pub fn on_chat_closed(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(ActivationPolicy::Accessory);
}

pub fn open_settings(app: &AppHandle) {
    activate(app);
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("index.html?view=settings".into()))
        .title("Friday 设置")
        .inner_size(560.0, 640.0)
        .min_inner_size(480.0, 520.0)
        .center()
        .build();
}

fn activate(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.show();
}
