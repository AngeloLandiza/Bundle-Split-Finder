//! The local agent: sidecar lifecycle, the auth token, and the few HTTP calls the shell makes.

use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use sha2::{Digest, Sha256};

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

/// What the window and the log say when the port answers but cannot prove it is our agent.
pub const PORT_TAKEN: &str = "Another program is using port 8790";

fn hex(bytes: &[u8]) -> String {
  bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// HMAC-SHA256 (RFC 2104) over sha2, so no crate beyond the one the lock file already has.
fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
  const BLOCK: usize = 64;
  let mut k = [0u8; BLOCK];
  if key.len() > BLOCK {
    k[..32].copy_from_slice(&Sha256::digest(key));
  } else {
    k[..key.len()].copy_from_slice(key);
  }
  let mut ipad = [0x36u8; BLOCK];
  let mut opad = [0x5cu8; BLOCK];
  for i in 0..BLOCK {
    ipad[i] ^= k[i];
    opad[i] ^= k[i];
  }
  let inner = Sha256::new().chain_update(ipad).chain_update(msg).finalize();
  Sha256::new().chain_update(opad).chain_update(inner).finalize().into()
}

fn same_bytes(a: &[u8], b: &[u8]) -> bool {
  a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The challenge (agent/auth.ts helloProof): a fresh random nonce, and the listener must answer
/// HMAC-SHA256(token, "split-finder-hello:" + nonce). Only the nonce goes out; never the token.
fn listener_proves(token: &str) -> bool {
  let mut buf = [0u8; 32];
  if getrandom::fill(&mut buf).is_err() {
    return false;
  }
  let nonce = hex(&buf);
  let expected = hex(&hmac_sha256(token.as_bytes(), format!("split-finder-hello:{nonce}").as_bytes()));
  let Ok(res) = ureq::get(&format!("{AGENT_ORIGIN}/api/hello"))
    .query("nonce", &nonce)
    .timeout(Duration::from_secs(3))
    .call()
  else {
    return false;
  };
  let Ok(body) = serde_json::from_reader::<_, serde_json::Value>(res.into_reader()) else {
    return false;
  };
  body
    .get("proof")
    .and_then(|v| v.as_str())
    .is_some_and(|p| same_bytes(p.as_bytes(), expected.as_bytes()))
}

static DEV_SKIP_LOGGED: AtomicBool = AtomicBool::new(false);

/// The token, only once whatever listens on the port proved it holds it. Release builds ask every
/// time (a listener can change between calls); dev builds skip the challenge with a log line, because
/// `tauri dev` adopts a dev agent that may be an older build.
pub fn proven_token(app: &AppHandle) -> Option<String> {
  let token = read_token(app)?;
  if cfg!(debug_assertions) {
    if !DEV_SKIP_LOGGED.swap(true, Ordering::Relaxed) {
      log::info!("dev build: the agent on {AGENT_ORIGIN} is trusted without the hello challenge");
    }
    return Some(token);
  }
  if listener_proves(&token) {
    Some(token)
  } else {
    log::warn!("{PORT_TAKEN}: the listener did not prove it holds the agent token");
    None
  }
}

/// Starts the bundled agent unless something already answers on the port. A listener already
/// there is adopted only when it proves it holds the token (a release build never adopts a stranger).
pub fn start(app: &AppHandle) -> Result<(), String> {
  if port_open() {
    return match proven_token(app) {
      Some(_) => Ok(()),
      None => Err(PORT_TAKEN.to_string()),
    };
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

/// A request carrying the token, or an error when the listener has not proved it is our agent.
fn authed(app: &AppHandle, req: ureq::Request) -> Result<ureq::Request, String> {
  match proven_token(app) {
    Some(t) => Ok(req.set("Authorization", &format!("Bearer {t}"))),
    None => Err(if port_open() { PORT_TAKEN.to_string() } else { "the agent is not running".to_string() }),
  }
}

pub fn http_get_json(app: &AppHandle, path: &str) -> Result<serde_json::Value, String> {
  let res = authed(app, ureq::get(&format!("{AGENT_ORIGIN}{path}")))?
    .timeout(Duration::from_secs(5))
    .call()
    .map_err(|e| e.to_string())?;
  serde_json::from_reader(res.into_reader()).map_err(|e| e.to_string())
}

pub fn http_post(app: &AppHandle, path: &str) -> Result<(), String> {
  authed(app, ureq::post(&format!("{AGENT_ORIGIN}{path}")))?
    .timeout(Duration::from_secs(10))
    .set("Content-Type", "application/json")
    .send_string("{}")
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Opens the event stream. No read timeout: the stream is idle between events.
pub fn open_event_stream(app: &AppHandle) -> Result<Box<dyn std::io::Read + Send + Sync>, String> {
  let res = authed(app, ureq::get(&format!("{AGENT_ORIGIN}/api/events")))?
    .set("Accept", "text/event-stream")
    .call()
    .map_err(|e| e.to_string())?;
  Ok(res.into_reader())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn hmac_matches_rfc_4231_case_2() {
    let mac = hmac_sha256(b"Jefe", b"what do ya want for nothing?");
    assert_eq!(hex(&mac), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  }
}
