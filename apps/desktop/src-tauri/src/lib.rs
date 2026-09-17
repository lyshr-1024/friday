mod env_path;
mod hud;
mod notify;
mod permissions;
mod settings;
mod sidecar;
mod snapshot;
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
    permissions::status_fresh()
}

#[tauri::command]
fn open_permission_pane(kind: String) {
    permissions::open_pane(&kind);
}

#[tauri::command]
fn capture_snapshot(screenshot_fallback: bool) -> serde_json::Value {
    snapshot::capture(screenshot_fallback)
}

/// HUD 前端就位后调用，取回 toggle 时暂存的快照（窗口刚建时 emit 会丢）。
#[tauri::command]
fn take_pending_summon(app: tauri::AppHandle) -> Option<serde_json::Value> {
    app.try_state::<hud::PendingSummon>().and_then(|p| p.0.lock().ok()?.take())
}

/// 重新分析：HUD 开着时前台是 Friday 自己，必须先回到上一个 app 再抓，
/// 否则「我看到了」会变成 Friday 自己的窗口。
#[tauri::command]
fn resummon(app: tauri::AppHandle) {
    hud::resummon(&app);
}

#[tauri::command]
fn set_hud_pinned(app: tauri::AppHandle, pinned: bool) {
    hud::set_pinned(&app, pinned);
}

#[tauri::command]
fn hide_hud(app: tauri::AppHandle) {
    hud::hide(&app);
}

pub fn run() {
    let mut builder = tauri::Builder::default();
    // dev 实例与正式版共用 bundle id，单实例插件会把焦点转给已运行的正式版；
    // FRIDAY_DEV=1 时跳过它，让两者可以同时跑而不互相抢占。
    if !settings::is_dev_mode() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| window::show_main(app)));
    }
    let app = builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_window_state::Builder::new().with_denylist(&["main", "settings", "hud"]).build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_nspanel::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        hud::toggle(app);
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
            open_permission_pane,
            capture_snapshot,
            take_pending_summon,
            hide_hud,
            set_hud_pinned,
            resummon
        ])
        .setup(|app| {
            app.set_activation_policy(ActivationPolicy::Accessory);
            let hotkey = settings::hotkey();
            tray::build(app.handle(), &hotkey)?;
            if let Err(e) = app.global_shortcut().register(hotkey.as_str()) {
                eprintln!("[friday] 注册热键 {hotkey} 失败：{e}");
            }
            app.manage(window::PendingChat(std::sync::Mutex::new(None)));
            app.manage(hud::PendingSummon(std::sync::Mutex::new(None)));
            app.manage(hud::Pinned(std::sync::atomic::AtomicBool::new(false)));
            window::open_chat(app.handle(), None, None);
            hud::prebuild(app.handle());
            app.manage(sidecar::Supervisor::start(app.handle().clone()));
            notify::start(app.handle().clone(), sidecar::port());
            Ok(())
        })
        .on_window_event(|window, event| {
            match (window.label(), event) {
                ("chat", WindowEvent::Destroyed) => window::on_chat_closed(window.app_handle()),
                // 点外面就收起：Raycast 式浮窗的基本手感，不然切回去干活它还浮着挡视线
                ("hud", WindowEvent::Focused(false)) => {
                    if !hud::is_pinned(window.app_handle()) {
                        hud::hide(window.app_handle());
                    }
                }
                _ => {}
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
