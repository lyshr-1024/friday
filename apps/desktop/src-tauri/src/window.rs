use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub fn toggle_main(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else { return };
    let visible = win.is_visible().unwrap_or(false);
    let focused = win.is_focused().unwrap_or(false);
    if visible && focused {
        let _ = win.hide();
    } else {
        show_main(app);
    }
}

pub fn show_main(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else { return };
    // Accessory 应用切到别的 app 后不再是活动应用，只 show + set_focus 拿不到键盘焦点，要先激活自己。
    #[cfg(target_os = "macos")]
    let _ = app.show();
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

pub fn open_settings(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.show();
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("index.html?view=settings".into()))
        .title("Friday 设置")
        .inner_size(480.0, 560.0)
        .resizable(false)
        .center()
        .build();
}
