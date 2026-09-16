mod env_path;
mod notify;
mod permissions;
mod settings;
mod sidecar;
mod tray;
mod window;

use tauri::{ActivationPolicy, Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

#[tauri::command]
fn core_base_url() -> String {
    format!("http://127.0.0.1:{}", sidecar::port())
}

#[tauri::command]
fn current_hotkey() -> String {
    settings::hotkey()
}

#[tauri::command]
fn hide_main(window: tauri::Window) {
    let _ = window.hide();
}

#[tauri::command]
fn open_chat(app: tauri::AppHandle, conversation_id: Option<String>, initial_prompt: Option<String>) {
    window::open_chat(&app, conversation_id, initial_prompt);
}

/// 会话窗前端就位后调用，取回 open_chat 时暂存的参数（窗口刚建时 emit 会丢）。
#[tauri::command]
fn take_pending_chat(app: tauri::AppHandle) -> Option<serde_json::Value> {
    app.try_state::<window::PendingChat>().and_then(|p| p.0.lock().ok()?.take())
}

#[tauri::command]
fn open_settings(app: tauri::AppHandle) {
    window::open_settings(&app);
}

#[tauri::command]
fn permission_status() -> permissions::PermissionStatus {
    permissions::status()
}

#[tauri::command]
fn open_permission_pane(kind: String) {
    permissions::open_pane(&kind);
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| window::show_main(app)))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_window_state::Builder::new().with_denylist(&["main", "settings"]).build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        window::toggle_main(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            core_base_url,
            current_hotkey,
            hide_main,
            open_settings,
            open_chat,
            take_pending_chat,
            permission_status,
            open_permission_pane
        ])
        .setup(|app| {
            app.set_activation_policy(ActivationPolicy::Accessory);
            let hotkey = settings::hotkey();
            tray::build(app.handle(), &hotkey)?;
            if let Err(e) = app.global_shortcut().register(hotkey.as_str()) {
                eprintln!("[friday] 注册热键 {hotkey} 失败：{e}");
            }
            app.manage(window::PendingChat(std::sync::Mutex::new(None)));
            window::open_chat(app.handle(), None, None);
            app.manage(sidecar::Supervisor::start(app.handle().clone()));
            notify::start(app.handle().clone(), sidecar::port());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let ("chat", WindowEvent::Destroyed) = (window.label(), event) {
                window::on_chat_closed(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| match event {
        RunEvent::Exit => app.state::<sidecar::Supervisor>().shutdown(),
        // 启动台 / Dock / `open -a Friday` 再次点击
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => window::show_main(app),
        _ => {}
    });
}
