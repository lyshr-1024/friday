use tauri::{ActivationPolicy, AppHandle, Emitter, Manager, TitleBarStyle, WebviewUrl, WebviewWindowBuilder};

pub fn show_main(app: &AppHandle) {
    open_chat(app, None, None);
}

/// 打开工作台窗口；带会话参数时前端会在抽屉里接上。
pub fn open_chat(app: &AppHandle, conversation_id: Option<String>, initial_prompt: Option<String>) {
    let payload = serde_json::json!({ "conversationId": conversation_id, "initialPrompt": initial_prompt });
    if let Ok(mut pending) = app.state::<PendingChat>().0.lock() {
        *pending = Some(payload.clone());
    }
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(ActivationPolicy::Regular);
    activate(app);
    if let Some(win) = app.get_webview_window("chat") {
        let _ = win.show();
        let _ = win.set_focus();
        if conversation_id.is_some() || initial_prompt.is_some() {
            let _ = win.emit("friday://open-conversation", payload);
        }
        return;
    }
    let built = WebviewWindowBuilder::new(app, "chat", WebviewUrl::App("index.html".into()))
        .title("Friday")
        .inner_size(1180.0, 760.0)
        .min_inner_size(820.0, 520.0)
        .title_bar_style(TitleBarStyle::Overlay)
        .hidden_title(true)
        // 关掉 Tauri 的原生拖放：它开着就会吃掉 WebView 的 HTML5 drop 事件，
        // 前端 .thread 上的 onDrop 永远收不到，往对话里拖文件没反应（浏览器里调试却是好的）。
        .disable_drag_drop_handler()
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
