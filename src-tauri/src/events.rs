//! Subscribes to the agent's server-sent events (`GET /api/events`) and turns them into native
//! notifications and the tray's open-question count. Reconnects with backoff.

use std::io::{BufRead, BufReader};
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::{AppHandle, Manager};

use crate::{agent, shell};

#[derive(Deserialize)]
struct Notify {
  title: String,
  body: String,
  kind: String,
  #[allow(dead_code)]
  count: Option<u32>,
}

pub fn spawn(app: AppHandle) {
  std::thread::spawn(move || {
    let mut backoff = Duration::from_secs(1);
    loop {
      let started = Instant::now();
      match run_once(&app) {
        Ok(()) => log::info!("event stream closed"),
        Err(e) => log::debug!("event stream: {e}"),
      }
      // A stream that stayed up a while was healthy: start the backoff over.
      if started.elapsed() > Duration::from_secs(30) {
        backoff = Duration::from_secs(1);
      }
      std::thread::sleep(backoff);
      backoff = (backoff * 2).min(Duration::from_secs(30));
    }
  });
}

fn run_once(app: &AppHandle) -> Result<(), String> {
  if agent::read_token(app).is_none() {
    return Err("no token yet".into());
  }
  let reader = agent::open_event_stream(app)?;
  // Start from the truth, then follow the stream.
  sync_state(app);

  let mut event = String::new();
  let mut data = String::new();
  let mut last_sync = Instant::now();
  for line in BufReader::new(reader).lines() {
    let line = line.map_err(|e| e.to_string())?;
    if line.is_empty() {
      if !event.is_empty() || !data.is_empty() {
        dispatch(app, &event, &data, &mut last_sync);
      }
      event.clear();
      data.clear();
    } else if let Some(v) = line.strip_prefix("event:") {
      event = v.trim().to_string();
    } else if let Some(v) = line.strip_prefix("data:") {
      if !data.is_empty() {
        data.push('\n');
      }
      data.push_str(v.strip_prefix(' ').unwrap_or(v));
    }
    // Lines starting with ":" are comments (heartbeats); anything else is ignored.
  }
  Ok(())
}

fn dispatch(app: &AppHandle, event: &str, data: &str, last_sync: &mut Instant) {
  match event {
    "notify" => match serde_json::from_str::<Notify>(data) {
      Ok(n) => shell::notify(app, &n.title, &n.body, &n.kind),
      Err(e) => log::warn!("bad notify event: {e}"),
    },
    "state" | "review" => {
      let parsed = serde_json::from_str::<serde_json::Value>(data).ok();
      if !apply_state(app, parsed.as_ref()) && last_sync.elapsed() > Duration::from_secs(2) {
        *last_sync = Instant::now();
        sync_state(app);
      }
    }
    _ => {}
  }
}

/// Reads `counts.review` and `agent.status` from a state payload. Returns false if neither is there.
fn apply_state(app: &AppHandle, v: Option<&serde_json::Value>) -> bool {
  let Some(v) = v else { return false };
  let mut found = false;
  if let Some(n) = v.pointer("/counts/review").and_then(|n| n.as_u64()) {
    shell::set_open_questions(app, n as u32);
    found = true;
  }
  if let Some(s) = v.pointer("/agent/status").and_then(|s| s.as_str()) {
    shell::set_paused(app, s == "paused");
    found = true;
  }
  // The settings changed since the last ones applied: read them again.
  if let Some(at) = v.get("settingsAt").and_then(|s| s.as_str()) {
    let seen = app
      .state::<shell::ShellState>()
      .settings_at
      .lock()
      .ok()
      .and_then(|g| g.clone());
    if seen.as_deref() != Some(at) {
      sync_settings(app);
    }
  }
  found
}

fn sync_settings(app: &AppHandle) {
  match agent::http_get_json(app, "/api/settings") {
    Ok(v) => shell::apply_settings(app, &v),
    Err(e) => log::debug!("settings sync failed: {e}"),
  }
}

fn sync_state(app: &AppHandle) {
  sync_settings(app);
  match agent::http_get_json(app, "/api/state") {
    Ok(v) => {
      apply_state(app, Some(&v));
    }
    Err(e) => log::debug!("state sync failed: {e}"),
  }
}
