use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::env_path;

const MAX_RESTARTS: u32 = 3;
const STABLE_RUN: Duration = Duration::from_secs(60);

pub fn port() -> u16 {
    std::env::var("FRIDAY_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(if crate::settings::is_dev_mode() { 7799 } else { 7788 })
}

#[derive(Default)]
struct Inner {
    child: Option<Child>,
    shutting_down: bool,
}

pub struct Supervisor {
    inner: Arc<Mutex<Inner>>,
}

impl Supervisor {
    pub fn start(app: AppHandle) -> Self {
        let inner = Arc::new(Mutex::new(Inner::default()));
        let worker = inner.clone();
        thread::spawn(move || run_loop(app, worker));
        Self { inner }
    }

    pub fn shutdown(&self) {
        let mut g = self.inner.lock().unwrap();
        g.shutting_down = true;
        if let Some(child) = g.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        g.child = None;
    }
}

fn run_loop(app: AppHandle, inner: Arc<Mutex<Inner>>) {
    let port = port();
    if health_ok(port) {
        eprintln!("[friday] sidecar 已在 {port} 端口运行，直接连接");
        return;
    }

    let path = env_path::login_shell_path();
    let Some(node) = env_path::find_in_path("node", &path) else {
        notify(&app, "找不到 node，请确认已安装并在登录 shell 的 PATH 中");
        return;
    };
    let core_dir = core_dir(&app);
    eprintln!("[friday] node={} core_dir={}", node.display(), core_dir.display());

    let mut restarts = 0u32;
    loop {
        if inner.lock().unwrap().shutting_down {
            return;
        }
        let child = spawn(&node, &core_dir, &path, port);
        let child = match child {
            Ok(c) => c,
            Err(e) => {
                notify(&app, &format!("sidecar 启动失败：{e}"));
                return;
            }
        };
        let started = Instant::now();
        inner.lock().unwrap().child = Some(child);

        let status = loop {
            thread::sleep(Duration::from_millis(500));
            let mut g = inner.lock().unwrap();
            if g.shutting_down {
                return;
            }
            match g.child.as_mut().and_then(|c| c.try_wait().ok().flatten()) {
                Some(status) => break status,
                None => continue,
            }
        };
        inner.lock().unwrap().child = None;

        if started.elapsed() > STABLE_RUN {
            restarts = 0;
        }
        restarts += 1;
        if restarts > MAX_RESTARTS {
            notify(&app, &format!("sidecar 连续崩溃 {MAX_RESTARTS} 次（{status}），已停止重试"));
            return;
        }
        notify(&app, &format!("sidecar 退出（{status}），正在重启 {restarts}/{MAX_RESTARTS}"));
        thread::sleep(Duration::from_secs(2 * restarts as u64));
    }
}

fn core_dir(app: &AppHandle) -> PathBuf {
    if let Ok(dir) = std::env::var("FRIDAY_CORE_DIR") {
        return PathBuf::from(dir);
    }
    if cfg!(debug_assertions) {
        return PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../core");
    }
    app.path()
        .resource_dir()
        .map(|d| d.join("core"))
        .expect("resource dir")
}

fn spawn(node: &PathBuf, core_dir: &PathBuf, path: &str, port: u16) -> std::io::Result<Child> {
    let mut cmd = Command::new(node);
    if cfg!(debug_assertions) {
        cmd.args(["--import", "tsx", "src/index.ts"]);
    } else {
        cmd.arg("dist/index.js");
    }
    cmd.current_dir(core_dir).env("PATH", path).env("FRIDAY_PORT", port.to_string());
    cmd.env("FRIDAY_DATA_DIR", crate::settings::data_dir());
    // 从 Finder 启动时没有终端，inherit 等于把日志丢掉——出了问题只能靠猜。落一份文件。
    let log_dir = std::path::Path::new(&crate::settings::data_dir()).join("logs");
    let _ = std::fs::create_dir_all(&log_dir);
    let log_path = log_dir.join("core.log");
    // 每次启动前超过 5MB 就清掉，免得跑几个月变成几百兆
    if std::fs::metadata(&log_path).map(|m| m.len() > 5 * 1024 * 1024).unwrap_or(false) {
        let _ = std::fs::remove_file(&log_path);
    }
    let (out, err) = match std::fs::OpenOptions::new().create(true).append(true).open(&log_path) {
        Ok(f) => match f.try_clone() {
            Ok(f2) => (Stdio::from(f), Stdio::from(f2)),
            Err(_) => (Stdio::inherit(), Stdio::inherit()),
        },
        Err(_) => (Stdio::inherit(), Stdio::inherit()),
    };
    cmd.stdin(Stdio::null()).stdout(out).stderr(err).spawn()
}

pub fn health_ok(port: u16) -> bool {
    let Ok(mut s) = TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().unwrap(),
        Duration::from_millis(300),
    ) else {
        return false;
    };
    let _ = s.set_read_timeout(Some(Duration::from_millis(500)));
    if s.write_all(b"GET /health HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n").is_err() {
        return false;
    }
    let mut buf = String::new();
    let _ = s.read_to_string(&mut buf);
    buf.starts_with("HTTP/1.") && buf.contains("\"ok\":true")
}

fn notify(app: &AppHandle, body: &str) {
    eprintln!("[friday] {body}");
    let _ = app.notification().builder().title("Friday").body(body).show();
}
