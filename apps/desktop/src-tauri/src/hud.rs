use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_nspanel::ManagerExt;

pub struct PendingSummon(pub std::sync::Mutex<Option<serde_json::Value>>);

const WIDTH: f64 = 560.0;
const HEIGHT: f64 = 420.0;
const TOP_MARGIN: f64 = 120.0;

#[cfg(target_os = "macos")]
struct PriorApp(std::sync::Mutex<Option<objc2::rc::Retained<objc2_app_kit::NSRunningApplication>>>);

pub fn prebuild(app: &AppHandle) {
    if app.get_webview_window("hud").is_some() {
        return;
    }
    #[cfg(target_os = "macos")]
    app.manage(PriorApp(std::sync::Mutex::new(None)));
    let built = WebviewWindowBuilder::new(app, "hud", WebviewUrl::App("index.html?view=hud".into()))
        .title("Friday")
        .inner_size(WIDTH, HEIGHT)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .build();
    if let Ok(win) = built {
        #[cfg(target_os = "macos")]
        to_panel(&win);
        position_top_center(&win);
    }
}

#[cfg(target_os = "macos")]
fn to_panel(win: &tauri::WebviewWindow) {
    use tauri_nspanel::{cocoa::appkit::NSWindowCollectionBehavior, WebviewWindowExt};

    let Ok(panel) = win.to_panel() else { return };

    const NS_FLOATING_WINDOW_LEVEL: i32 = 4;
    panel.set_level(NS_FLOATING_WINDOW_LEVEL);

    const NS_WINDOW_STYLE_MASK_NON_ACTIVATING_PANEL: i32 = 1 << 7;
    panel.set_style_mask(NS_WINDOW_STYLE_MASK_NON_ACTIVATING_PANEL);

    panel.set_collection_behaviour(
        NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces
            | NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenAuxiliary,
    );
    panel.set_becomes_key_only_if_needed(true);
}

#[cfg(not(target_os = "macos"))]
fn to_panel(_win: &tauri::WebviewWindow) {}

fn position_top_center(win: &tauri::WebviewWindow) {
    let Ok(Some(monitor)) = win.primary_monitor() else { return };
    let scale = monitor.scale_factor();
    let size = monitor.size().to_logical::<f64>(scale);
    let pos = monitor.position().to_logical::<f64>(scale);
    let x = pos.x + (size.width - WIDTH) / 2.0;
    let y = pos.y + TOP_MARGIN;
    let _ = win.set_position(tauri::LogicalPosition::new(x, y));
}

pub fn toggle(app: &AppHandle) {
    let Some(win) = app.get_webview_window("hud") else { return };
    if win.is_visible().unwrap_or(false) {
        hide(app);
        return;
    }
    // 快照必须在 HUD 出现之前抓完：兜底截图拍的是"前台 app 的窗口"，
    // 顺序一反就会截到 HUD 自己，用户看到的"我看到了"变成 Friday 自己。
    let fallback = crate::settings::screenshot_fallback();
    let snap = crate::snapshot::capture(fallback);
    if let Ok(mut pending) = app.state::<PendingSummon>().0.lock() {
        *pending = Some(snap.clone());
    }
    position_top_center(&win);
    show(app, &win);
    let _ = win.emit("friday://summon", snap);
}

#[cfg(target_os = "macos")]
fn show(app: &AppHandle, win: &tauri::WebviewWindow) {
    if let Ok(panel) = app.get_webview_panel("hud") {
        // nspanel 是非激活面板，前台 app 不会变，不需要记录/回切。
        panel.show();
        return;
    }
    // 没走通 nspanel 的兜底：普通窗口 show() 会把自己变成前台 app，
    // 记下当前前台 app，隐藏时切回去，抢焦点的时间窗口降到最短。
    use objc2_app_kit::NSWorkspace;
    if let Some(prior) = app.try_state::<PriorApp>() {
        *prior.0.lock().unwrap() = NSWorkspace::sharedWorkspace().frontmostApplication();
    }
    let _ = win.show();
}

#[cfg(not(target_os = "macos"))]
fn show(_app: &AppHandle, win: &tauri::WebviewWindow) {
    let _ = win.show();
}

#[cfg(target_os = "macos")]
pub fn hide(app: &AppHandle) {
    use objc2_app_kit::NSApplicationActivationOptions;

    if let Ok(panel) = app.get_webview_panel("hud") {
        panel.order_out(None);
        return;
    }
    if let Some(win) = app.get_webview_window("hud") {
        let _ = win.hide();
    }
    if let Some(prior) = app.try_state::<PriorApp>() {
        if let Some(prior_app) = prior.0.lock().unwrap().take() {
            // ActivateIgnoringOtherApps 在 macOS 14+ 已弃用且无效果，
            // 激活行为本身现在是默认的，传空 options 即可。
            prior_app.activateWithOptions(NSApplicationActivationOptions(0));
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn hide(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("hud") {
        let _ = win.hide();
    }
}
