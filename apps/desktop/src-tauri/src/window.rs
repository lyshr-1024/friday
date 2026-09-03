use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub fn toggle_main(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else { return };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
    } else {
        show_main(app);
    }
}

pub fn show_main(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else { return };
    let _ = win.center();
    let _ = win.show();
    let _ = win.set_focus();
    let _ = app.emit("friday://shown", ());
}

pub fn open_settings(app: &AppHandle) {
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
