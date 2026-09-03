mod env_path;
mod sidecar;
mod tray;
mod window;

use tauri::{ActivationPolicy, Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

const HOTKEY: &str = "Alt+Space";

#[tauri::command]
fn core_base_url() -> String {
    format!("http://127.0.0.1:{}", sidecar::port())
}

#[tauri::command]
fn hide_main(window: tauri::Window) {
    let _ = window.hide();
}

#[tauri::command]
fn open_settings(app: tauri::AppHandle) {
    window::open_settings(&app);
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| window::show_main(app)))
        .plugin(tauri_plugin_notification::init())
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
        .invoke_handler(tauri::generate_handler![core_base_url, hide_main, open_settings])
        .setup(|app| {
            app.set_activation_policy(ActivationPolicy::Accessory);
            tray::build(app.handle())?;
            app.global_shortcut().register(HOTKEY)?;
            app.manage(sidecar::Supervisor::start(app.handle().clone()));
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let WindowEvent::Focused(false) = event {
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            app.state::<sidecar::Supervisor>().shutdown();
        }
    });
}
