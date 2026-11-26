//! Self-update (Nov 25, docs/decisions.md "The app updates itself from GitHub releases").
//!
//! A minute after launch, then every 6 hours, the shell reads latest.json from the project's newest GitHub release over
//! HTTPS, and when it names a newer version it downloads that version's file in the background. tauri-plugin-updater
//! verifies the file against the public key built into the app (plugins.updater.pubkey) and, with requireSignedVersion,
//! that the signature was made for the version announced; a file that fails is never kept. The verified bytes wait in
//! memory. Every 20 s the shell offers them to the agent (POST /api/update/pending), which answers whether to install now
//! (core/src/release/update.ts installDecision: the owner's setting or his Install now, nothing running, no scheduled scan
//! about to start). To install, the shell stops the agent the way Quit does (agent::stop), installs, and starts again. A
//! failure keeps the running version and is said once in Activity; nothing is tried again before the next look.
//!
//! All of it is here, in Rust: it runs with no window open. No page may call the updater (no updater permission in any
//! capability). Debug builds and builds without a public key never update; the agent hears why (SPLIT_FINDER_UPDATER).

use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::agent;

/// The one address updates come from. tauri.conf.json names the same (a test in core/test/release-update.test.ts compares).
pub const ENDPOINT: &str = "https://github.com/AngeloLandiza/Bundle-Split-Finder/releases/latest/download/latest.json";
/// An update file must be one of this project's release files.
const RELEASE_FILES: &str = "/AngeloLandiza/Bundle-Split-Finder/releases/download/";
/// GitHub sends a release download from github.com on to its file hosts; a redirect anywhere else is refused.
const GITHUB_HOSTS: [&str; 3] = ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"];
pub const FIRST_CHECK_AFTER: Duration = Duration::from_secs(60);
pub const CHECK_EVERY: Duration = Duration::from_secs(21600);
/// How often a downloaded update is offered to the agent (and how soon after Install now it starts).
const TICK: Duration = Duration::from_secs(20);
/// One request (latest.json, or the whole download) may take this long.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// "Look for new versions" and "Install new versions automatically", as the last settings read said (shell::apply_settings).
/// 0: not read yet (nothing is requested before they are), 1: on, 2: off.
static LOOKING: AtomicU8 = AtomicU8::new(0);
static AUTOMATIC: AtomicU8 = AtomicU8::new(0);
/// Set while an install runs: nothing else is offered or checked.
static INSTALLING: AtomicBool = AtomicBool::new(false);

/// A downloaded update whose signature was verified, waiting to be installed.
struct Pending {
  update: Update,
  bytes: Vec<u8>,
}
static PENDING: Mutex<Option<Pending>> = Mutex::new(None);

fn tri(on: bool) -> u8 {
  if on {
    1
  } else {
    2
  }
}

/// The settings the shell read from the agent (Settings, General).
pub fn apply_settings(looking: bool, automatic: bool) {
  LOOKING.store(tri(looking), Ordering::Relaxed);
  AUTOMATIC.store(tri(automatic), Ordering::Relaxed);
}

/// Why this build cannot update itself ("dev", "no-key"), or None when it can. The agent shows it in Settings.
pub fn unavailable(app: &AppHandle) -> Option<&'static str> {
  if cfg!(debug_assertions) {
    return Some("dev");
  }
  let key = app
    .config()
    .plugins
    .0
    .get("updater")
    .and_then(|u| u.get("pubkey"))
    .and_then(|k| k.as_str())
    .unwrap_or("");
  if key.trim().is_empty() {
    return Some("no-key");
  }
  None
}

/// What the agent is told at start (SPLIT_FINDER_UPDATER): "on", or why not.
pub fn availability(app: &AppHandle) -> &'static str {
  unavailable(app).unwrap_or("on")
}

/// A URL the updater may be redirected to: https, one of GitHub's hosts, no user name, password or port.
pub fn redirect_allowed(url: &str) -> bool {
  let Ok(u) = Url::parse(url) else { return false };
  u.scheme() == "https"
    && u.username().is_empty()
    && u.password().is_none()
    && u.port().is_none()
    && u.host_str().is_some_and(|h| GITHUB_HOSTS.contains(&h))
}

/// The update file latest.json names must be one of this project's release files on github.com, over https.
pub fn download_allowed(url: &str) -> bool {
  let Ok(u) = Url::parse(url) else { return false };
  u.scheme() == "https"
    && u.host_str() == Some("github.com")
    && u.username().is_empty()
    && u.password().is_none()
    && u.port().is_none()
    && u.query().is_none()
    && u.path().starts_with(RELEASE_FILES)
    && !u.path().contains("..")
    && !url.contains('\\')
}

fn now_ms() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

/// Starts the updater's thread, unless this build cannot update itself.
pub fn spawn(app: AppHandle) {
  if let Some(why) = unavailable(&app) {
    log::info!("updates: not in this build ({why})");
    return;
  }
  std::thread::spawn(move || {
    // Wall-clock time, so a Mac that slept still looks 6 hours after the last look, not 6 hours of being awake.
    let mut next_check = now_ms() + FIRST_CHECK_AFTER.as_millis() as u64;
    loop {
      std::thread::sleep(TICK);
      if INSTALLING.load(Ordering::Relaxed) {
        continue;
      }
      if LOOKING.load(Ordering::Relaxed) == 2 {
        // Turned off: nothing is requested, and a download that waits is let go.
        if let Ok(mut g) = PENDING.lock() {
          g.take();
        }
      }
      // Until the settings have been read (0) the look waits for them, tick by tick; off (2) skips this turn.
      let looking = LOOKING.load(Ordering::Relaxed);
      if now_ms() >= next_check && looking != 0 {
        next_check = now_ms() + CHECK_EVERY.as_millis() as u64;
        if looking == 1 {
          look(&app);
        }
      }
      offer(&app);
    }
  });
}

enum Found {
  Current,
  Held,
  Downloaded(Box<Update>, Vec<u8>),
}

fn error_text(e: impl std::fmt::Display) -> String {
  e.to_string()
}

/// One look at latest.json and, when it names a newer version than the one running and than the one waiting, its download.
async fn fetch(app: &AppHandle) -> Result<Found, String> {
  let endpoint = Url::parse(ENDPOINT).map_err(error_text)?;
  let updater = app
    .updater_builder()
    .endpoints(vec![endpoint])
    .map_err(error_text)?
    .timeout(REQUEST_TIMEOUT)
    // Newer only, never a downgrade or the same version again (the plugin's default, said here so it cannot change).
    .version_comparator(|current, release| release.version > current)
    .configure_client(|client| {
      client
        .https_only(true)
        .user_agent("SplitFinder")
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
          if attempt.previous().len() >= 10 {
            attempt.error("too many redirects")
          } else if redirect_allowed(attempt.url().as_str()) {
            attempt.follow()
          } else {
            attempt.error("a redirect left GitHub")
          }
        }))
    })
    .build()
    .map_err(error_text)?;
  let Some(update) = updater.check().await.map_err(error_text)? else {
    return Ok(Found::Current);
  };
  if !download_allowed(update.download_url.as_str()) {
    return Err("latest.json names an update file that is not one of this project's GitHub releases".to_string());
  }
  let held = PENDING
    .lock()
    .ok()
    .and_then(|g| g.as_ref().map(|p| p.update.version.clone()));
  if held.as_deref() == Some(update.version.as_str()) {
    return Ok(Found::Held);
  }
  // download() verifies the signature (and the signed version) before it returns the bytes.
  let bytes = update.download(|_, _| {}, || {}).await.map_err(error_text)?;
  Ok(Found::Downloaded(Box::new(update), bytes))
}

fn look(app: &AppHandle) {
  match tauri::async_runtime::block_on(fetch(app)) {
    Ok(Found::Current) => report(app, "current", ""),
    Ok(Found::Held) => {}
    Ok(Found::Downloaded(update, bytes)) => {
      log::info!("updates: {} downloaded and verified", update.version);
      if let Ok(mut g) = PENDING.lock() {
        *g = Some(Pending { update: *update, bytes });
      }
    }
    Err(e) => {
      log::warn!("updates: {e}");
      report(app, "failed", &e);
    }
  }
}

/// A look's outcome, for Settings ("Last checked") and, when it failed, one sentence in Activity.
fn report(app: &AppHandle, outcome: &str, why: &str) {
  let body = serde_json::json!({ "outcome": outcome, "why": why });
  if let Err(e) = agent::http_post_json(app, "/api/update/report", &body) {
    log::debug!("updates: the agent did not take the report: {e}");
  }
}

/// Offers the waiting update to the agent, and installs it when the agent says now.
fn offer(app: &AppHandle) {
  let (version, notes) = {
    let Ok(g) = PENDING.lock() else { return };
    let Some(p) = g.as_ref() else { return };
    (p.update.version.clone(), p.update.body.clone().unwrap_or_default())
  };
  let body = serde_json::json!({ "version": version, "notes": notes });
  let now = match agent::http_post_json(app, "/api/update/pending", &body) {
    Ok(answer) => answer.get("install").and_then(|v| v.as_bool()) == Some(true),
    // An agent that gave up after repeated crashes runs nothing: an automatic update may go ahead (it may be the fix).
    Err(_) => {
      agent::status().phase == "gaveUp"
        && LOOKING.load(Ordering::Relaxed) == 1
        && AUTOMATIC.load(Ordering::Relaxed) == 1
    }
  };
  if now {
    install(app);
  }
}

/// Stops the agent as Quit does, installs, and starts the new version. On failure: the agent again, on this version.
fn install(app: &AppHandle) {
  let Some(p) = PENDING.lock().ok().and_then(|mut g| g.take()) else { return };
  INSTALLING.store(true, Ordering::Relaxed);
  log::info!("updates: installing {}", p.update.version);
  agent::stop(app);
  // Windows: install() starts the installer (passive, /UPDATE, /R to start the app again) and ends this process.
  match p.update.install(&p.bytes) {
    Ok(()) => app.restart(),
    Err(e) => {
      log::warn!("updates: installing {} failed: {e}", p.update.version);
      // The agent starts again on this version; it finds its note that an install began and says in Activity that it did
      // not finish. No retry before the next look.
      agent::resume(app);
      INSTALLING.store(false, Ordering::Relaxed);
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn redirects_stay_on_github_over_https() {
    assert!(redirect_allowed("https://github.com/AngeloLandiza/Bundle-Split-Finder/releases/download/v0.2.0/latest.json"));
    assert!(redirect_allowed("https://release-assets.githubusercontent.com/github-production-release-asset/1/2?x=y"));
    assert!(redirect_allowed("https://objects.githubusercontent.com/x"));
    for bad in [
      "http://github.com/x",
      "https://github.com.evil.example/x",
      "https://evil.example/github.com",
      "https://user@github.com/x",
      "https://github.com:8443/x",
      "https://raw.githubusercontent.com/x",
      "file:///etc/passwd",
      "not a url",
    ] {
      assert!(!redirect_allowed(bad), "{bad}");
    }
  }

  #[test]
  fn only_this_projects_release_files_are_downloaded() {
    assert!(download_allowed(
      "https://github.com/AngeloLandiza/Bundle-Split-Finder/releases/download/v0.2.0/Split-Finder-Windows-x64-setup.exe"
    ));
    for bad in [
      "http://github.com/AngeloLandiza/Bundle-Split-Finder/releases/download/v0.2.0/x.exe",
      "https://github.com/someone/Bundle-Split-Finder/releases/download/v0.2.0/x.exe",
      "https://github.com/AngeloLandiza/Bundle-Split-Finder-evil/releases/download/v0.2.0/x.exe",
      "https://github.com/AngeloLandiza/Bundle-Split-Finder/raw/main/x.exe",
      "https://github.com/AngeloLandiza/Bundle-Split-Finder/releases/download/v0.2.0/x.exe?y=1",
      "https://user@github.com/AngeloLandiza/Bundle-Split-Finder/releases/download/v0.2.0/x.exe",
      "https://release-assets.githubusercontent.com/AngeloLandiza/Bundle-Split-Finder/releases/download/v0.2.0/x.exe",
      "https://evil.example/AngeloLandiza/Bundle-Split-Finder/releases/download/v0.2.0/x.exe",
    ] {
      assert!(!download_allowed(bad), "{bad}");
    }
  }

  #[test]
  fn the_numbers_the_docs_state() {
    assert_eq!(FIRST_CHECK_AFTER, Duration::from_secs(60));
    assert_eq!(CHECK_EVERY, Duration::from_secs(6 * 3600));
  }
}
