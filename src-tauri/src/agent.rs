//! The local agent: sidecar lifecycle, the auth token, and the few HTTP calls the shell makes.

use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

pub const AGENT_PORT: u16 = 8790;
pub const AGENT_ORIGIN: &str = "http://127.0.0.1:8790";
/// Where the dashboard (React app) lives. The agent redirects "/" here.
pub const UI_URL: &str = "http://127.0.0.1:8790/ui/";
/// The agent writes its bearer token here (inside the app-data dir). One constant, one place.
/// The agent (W1) may rename it; change only this line.
pub const TOKEN_FILE: &str = "agent-token";

pub struct AgentChild(pub Mutex<Option<CommandChild>>);

pub fn port_open() -> bool {
  TcpStream::connect_timeout(
    &format!("127.0.0.1:{AGENT_PORT}").parse().expect("parse addr"),
    Duration::from_millis(400),
  )
  .is_ok()
}

pub fn wait_until_up() {
  for _ in 0..80 {
    if port_open() {
      return;
    }
    std::thread::sleep(Duration::from_millis(250));
  }
}

pub fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
  app.path().app_data_dir().map_err(|e| e.to_string())
}

/// The bearer token, or None while the agent has not written it yet.
pub fn read_token(app: &AppHandle) -> Option<String> {
  let path = data_dir(app).ok()?.join(TOKEN_FILE);
  let raw = std::fs::read_to_string(path).ok()?;
  let token = raw.trim().to_string();
  if token.is_empty() {
    None
  } else {
    Some(token)
  }
}

/// The source checkout, for developer-only features (revealing the built extension zip).
/// An env var, or the current directory (or its parent, because `tauri dev` runs in src-tauri).
/// There is no fallback to a fixed path.
pub fn dev_repo_root() -> Option<PathBuf> {
  if let Ok(home) = std::env::var("SPLIT_FINDER_HOME") {
    let p = PathBuf::from(home);
    if p.join("package.json").is_file() {
      return Some(p);
    }
  }
  let cwd = std::env::current_dir().ok()?;
  [Some(cwd.clone()), cwd.parent().map(Path::to_path_buf)]
    .into_iter()
    .flatten()
    .find(|p| p.join("package.json").is_file() && p.join("src-tauri").is_dir())
}

pub fn extension_zip_in_repo(root: &Path) -> Option<PathBuf> {
  find_chrome_zip(&root.join("output"))
}

pub fn extension_zip_in_resources(app: &AppHandle) -> Option<PathBuf> {
  find_chrome_zip(&app.path().resource_dir().ok()?)
}

fn find_chrome_zip(dir: &Path) -> Option<PathBuf> {
  std::fs::read_dir(dir)
    .ok()?
    .filter_map(|e| e.ok())
    .map(|e| e.path())
    .find(|p| {
      p.extension().is_some_and(|x| x == "zip")
        && p
          .file_name()
          .and_then(|n| n.to_str())
          .is_some_and(|n| n.contains("chrome"))
    })
}

/// Starts the bundled agent unless something already answers on the port (a dev agent).
pub fn start(app: &AppHandle) -> Result<(), String> {
  if port_open() {
    return Ok(());
  }
  let state = app.state::<AgentChild>();
  let mut guard = state.0.lock().map_err(|_| "agent lock poisoned".to_string())?;
  if guard.is_some() {
    return Ok(());
  }
  let data_dir = data_dir(app)?;
  std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;

  let extension_dir = std::env::var("HOME")
    .map(|h| PathBuf::from(h).join("Documents").join("split-finder"))
    .unwrap_or_else(|_| data_dir.join("split-finder-extension"));

  let mut sidecar = app
    .shell()
    .sidecar("agent-dashboard")
    .map_err(|e| format!("Agent binary missing (reinstall Split Finder): {e}"))?
    .env("SPLIT_FINDER_DATA_DIR", data_dir)
    .env("SPLIT_FINDER_EXTENSION_DIR", &extension_dir)
    .env("AGENT_PORT", AGENT_PORT.to_string());

  if let Some(zip) = extension_zip_in_resources(app) {
    sidecar = sidecar.env("SPLIT_FINDER_EXTENSION_ZIP", zip);
  }
  if let Ok(resource) = app.path().resource_dir() {
    let ui = resource.join("ui");
    if ui.exists() {
      sidecar = sidecar.env("SPLIT_FINDER_UI_DIR", ui);
    }
  }

  let (_rx, child) = sidecar
    .spawn()
    .map_err(|e| format!("Could not start the agent: {e}"))?;
  *guard = Some(child);
  Ok(())
}

/// Stops the sidecar this app started: SIGTERM first so the agent can finish a write, then kill.
pub fn stop(app: &AppHandle) {
  let state = app.state::<AgentChild>();
  let Ok(mut guard) = state.0.lock() else { return };
  let Some(child) = guard.take() else { return };
  #[cfg(unix)]
  {
    let _ = std::process::Command::new("kill")
      .args(["-TERM", &child.pid().to_string()])
      .status();
    for _ in 0..20 {
      if !port_open() {
        return;
      }
      std::thread::sleep(Duration::from_millis(150));
    }
  }
  let _ = child.kill();
}

fn authed(app: &AppHandle, req: ureq::Request) -> ureq::Request {
  match read_token(app) {
    Some(t) => req.set("Authorization", &format!("Bearer {t}")),
    None => req,
  }
}

pub fn http_get_json(app: &AppHandle, path: &str) -> Result<serde_json::Value, String> {
  let res = authed(app, ureq::get(&format!("{AGENT_ORIGIN}{path}")))
    .timeout(Duration::from_secs(5))
    .call()
    .map_err(|e| e.to_string())?;
  serde_json::from_reader(res.into_reader()).map_err(|e| e.to_string())
}

pub fn http_post(app: &AppHandle, path: &str) -> Result<(), String> {
  authed(app, ureq::post(&format!("{AGENT_ORIGIN}{path}")))
    .timeout(Duration::from_secs(10))
    .set("Content-Type", "application/json")
    .send_string("{}")
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Opens the event stream. No read timeout: the stream is idle between events.
pub fn open_event_stream(app: &AppHandle) -> Result<Box<dyn std::io::Read + Send + Sync>, String> {
  let res = authed(app, ureq::get(&format!("{AGENT_ORIGIN}/api/events")))
    .set("Accept", "text/event-stream")
    .call()
    .map_err(|e| e.to_string())?;
  Ok(res.into_reader())
}
