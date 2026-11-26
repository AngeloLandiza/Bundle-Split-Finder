//! The local agent: sidecar lifecycle and its supervision, the auth token, and the few HTTP calls the shell makes.

use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use sha2::{Digest, Sha256};

use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
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

// ------------------------------------------------------------------ supervision (Nov 25)
//
// The sidecar is watched through its event receiver. Any exit the shell did not ask for (stop() takes the child out of
// AgentChild first, and sets QUITTING, for Quit and for an update's relaunch) is a crash: the guard is cleared and the
// agent started again on RESTART_DELAYS_MS, at most MAX_RESTARTS times in RESTART_WINDOW_MS. After that the shell stops
// trying, says so in a notification, and the window's banner offers Quit and open again. Port, token and data folder are
// the same on every start; the dead agent's store lock names a dead pid and the next agent takes it over (agent/store.ts).

/// Wait before the 1st, 2nd, 3rd, 4th and 5th restart within the window.
pub const RESTART_DELAYS_MS: [u64; 5] = [0, 2_000, 10_000, 60_000, 60_000];
pub const MAX_RESTARTS: usize = RESTART_DELAYS_MS.len();
pub const RESTART_WINDOW_MS: u64 = 10 * 60_000;

/// The supervisor's next move after a crash at `now_ms`, given every crash time (ms) it has seen, this one included:
/// Some(wait) before the next start, or None when MAX_RESTARTS crashes in RESTART_WINDOW_MS came before this one.
pub fn restart_delay(crashes_ms: &[u64], now_ms: u64) -> Option<Duration> {
  let recent = recent_crashes(crashes_ms, now_ms).max(1);
  RESTART_DELAYS_MS.get(recent - 1).map(|ms| Duration::from_millis(*ms))
}

/// Crashes inside the window, for the agent's SPLIT_FINDER_RESTART (1 for the first restart).
fn recent_crashes(crashes_ms: &[u64], now_ms: u64) -> usize {
  crashes_ms
    .iter()
    .filter(|&&t| t <= now_ms && now_ms - t < RESTART_WINDOW_MS)
    .count()
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Phase {
  /// Started by this shell and not seen to end; or never started (adopted, or a dev agent).
  Running,
  /// Ended unexpectedly; the next start is due at `at` (epoch ms).
  Restarting { at: u64 },
  /// Too many crashes in the window: no more starts until the owner asks (Open Split Finder, or Quit and open again).
  GaveUp,
}

struct Supervisor {
  crashes: Vec<u64>,
  phase: Phase,
}

static SUPERVISOR: Mutex<Supervisor> = Mutex::new(Supervisor { crashes: Vec::new(), phase: Phase::Running });
/// Set by stop(): the app is quitting (or relaunching for an update), so an exit now was asked for.
static QUITTING: AtomicBool = AtomicBool::new(false);

fn now_ms() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

/// What the window's banner reads while the agent does not answer (the `agent_status` command).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
  /// Something answers on the agent's port.
  pub running: bool,
  /// "running", "restarting" or "gaveUp".
  pub phase: &'static str,
  /// Crashes in the last RESTART_WINDOW_MS.
  pub restarts: u32,
  pub max_restarts: u32,
  pub window_minutes: u32,
  /// While restarting: how long until the next start.
  pub next_try_in_ms: Option<u64>,
}

pub fn status() -> AgentStatus {
  let now = now_ms();
  let (phase, restarts) = match SUPERVISOR.lock() {
    Ok(s) => (s.phase, recent_crashes(&s.crashes, now)),
    Err(_) => (Phase::Running, 0),
  };
  AgentStatus {
    running: port_open(),
    phase: match phase {
      Phase::Running => "running",
      Phase::Restarting { .. } => "restarting",
      Phase::GaveUp => "gaveUp",
    },
    restarts: restarts as u32,
    max_restarts: MAX_RESTARTS as u32,
    window_minutes: (RESTART_WINDOW_MS / 60_000) as u32,
    next_try_in_ms: match phase {
      Phase::Restarting { at } => Some(at.saturating_sub(now)),
      _ => None,
    },
  }
}

/// The banner's "Quit and open again": the app relaunches (the Exit event stops the agent first, as Quit does).
#[tauri::command]
pub fn relaunch_app(app: AppHandle) {
  app.request_restart();
}

/// The sidecar ended. Ours and not asked for: clear the guard and start it again on the schedule, or give up.
fn on_exit(app: &AppHandle, pid: u32, code: Option<i32>, signal: Option<i32>) {
  let ours = {
    let state = app.state::<AgentChild>();
    let Ok(mut guard) = state.0.lock() else { return };
    if guard.as_ref().map(|c| c.pid()) == Some(pid) {
      guard.take();
      true
    } else {
      false
    }
  };
  if !ours || QUITTING.load(Ordering::Relaxed) {
    return;
  }
  log::warn!("the agent stopped unexpectedly (exit code {code:?}, signal {signal:?})");
  schedule_restart(app.clone());
}

/// Counts a crash now and either starts the agent after its wait (on a thread of its own) or gives up.
fn schedule_restart(app: AppHandle) {
  let now = now_ms();
  let next = {
    let Ok(mut s) = SUPERVISOR.lock() else { return };
    s.crashes.push(now);
    s.crashes.retain(|&t| now.saturating_sub(t) < RESTART_WINDOW_MS);
    let next = restart_delay(&s.crashes, now);
    s.phase = match next {
      Some(wait) => Phase::Restarting { at: now + wait.as_millis() as u64 },
      None => Phase::GaveUp,
    };
    next.map(|wait| (wait, recent_crashes(&s.crashes, now)))
  };
  let Some((wait, attempt)) = next else {
    log::warn!(
      "the agent stopped {} times in {} minutes; not starting it again",
      MAX_RESTARTS + 1,
      RESTART_WINDOW_MS / 60_000
    );
    crate::shell::notify(
      &app,
      "Split Finder's background agent keeps stopping",
      "Scheduled scans, price checks and Telegram are stopped. Quit Split Finder and open it again.",
      "error",
    );
    return;
  };
  std::thread::spawn(move || {
    std::thread::sleep(wait);
    if QUITTING.load(Ordering::Relaxed) {
      return;
    }
    // The owner may have started it meanwhile (Open Split Finder): spawn_agent then finds it and does nothing.
    match spawn_agent(&app, Some((attempt, now))) {
      Ok(()) => {
        if let Ok(mut s) = SUPERVISOR.lock() {
          if matches!(s.phase, Phase::Restarting { .. }) {
            s.phase = Phase::Running;
          }
        }
        log::info!("the agent was started again (restart {attempt} in the window)");
      }
      Err(e) => {
        log::warn!("could not start the agent again: {e}");
        schedule_restart(app);
      }
    }
  });
}

/// Starts the bundled agent unless something already answers on the port. A listener already
/// there is adopted only when it proves it holds the token (a release build never adopts a stranger).
/// The owner asking (launch, Open Split Finder) also ends a give-up: the count starts over.
pub fn start(app: &AppHandle) -> Result<(), String> {
  if let Ok(mut s) = SUPERVISOR.lock() {
    if s.phase == Phase::GaveUp {
      s.crashes.clear();
      s.phase = Phase::Running;
    }
  }
  spawn_agent(app, None)
}

/// `restart`: the shell's restart count in the window and when the last agent died, handed to the agent so it can say so.
fn spawn_agent(app: &AppHandle, restart: Option<(usize, u64)>) -> Result<(), String> {
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

  // Where Install helper unpacks the extension for Load unpacked: Documents\split-finder. Windows has no
  // HOME (Documents may also be redirected to OneDrive), so the known folder is asked for there.
  #[cfg(not(windows))]
  let extension_dir = std::env::var("HOME")
    .map(|h| PathBuf::from(h).join("Documents").join("split-finder"))
    .unwrap_or_else(|_| data_dir.join("split-finder-extension"));
  #[cfg(windows)]
  let extension_dir = app
    .path()
    .document_dir()
    .map(|d| d.join("split-finder"))
    .unwrap_or_else(|_| data_dir.join("split-finder-extension"));

  let mut sidecar = app
    .shell()
    .sidecar("agent-dashboard")
    .map_err(|e| format!("Agent binary missing (reinstall Split Finder): {e}"))?
    .env("SPLIT_FINDER_DATA_DIR", data_dir)
    .env("SPLIT_FINDER_EXTENSION_DIR", &extension_dir)
    .env("SPLIT_FINDER_APP_VERSION", env!("CARGO_PKG_VERSION"))
    // Whether this build updates itself ("on"), or why not ("dev", "no-key"): Settings says so, and the agent's own look
    // at docs/release.json (a message and a link) is only for a build that cannot.
    .env("SPLIT_FINDER_UPDATER", crate::updater::availability(app))
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

  if let Some((attempt, stopped_at)) = restart {
    sidecar = sidecar
      .env("SPLIT_FINDER_RESTART", attempt.to_string())
      .env("SPLIT_FINDER_STOPPED_AT", stopped_at.to_string());
  }

  let (mut rx, child) = sidecar
    .spawn()
    .map_err(|e| format!("Could not start the agent: {e}"))?;
  let pid = child.pid();
  *guard = Some(child);
  drop(guard);

  // The receiver is kept: its last event says the agent ended, and its output pipes must keep draining.
  let watcher = app.clone();
  tauri::async_runtime::spawn(async move {
    let mut code = None;
    let mut signal = None;
    while let Some(event) = rx.recv().await {
      match event {
        CommandEvent::Terminated(p) => {
          code = p.code;
          signal = p.signal;
        }
        CommandEvent::Error(e) => log::warn!("agent process: {e}"),
        CommandEvent::Stderr(line) => log::debug!("agent: {}", String::from_utf8_lossy(&line).trim_end()),
        _ => {}
      }
    }
    // The channel closes after Terminated (or after an error waiting for the process): either way it has ended.
    on_exit(&watcher, pid, code, signal);
  });
  Ok(())
}

/// Stops the sidecar this app started: SIGTERM first so the agent can finish a write, then kill.
/// Windows has no SIGTERM for a windowless child: the agent is asked over HTTP (POST /api/agent/quit).
pub fn stop(app: &AppHandle) {
  QUITTING.store(true, Ordering::Relaxed);
  let state = app.state::<AgentChild>();
  let Ok(mut guard) = state.0.lock() else { return };
  let Some(child) = guard.take() else { return };
  #[cfg(windows)]
  {
    if http_post(app, "/api/agent/quit").is_ok() {
      for _ in 0..20 {
        if !port_open() {
          break;
        }
        std::thread::sleep(Duration::from_millis(150));
      }
    }
  }
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

/// After an update that did not install (updater.rs): the agent stop() ended is started again, and supervision is back on.
pub fn resume(app: &AppHandle) {
  QUITTING.store(false, Ordering::Relaxed);
  match start(app) {
    Ok(()) => wait_until_up(),
    Err(e) => log::warn!("the agent was not started again after a failed update: {e}"),
  }
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

/// A POST with a JSON body, and the JSON answer (the updater's reports, updater.rs).
pub fn http_post_json(app: &AppHandle, path: &str, body: &serde_json::Value) -> Result<serde_json::Value, String> {
  let res = authed(app, ureq::post(&format!("{AGENT_ORIGIN}{path}")))?
    .timeout(Duration::from_secs(10))
    .set("Content-Type", "application/json")
    .send_string(&body.to_string())
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
  // `client=shell`: the agent keeps the notifications it published while the shell was not listening (after a restart).
  let res = authed(app, ureq::get(&format!("{AGENT_ORIGIN}/api/events?client=shell")))?
    .set("Accept", "text/event-stream")
    .call()
    .map_err(|e| e.to_string())?;
  Ok(res.into_reader())
}

#[cfg(test)]
mod tests {
  use super::*;

  const MIN: u64 = 60_000;

  #[test]
  fn restarts_at_once_then_after_2_10_60_and_60_seconds_then_gives_up() {
    let t0 = 1_000 * MIN;
    let mut crashes = vec![];
    let mut waits = vec![];
    for i in 0..6u64 {
      let now = t0 + i * 1_000;
      crashes.push(now);
      waits.push(restart_delay(&crashes, now).map(|d| d.as_millis() as u64));
    }
    assert_eq!(waits, vec![Some(0), Some(2_000), Some(10_000), Some(60_000), Some(60_000), None]);
  }

  #[test]
  fn crashes_older_than_the_window_do_not_count() {
    let t0 = 1_000 * MIN;
    // Six crashes, the last eleven minutes after the first four: only two are in the window.
    let crashes = [t0, t0 + 1, t0 + 2, t0 + 3, t0 + 9 * MIN, t0 + 11 * MIN];
    assert_eq!(restart_delay(&crashes, t0 + 11 * MIN), Some(Duration::from_millis(2_000)));
    assert_eq!(recent_crashes(&crashes, t0 + 11 * MIN), 2);
    // A crash an hour after five others starts the schedule over.
    let later = [t0, t0 + 1, t0 + 2, t0 + 3, t0 + 4, t0 + 60 * MIN];
    assert_eq!(restart_delay(&later, t0 + 60 * MIN), Some(Duration::ZERO));
  }

  #[test]
  fn the_numbers_the_docs_state() {
    assert_eq!(MAX_RESTARTS, 5);
    assert_eq!(RESTART_WINDOW_MS, 10 * MIN);
    assert_eq!(restart_delay(&[], 0), Some(Duration::ZERO));
  }

  #[test]
  fn hmac_matches_rfc_4231_case_2() {
    let mac = hmac_sha256(b"Jefe", b"what do ya want for nothing?");
    assert_eq!(hex(&mac), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  }
}
