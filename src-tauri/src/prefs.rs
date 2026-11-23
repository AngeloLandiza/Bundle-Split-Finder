//! The Preferences window (docs/design.md, Desktop app > Preferences): one instance, about 720pt wide, a
//! title bar carrying the toolbar of tabs, loading the same UI bundle at `#/preferences/<tab>`. The page
//! draws the toolbar (there is no NSToolbar in a webview) and tells the shell how tall its pane is, so the
//! window fits it; the width does not change.

use serde::Serialize;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, LogicalSize, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::{agent, shell};

pub const LABEL: &str = "preferences";

/// The tabs, in the toolbar's order. The page and this list name them the same.
const TABS: [&str; 8] = [
  "general",
  "scanning",
  "keys",
  "ai",
  "notifications",
  "chrome",
  "data",
  "advanced",
];

const WIDTH: f64 = 720.0;
const MIN_HEIGHT: f64 = 320.0;
const MAX_HEIGHT: f64 = 820.0;
const START_HEIGHT: f64 = 560.0;

/// The tab named, or "general" for anything else: the name goes into a page address.
fn tab_or_default(tab: Option<&str>) -> &'static str {
  tab
    .and_then(|t| TABS.iter().find(|known| **known == t))
    .copied()
    .unwrap_or("general")
}

fn address(tab: &str) -> String {
  format!("{}#/preferences/{}", agent::UI_URL, tab)
}

/// Opens the Preferences window on a tab, or brings the open one forward and switches it to the tab.
pub fn open(app: &AppHandle, tab: Option<&str>) -> Result<(), String> {
  let tab = tab_or_default(tab);
  if let Some(window) = app.get_webview_window(LABEL) {
    let _ = window.eval(&format!("window.location.hash = '#/preferences/{tab}';"));
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    return Ok(());
  }
  // The page loads, and gets the token, only once the listener on the port proved it holds it (the
  // same rule as the main window). Otherwise the main window's message says what is wrong.
  let Some(token) = agent::proven_token(app) else {
    shell::show_window(app);
    return Err("The agent is not running.".to_string());
  };
  let url = tauri::Url::parse(&address(tab)).map_err(|e| e.to_string())?;
  let builder = shell::webview_options(WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(url)))
    .title("Settings")
    .inner_size(WIDTH, START_HEIGHT)
    // The height is the pane's; the width never changes.
    .min_inner_size(WIDTH, MIN_HEIGHT)
    .max_inner_size(WIDTH, MAX_HEIGHT)
    .maximizable(false)
    .fullscreen(false)
    .center()
    .visible(false)
    .initialization_script(shell::init_script(Some(&token), shell::mica()))
    // Shown once the page has painted, so a dark Mac never flashes a white window.
    .on_page_load(|w, payload| {
      if payload.event() == PageLoadEvent::Finished {
        let _ = w.show();
        let _ = w.set_focus();
      }
    });
  chrome(builder).build().map_err(|e| e.to_string())?;
  Ok(())
}

/// A unified title bar with the title hidden: the page's toolbar of tabs sits in it, and the traffic
/// lights sit in the first 28pt, as in System Settings' predecessors. No sidebar material here.
fn chrome<'a>(
  builder: WebviewWindowBuilder<'a, tauri::Wry, AppHandle>,
) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
  #[cfg(target_os = "macos")]
  {
    use tauri::{LogicalPosition, TitleBarStyle};
    builder
      .title_bar_style(TitleBarStyle::Overlay)
      .hidden_title(true)
      .traffic_light_position(LogicalPosition::new(20.0, 14.0))
  }
  // Windows: the standard title bar ("Settings"), with Mica on Windows 11 as the main window has.
  #[cfg(not(target_os = "macos"))]
  {
    shell::mica_window(builder)
  }
}

fn window(app: &AppHandle) -> Result<WebviewWindow, String> {
  app
    .get_webview_window(LABEL)
    .ok_or_else(|| "The Preferences window is not open.".to_string())
}

#[tauri::command]
pub fn open_preferences(app: AppHandle, tab: Option<String>) -> Result<(), String> {
  open(&app, tab.as_deref())
}

/// The page reports how tall its toolbar and pane are; the window follows, with its top edge where it was.
#[tauri::command]
pub fn set_preferences_height(app: AppHandle, height: f64) -> Result<(), String> {
  if !height.is_finite() {
    return Err("height must be a number".to_string());
  }
  let w = window(&app)?;
  let top_left = w.outer_position().ok();
  w.set_size(LogicalSize::new(WIDTH, height.clamp(MIN_HEIGHT, MAX_HEIGHT)))
    .map_err(|e| e.to_string())?;
  if let Some(p) = top_left {
    let _ = w.set_position(p);
  }
  Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
  version: String,
  data_dir: Option<String>,
  port: u16,
}

/// What the Advanced and Data panes show about this app.
#[tauri::command]
pub fn app_info(app: AppHandle) -> AppInfo {
  AppInfo {
    version: app.package_info().version.to_string(),
    data_dir: agent::data_dir(&app).ok().map(|p| p.to_string_lossy().into_owned()),
    port: agent::AGENT_PORT,
  }
}

/// Whether `url` is a plain web address the default browser may open: http or https, a host, no user info.
pub fn is_web_url(url: &str) -> bool {
  let rest = match url.strip_prefix("https://").or_else(|| url.strip_prefix("http://")) {
    Some(r) => r,
    None => return false,
  };
  let host = rest.split(|c| c == '/' || c == '?' || c == '#').next().unwrap_or("");
  !host.is_empty() && !host.contains('@') && !url.chars().any(|c| c.is_control() || c == ' ')
}

/// Opens a web page in the default browser. A link in the app's page does nothing by itself inside the window (Nov 23:
/// the owner clicked the Amazon and Home Depot links and nothing happened), so the page asks the shell.
#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> Result<(), String> {
  if !is_web_url(&url) {
    return Err("Only a web address can be opened.".to_string());
  }
  tauri_plugin_opener::OpenerExt::opener(&app)
    .open_url(url, None::<&str>)
    .map_err(|e| e.to_string())
}

/// Shows the agent's data folder in Finder.
#[tauri::command]
pub fn reveal_data_folder(app: AppHandle) -> Result<(), String> {
  let dir = agent::data_dir(&app)?;
  if !dir.exists() {
    return Err("The data folder does not exist yet.".to_string());
  }
  #[cfg(target_os = "macos")]
  {
    std::process::Command::new("open")
      .arg(&dir)
      .spawn()
      .map(|_| ())
      .map_err(|e| e.to_string())
  }
  #[cfg(not(target_os = "macos"))]
  {
    tauri_plugin_opener::OpenerExt::opener(&app)
      .open_path(dir.to_string_lossy(), None::<&str>)
      .map_err(|e| e.to_string())
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_known_tab_is_kept_and_anything_else_is_general() {
    assert_eq!(tab_or_default(Some("keys")), "keys");
    assert_eq!(tab_or_default(Some("advanced")), "advanced");
    assert_eq!(tab_or_default(Some("keys'; alert(1)//")), "general");
    assert_eq!(tab_or_default(None), "general");
  }
}
