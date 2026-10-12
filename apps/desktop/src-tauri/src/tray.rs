use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use serde::Deserialize;
use tauri::menu::{IconMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Wry};

use crate::tray_art::{self, Frame};
use crate::{sidecar, window};

const TICK: Duration = Duration::from_millis(200);
const POLL_EVERY: u32 = 10;

/// 有事时左键弹清单，没事时左键照旧打开工作台
static MENU_ON_LEFT: AtomicBool = AtomicBool::new(false);

#[derive(Deserialize, Default, PartialEq)]
struct Status {
    state: String,
    count: u32,
    items: Vec<Item>,
    doing: Vec<Doing>,
}

#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Item {
    text: String,
    kind: String,
    task_id: Option<String>,
}

#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Doing {
    task_id: String,
    title: String,
}

pub fn build(app: &AppHandle, hotkey: &str) -> tauri::Result<()> {
    let (icon, template) = tray_art::render(Frame::Idle, false);
    let tray = TrayIconBuilder::with_id("main")
        .icon(icon)
        .icon_as_template(template)
        .menu(&menu(app, hotkey, &Status::default())?)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                if !MENU_ON_LEFT.load(Ordering::Relaxed) {
                    window::show_main(tray.app_handle());
                }
            }
        })
        .on_menu_event(|app, event| {
            let id = event.id.as_ref();
            if let Some(task) = id.strip_prefix("task:") {
                window::open_task(app, task.to_string());
                return;
            }
            match id {
                "settings" => window::open_settings(app),
                "quit" => app.exit(0),
                // 「打开 Friday」和没有任务的行（项目终端、还有 N 件…）都只打开工作台
                _ if id.starts_with("open") => window::show_main(app),
                _ => {}
            }
        })
        .build(app)?;
    let (app, hotkey) = (app.clone(), hotkey.to_string());
    thread::spawn(move || animate(app, tray, hotkey));
    Ok(())
}

fn menu(app: &AppHandle, hotkey: &str, s: &Status) -> tauri::Result<Menu<Wry>> {
    let mut owned: Vec<Box<dyn IsMenuItem<Wry>>> = Vec::new();
    if !s.items.is_empty() {
        owned.push(Box::new(MenuItem::with_id(app, "needs", "需要你", false, None::<&str>)?));
        for (i, it) in s.items.iter().enumerate() {
            let id = it.task_id.as_ref().map_or_else(|| format!("open#{i}"), |t| format!("task:{t}"));
            let color = if it.kind == "asking" { 0xff5f57 } else { 0xf5a623 };
            owned.push(Box::new(IconMenuItem::with_id(app, id, &it.text, true, Some(tray_art::dot(color)), None::<&str>)?));
        }
        owned.push(Box::new(PredefinedMenuItem::separator(app)?));
    }
    if !s.doing.is_empty() {
        let rows = s
            .doing
            .iter()
            .map(|d| MenuItem::with_id(app, format!("task:{}", d.task_id), &d.title, true, None::<&str>))
            .collect::<tauri::Result<Vec<_>>>()?;
        let refs: Vec<&dyn IsMenuItem<Wry>> = rows.iter().map(|r| r as &dyn IsMenuItem<Wry>).collect();
        owned.push(Box::new(Submenu::with_items(app, format!("Friday 在做 {} 件", s.doing.len()), true, &refs)?));
        owned.push(Box::new(PredefinedMenuItem::separator(app)?));
    }
    owned.push(Box::new(MenuItem::with_id(app, "open", "打开 Friday", true, Some(hotkey))?));
    owned.push(Box::new(MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?));
    owned.push(Box::new(PredefinedMenuItem::separator(app)?));
    owned.push(Box::new(MenuItem::with_id(app, "quit", "退出 Friday", true, Some("Cmd+Q"))?));
    let refs: Vec<&dyn IsMenuItem<Wry>> = owned.iter().map(|b| b.as_ref()).collect();
    Menu::with_items(app, &refs)
}

/// 每 200ms 一拍：在干活时青色那格往前走一格，在问你时 F 闪；每 2 秒问一次 core 现在是什么状态
fn animate(app: AppHandle, tray: TrayIcon, hotkey: String) {
    let port = sidecar::port();
    let mut status = Status::default();
    let mut dark = false;
    let mut drawn: Option<(Frame, bool)> = None;
    let mut tick: u32 = 0;
    loop {
        if tick % POLL_EVERY == 0 {
            if let Some(next) = fetch(port).filter(|n| *n != status) {
                let on_left = !next.items.is_empty() || !next.doing.is_empty();
                match menu(&app, &hotkey, &next) {
                    Ok(m) => {
                        let _ = tray.set_menu(Some(m));
                    }
                    Err(e) => eprintln!("[friday] 菜单栏菜单重建失败：{e}"),
                }
                // tray-icon 在 macOS 上 set_title(None) 什么都不做，清掉要传空串
                let _ = tray.set_title(Some(if next.count > 0 { next.count.to_string() } else { String::new() }));
                let _ = tray.set_show_menu_on_left_click(on_left);
                MENU_ON_LEFT.store(on_left, Ordering::Relaxed);
                status = next;
            }
            dark = menubar_dark(&tray);
        }
        let frame = match status.state.as_str() {
            "working" => Frame::Working((tick % 7) as usize),
            "waiting" => Frame::Waiting,
            "asking" => Frame::Asking(tick % 6 != 5),
            _ => Frame::Idle,
        };
        // 空闲是模板图，系统自己按深浅上色，深浅变化不用重画
        let key = (frame, dark && frame != Frame::Idle);
        if drawn != Some(key) {
            let (icon, template) = tray_art::render(frame, dark);
            let _ = tray.set_icon_with_as_template(Some(icon), template);
            drawn = Some(key);
        }
        tick = tick.wrapping_add(1);
        thread::sleep(TICK);
    }
}

/// 菜单栏的深浅跟壁纸走，不一定等于系统外观，看图标按钮自己的外观最准
fn menubar_dark(tray: &TrayIcon) -> bool {
    use objc2_app_kit::NSAppearanceCustomization;
    tray.with_inner_tray_icon(|inner| {
        let Some(item) = inner.ns_status_item() else { return false };
        let Some(mtm) = objc2::MainThreadMarker::new() else { return false };
        item.button(mtm).is_some_and(|b| b.effectiveAppearance().name().to_string().contains("Dark"))
    })
    .unwrap_or(false)
}

fn fetch(port: u16) -> Option<Status> {
    let mut s = TcpStream::connect_timeout(&format!("127.0.0.1:{port}").parse().ok()?, Duration::from_millis(300)).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(1))).ok()?;
    s.write_all(b"GET /tray HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n").ok()?;
    let mut raw = String::new();
    s.read_to_string(&mut raw).ok()?;
    serde_json::from_str(raw.split("\r\n\r\n").nth(1)?).ok()
}
