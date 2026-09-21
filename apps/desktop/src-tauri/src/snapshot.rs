use objc2_application_services::{AXError, AXUIElement};
use objc2_core_foundation::{CFArray, CFDictionary, CFNumber, CFRetained, CFString, CFType};
use objc2_core_graphics::{kCGWindowNumber, kCGWindowOwnerPID, CGWindowListCopyWindowInfo, CGWindowListOption};
use serde_json::json;
use std::ffi::c_void;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const BROWSERS: &[&str] = &[
    "com.google.Chrome",
    "com.apple.Safari",
    "company.thebrowser.Browser",
    "com.microsoft.edgemac",
];

pub fn capture(screenshot_fallback: bool) -> serde_json::Value {
    let perms = crate::permissions::status();
    let (bundle_id, name, pid) = front_app();
    let title = if perms.accessibility { front_window_title(pid) } else { String::new() };
    let browser = if BROWSERS.contains(&bundle_id.as_str()) { browser_tab(&bundle_id) } else { None };
    let selection = if perms.accessibility { selected_text() } else { None };
    let screenshot_path = if screenshot_fallback && browser.is_none() && selection.is_none() && perms.screen {
        capture_window(pid)
    } else {
        None
    };
    let browser = browser.map(|(url, title, text, errors)| {
        json!({ "url": url, "title": title, "text": text, "errors": if errors.is_empty() { None } else { Some(errors) } })
    });
    json!({
        "at": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64,
        "app": { "bundleId": bundle_id, "name": name, "title": title },
        "browser": browser,
        "selection": selection,
        "screenshotPath": screenshot_path,
        "permissions": perms,
    })
}

fn front_app() -> (String, String, i32) {
    use objc2_app_kit::NSWorkspace;
    let Some(app) = NSWorkspace::sharedWorkspace().frontmostApplication() else {
        return (String::new(), String::new(), 0);
    };
    let bundle_id = app.bundleIdentifier().map(|s| s.to_string()).unwrap_or_default();
    let name = app.localizedName().map(|s| s.to_string()).unwrap_or_default();
    (bundle_id, name, app.processIdentifier())
}

fn front_window_title(pid: i32) -> String {
    if pid <= 0 {
        return String::new();
    }
    let app = unsafe { AXUIElement::new_application(pid) };
    let Some(window) = ax_attribute(&app, "AXFocusedWindow") else {
        return String::new();
    };
    let Some(window) = window.downcast_ref::<AXUIElement>() else {
        return String::new();
    };
    ax_attribute(window, "AXTitle")
        .and_then(|v| v.downcast_ref::<CFString>().map(|s| s.to_string()))
        .unwrap_or_default()
}

fn selected_text() -> Option<String> {
    let system_wide = unsafe { AXUIElement::new_system_wide() };
    let focused = ax_attribute(&system_wide, "AXFocusedUIElement")?;
    let focused = focused.downcast_ref::<AXUIElement>()?;
    let text = ax_attribute(focused, "AXSelectedText")?;
    let text = text.downcast_ref::<CFString>()?.to_string();
    if text.is_empty() {
        return None;
    }
    Some(text.chars().take(8000).collect())
}

fn ax_attribute(element: &AXUIElement, attribute: &str) -> Option<CFRetained<CFType>> {
    let attribute = CFString::from_str(attribute);
    let mut value: *const CFType = std::ptr::null();
    let err = unsafe { element.copy_attribute_value(&attribute, std::ptr::NonNull::from(&mut value)) };
    if err != AXError::Success || value.is_null() {
        return None;
    }
    Some(unsafe { CFRetained::from_raw(std::ptr::NonNull::new(value.cast_mut())?) })
}

// 页面正文 + 此刻可见的报错 + 失败的网络请求，一段 JS 取完。
// 不装全局钩子也不注入长驻脚本——那要改用户的页面；只读这一刻能取到的，
// 所以 console 历史天然拿不到（Apple Events 执行的 JS 看不到之前的 console 记录）。
// 单引号是因为整段要嵌进 AppleScript 的双引号字符串里；换行一律走 String.fromCharCode(10)，
// 写成 \n 会被 AppleScript 先解释成真换行，把 JS 的字符串字面量截断，整段返回 missing value（实测过）。
const PAGE_JS: &str = "(function(){var N=String.fromCharCode(10);var t=document.body.innerText;var e=[];\
document.querySelectorAll('[role=alert],[class*=error],[class*=Error]').forEach(function(n){\
var s=(n.innerText||'').trim();if(s&&s.length<300&&e.indexOf(s)<0)e.push(s)});\
try{performance.getEntriesByType('resource').forEach(function(r){\
if(r.responseStatus>=400)e.push(r.responseStatus+' '+r.name)})}catch(x){}\
return t+N+'---ERRORS---'+N+e.slice(0,10).join(N)})()";

fn browser_tab(bundle_id: &str) -> Option<(String, String, Option<String>, Vec<String>)> {
    let app_name = match bundle_id {
        "com.apple.Safari" => "Safari",
        "com.google.Chrome" => "Google Chrome",
        "company.thebrowser.Browser" => "Arc",
        "com.microsoft.edgemac" => "Microsoft Edge",
        _ => return None,
    };
    // url / title / 正文一次取完：osascript 启动一次就要一两百毫秒，
    // 分两次调用会让呼出从 300ms 掉到 430ms，而这段挡在按键与 HUD 之间。
    // 正文那句用 try 兜住——没开「允许 JavaScript from Apple Events」时它会报错，
    // 那是常态，不该连带把 url 和 title 也弄丢。
    let script = if app_name == "Safari" {
        format!(
            r#"tell application "{app_name}"
  set u to URL of front document
  set t to name of front document
  set b to ""
  try
    set b to (do JavaScript "{PAGE_JS}" in front document)
  end try
  return u & "\n" & t & "\n---BODY---\n" & b
end tell"#
        )
    } else {
        format!(
            r#"tell application "{app_name}"
  set u to URL of active tab of front window
  set t to title of active tab of front window
  set b to ""
  try
    set b to (execute active tab of front window javascript "{PAGE_JS}")
  end try
  return u & "\n" & t & "\n---BODY---\n" & b
end tell"#
        )
    };
    let output = run_with_watchdog("osascript", &["-e", &script], Duration::from_secs(2))?;
    let (head, body) = output.split_once("---BODY---").unwrap_or((output.as_str(), ""));
    let mut lines = head.lines();
    let url = lines.next()?.trim().to_string();
    let title = lines.next().unwrap_or("").trim().to_string();
    if url.is_empty() {
        return None;
    }
    let (body, error_block) = body.split_once("---ERRORS---").unwrap_or((body, ""));
    let errors: Vec<String> = error_block
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .map(|l| l.chars().take(300).collect())
        .collect();
    let collapsed = body.split_whitespace().collect::<Vec<_>>().join(" ");
    eprintln!("[friday] 浏览器抓取：url={} title={} 正文={}字 报错={}条", url.len(), title.len(), collapsed.chars().count(), errors.len());
    let text = if collapsed.is_empty() { None } else { Some(collapsed.chars().take(4000).collect()) };
    Some((url, title, text, errors))
}

fn run_with_watchdog(program: &str, args: &[&str], timeout: Duration) -> Option<String> {
    let mut child = Command::new(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    // 自动化权限被拒最常见，静默失败会让用户完全不知道该去点哪
                    if let Some(mut err) = child.stderr.take() {
                        let mut msg = String::new();
                        use std::io::Read;
                        let _ = err.read_to_string(&mut msg);
                        if !msg.trim().is_empty() {
                            eprintln!("[friday] {program} 失败：{}", msg.trim());
                        }
                    }
                    return None;
                }
                let mut out = String::new();
                use std::io::Read;
                child.stdout.take()?.read_to_string(&mut out).ok()?;
                return Some(out);
            }
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => return None,
        }
    }
}

fn capture_window(pid: i32) -> Option<String> {
    let window_id = window_id_for_pid(pid)?;
    let dir = data_dir().join("summon-shots");
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join(format!("{}.png", uuid::Uuid::new_v4()));
    let status = Command::new("screencapture")
        .args(["-x", "-o", "-l", &window_id.to_string()])
        .arg(&path)
        .status()
        .ok()?;
    if !status.success() || !path.exists() {
        return None;
    }
    prune_old_screenshots(&dir);
    Some(path.to_string_lossy().into_owned())
}

fn window_id_for_pid(pid: i32) -> Option<u32> {
    if pid <= 0 {
        return None;
    }
    let list = CGWindowListCopyWindowInfo(CGWindowListOption::OptionOnScreenOnly, 0)?;
    let array: &CFArray = &list;
    for i in 0..array.count() {
        let dict = unsafe { array.value_at_index(i) };
        if dict.is_null() {
            continue;
        }
        let dict = unsafe { &*(dict as *const CFDictionary) };
        let Some(owner_pid) = cf_dict_i64(dict, unsafe { kCGWindowOwnerPID }) else {
            continue;
        };
        if owner_pid as i32 != pid {
            continue;
        }
        if let Some(number) = cf_dict_i64(dict, unsafe { kCGWindowNumber }) {
            return Some(number as u32);
        }
    }
    None
}

fn cf_dict_i64(dict: &CFDictionary, key: &CFString) -> Option<i64> {
    let key_ptr = key as *const CFString as *const c_void;
    let value = unsafe { dict.value(key_ptr) };
    if value.is_null() {
        return None;
    }
    let number = unsafe { &*(value as *const CFNumber) };
    let mut out: i64 = 0;
    let ok = unsafe { number.value(objc2_core_foundation::CFNumberType::SInt64Type, &mut out as *mut i64 as *mut c_void) };
    ok.then_some(out)
}

fn prune_old_screenshots(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<_> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map(|ext| ext == "png").unwrap_or(false))
        .filter_map(|e| e.metadata().ok().and_then(|m| m.modified().ok()).map(|t| (t, e.path())))
        .collect();
    if files.len() <= 20 {
        return;
    }
    files.sort_by_key(|(t, _)| *t);
    let excess = files.len() - 20;
    for (_, path) in files.into_iter().take(excess) {
        let _ = std::fs::remove_file(path);
    }
}

fn data_dir() -> std::path::PathBuf {
    std::env::var("FRIDAY_DATA_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            dirs_next_home().join("Library/Application Support/Friday")
        })
}

fn dirs_next_home() -> std::path::PathBuf {
    std::env::var("HOME").map(std::path::PathBuf::from).unwrap_or_else(|_| std::path::PathBuf::from("/"))
}
