use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_nspanel::ManagerExt;

pub struct PendingSummon(pub std::sync::Mutex<Option<serde_json::Value>>);

/// 钉住：失焦不收、再次呼出不挪位置。用户要对着 HUD 干活时需要它待着不动。
pub struct Pinned(pub std::sync::atomic::AtomicBool);

pub fn is_pinned(app: &AppHandle) -> bool {
    app.try_state::<Pinned>()
        .map(|p| p.0.load(std::sync::atomic::Ordering::Relaxed))
        .unwrap_or(false)
}

pub fn set_pinned(app: &AppHandle, on: bool) {
    if let Some(p) = app.try_state::<Pinned>() {
        p.0.store(on, std::sync::atomic::Ordering::Relaxed);
    }
}

const WIDTH: f64 = 560.0;
const HEIGHT: f64 = 420.0;
const CURSOR_GAP: f64 = 16.0;
const EDGE_MARGIN: f64 = 12.0;

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
        position_near_cursor(&win);
    }
}

#[cfg(target_os = "macos")]
fn to_panel(win: &tauri::WebviewWindow) {
    use tauri_nspanel::{cocoa::appkit::NSWindowCollectionBehavior, WebviewWindowExt};

    let Ok(panel) = win.to_panel() else { return };

    const NS_FLOATING_WINDOW_LEVEL: i32 = 3;
    panel.set_level(NS_FLOATING_WINDOW_LEVEL);

    const NS_WINDOW_STYLE_MASK_NON_ACTIVATING_PANEL: i32 = 1 << 7;
    panel.set_style_mask(NS_WINDOW_STYLE_MASK_NON_ACTIVATING_PANEL);

    panel.set_collection_behaviour(
        NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces
            | NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenAuxiliary,
    );
}

#[cfg(not(target_os = "macos"))]
fn to_panel(_win: &tauri::WebviewWindow) {}

fn position_near_cursor(win: &tauri::WebviewWindow) {
    let Ok(Some(monitor)) = win.primary_monitor() else { return };
    let scale = monitor.scale_factor();
    let size = monitor.size().to_logical::<f64>(scale);
    let origin = monitor.position().to_logical::<f64>(scale);

    // 跟着鼠标弹，不用移动目光去屏幕中央找它
    let cursor = win
        .cursor_position()
        .map(|p| p.to_logical::<f64>(scale))
        .unwrap_or(tauri::LogicalPosition::new(origin.x + size.width / 2.0, origin.y + size.height / 2.0));

    // 稍微偏右下，别让面板压住光标本身
    let mut x = cursor.x + CURSOR_GAP;
    let mut y = cursor.y + CURSOR_GAP;

    // 贴边时翻到另一侧，不让面板跑出屏幕
    if x + WIDTH > origin.x + size.width - EDGE_MARGIN {
        x = cursor.x - WIDTH - CURSOR_GAP;
    }
    if y + HEIGHT > origin.y + size.height - EDGE_MARGIN {
        y = cursor.y - HEIGHT - CURSOR_GAP;
    }
    x = x.max(origin.x + EDGE_MARGIN);
    y = y.max(origin.y + EDGE_MARGIN);

    let _ = win.set_position(tauri::LogicalPosition::new(x, y));
}

/// 重新分析当前聚焦的窗口。HUD 是非激活面板，前台一直是用户原来那个 app，
/// 所以直接抓就是对的，不用先隐藏自己。
pub fn resummon(app: &AppHandle) {
    let Some(win) = app.get_webview_window("hud") else { return };
    let snap = crate::snapshot::capture(crate::settings::screenshot_fallback());
    if let Ok(mut pending) = app.state::<PendingSummon>().0.lock() {
        *pending = Some(snap.clone());
    }
    let _ = win.emit("friday://summon", snap);
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
    if !is_pinned(app) {
        position_near_cursor(&win);
    }
    show(app, &win);
    let _ = win.emit("friday://summon", snap);
}

#[cfg(target_os = "macos")]
fn show(app: &AppHandle, win: &tauri::WebviewWindow) {
    if let Ok(panel) = app.get_webview_panel("hud") {
        // show() 内部已经 make_first_responder + make_key_window。
        // 之前加了 set_becomes_key_only_if_needed(true)，它让面板拒绝成为 key window，
        // 结果 HUD 弹出来一个字都打不了——那行已删掉。
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
