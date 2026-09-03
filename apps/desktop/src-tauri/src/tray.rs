use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::AppHandle;

use crate::window;

pub fn build(app: &AppHandle, hotkey: &str) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "打开 Friday", true, Some(hotkey))?;
    let settings = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 Friday", true, Some("Cmd+Q"))?;
    let menu = Menu::with_items(app, &[&open, &settings, &PredefinedMenuItem::separator(app)?, &quit])?;

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().unwrap().clone())
        .icon_as_template(true)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => window::show_main(app),
            "settings" => window::open_settings(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}
