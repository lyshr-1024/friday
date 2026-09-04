mod env_path;
mod settings;
mod sidecar;
mod tray;
mod window;

use std::sync::atomic::{AtomicBool, Ordering};

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

/// 浮窗一旦有过交互就"钉住"：失焦不再自动隐藏，只有 Esc 才收起。
pub struct Pinned(pub AtomicBool);

#[tauri::command]
fn set_pinned(app: tauri::AppHandle, pinned: bool) {
    app.state::<Pinned>().0.store(pinned, Ordering::Relaxed);
}

#[tauri::command]
fn open_settings(app: tauri::AppHandle) {
    window::open_settings(&app);
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| window::show_main(app)))
        .plugin(tauri_plugin_notification::init())
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
        .invoke_handler(tauri::generate_handler![core_base_url, current_hotkey, hide_main, open_settings, set_pinned])
        .setup(|app| {
            app.set_activation_policy(ActivationPolicy::Accessory);
            let hotkey = settings::hotkey();
            tray::build(app.handle(), &hotkey)?;
            if let Err(e) = app.global_shortcut().register(hotkey.as_str()) {
                eprintln!("[friday] 注册热键 {hotkey} 失败：{e}");
            }
            app.manage(Pinned(AtomicBool::new(false)));
            app.manage(sidecar::Supervisor::start(app.handle().clone()));
            if let Some(win) = app.get_webview_window("main") {
                window_vibrancy::apply_vibrancy(
                    &win,
                    window_vibrancy::NSVisualEffectMaterial::Popover,
                    Some(window_vibrancy::NSVisualEffectState::Active),
                    Some(14.0),
                )?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let WindowEvent::Focused(false) = event {
                    let pinned = window.state::<Pinned>().0.load(Ordering::Relaxed);
                    if !pinned {
                        if let Some(win) = window.get_webview_window("main") {
                            window::hide_if_unfocused(win);
                        }
                    }
                }
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
