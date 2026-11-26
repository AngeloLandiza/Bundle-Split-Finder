//! The page viewer (docs/design.md, Desktop app > Page viewer): one window, reused for every link, holding two webviews
//! one above the other. On top, `viewer-bar`: our own toolbar, the dashboard's bundle at `#/viewer`, with no agent
//! token, allowed only the viewer's own commands (capabilities/viewer-bar.json). Below, `viewer-page`: the site's page,
//! with no capability at all (no capability file may name it or the window: the test below fails if one does), no
//! script of ours, `https` only and never this computer (policy.rs), no downloads, no camera, microphone, location or
//! notification, and its browsing data in its own store (macOS 14+: a WebKit data store of its own; older macOS: none
//! kept; Windows: its own WebView2 folder under the app's local data, apart from the agent's store).
//!
//! Multi-webview windows need Tauri's `unstable` feature (Window::add_child). docs/decisions.md, "Nov 25: the page
//! viewer", has the facts and links.

pub mod model;
pub mod native;
pub mod policy;
#[cfg(debug_assertions)]
pub mod preview;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::webview::{NewWindowResponse, PageLoadEvent, PermissionResponse, WebviewBuilder};
use tauri::window::WindowBuilder;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Rect, Url, Webview, WebviewUrl, Window, WindowEvent, Wry};

use self::model::{BarState, Context, Model, Screen};
use crate::{agent, prefs};

pub const WINDOW: &str = "viewer";
/// Our toolbar. capabilities/viewer-bar.json names this webview, and only by `webviews`.
pub const BAR: &str = "viewer-bar";
/// The site's page. No capability names it, or the window (a window's capability reaches every webview in it).
pub const PAGE: &str = "viewer-page";

/// The windows whose pages may open a link in the viewer (capabilities/viewer-open.json).
const OPENERS: &[&str] = &["main", "popover", "preferences"];

#[cfg(target_os = "macos")]
const BAR_HEIGHT: f64 = 52.0;
#[cfg(not(target_os = "macos"))]
const BAR_HEIGHT: f64 = 44.0;

/// macOS 14+: the viewer's own WebKit data store (WKWebsiteDataStore(forIdentifier:)), apart from the app's pages.
#[cfg(target_os = "macos")]
const DATA_STORE_ID: [u8; 16] = [104, 181, 235, 32, 192, 89, 173, 22, 16, 37, 198, 30, 171, 26, 109, 215];

static STATE: Mutex<Option<Model>> = Mutex::new(None);
/// Bumped each time the window is built, so a poll thread of an earlier window stops.
static GENERATION: AtomicU64 = AtomicU64::new(0);
static EPOCH: OnceLock<Instant> = OnceLock::new();
static BAR_URL: OnceLock<String> = OnceLock::new();

fn now() -> u64 {
  EPOCH.get_or_init(Instant::now).elapsed().as_millis() as u64
}

/// The toolbar's page: the dashboard's bundle at `#/viewer`, served by the agent like every other window.
fn bar_url() -> String {
  BAR_URL.get().cloned().unwrap_or_else(|| format!("{}#/viewer", agent::UI_URL))
}

/// Development only (examples/viewer_preview.rs): the toolbar from another local server, to look at the viewer while
/// the installed app holds the agent's port.
#[cfg(debug_assertions)]
#[doc(hidden)]
pub fn preview_bar_url(url: &str) {
  let _ = BAR_URL.set(url.to_string());
}

fn with_model<T>(f: impl FnOnce(&mut Model) -> T) -> T {
  let mut g = STATE.lock().unwrap_or_else(|e| e.into_inner());
  f(g.get_or_insert_with(Model::new))
}

/// Windows: the viewer's WebView2 folder, under the app's local data and never inside the agent's store.
#[cfg_attr(not(windows), allow(dead_code))]
fn browsing_dir(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("viewer-browsing");
  if let Ok(store) = agent::data_dir(app).map(|d| d.join("store")) {
    if dir.starts_with(&store) {
      return Err("The viewer's browsing data would be inside the agent's store.".to_string());
    }
  }
  Ok(dir)
}

/// Opens a link in the viewer: builds the window, or brings it forward with the new page and context.
pub fn open(app: &AppHandle, url: &str, context: Option<Context>) -> Result<(), String> {
  let (target, _) = policy::first_page(url).ok_or_else(|| "This address does not open in Split Finder.".to_string())?;
  let context = context.and_then(Context::checked);
  with_model(|m| m.open(target.as_str(), context, now()));
  match (app.get_window(WINDOW), app.get_webview(PAGE), app.get_webview(BAR)) {
    (Some(window), Some(page), Some(_)) => {
      page.navigate(target).map_err(|e| e.to_string())?;
      let _ = window.unminimize();
      let _ = window.show();
      let _ = window.set_focus();
    }
    (window, _, _) => {
      // A window left half-built (Clear browsing data's hidden one) is replaced.
      if let Some(w) = window {
        let _ = w.destroy();
      }
      build(app, target)?;
    }
  }
  push(app);
  Ok(())
}

/// The site's webview: the navigation rules, refusals, its own browsing data, and the page-load reports.
fn page_builder(app: &AppHandle, first: Url) -> Result<WebviewBuilder<Wry>, String> {
  let opener = app.clone();
  #[allow(unused_mut)]
  let mut page = WebviewBuilder::new(PAGE, WebviewUrl::External(first))
    .on_navigation(|url| policy::navigation(url) == policy::Nav::Allow)
    // A link that wants a new window loads here when it is https; anything else is dropped.
    .on_new_window(move |url, _features| {
      if policy::new_window(&url) {
        if let Some(page) = opener.get_webview(PAGE) {
          let _ = page.navigate(url);
        }
      }
      NewWindowResponse::Deny
    })
    .on_download(|_, _| false)
    .on_permission_request(|_, _| PermissionResponse::Deny)
    .on_page_load(|webview, payload| {
      let url = payload.url().to_string();
      match payload.event() {
        PageLoadEvent::Started => with_model(|m| m.committed(&url)),
        PageLoadEvent::Finished => with_model(|m| m.finished(&url)),
      }
      push(webview.app_handle());
    });
  #[cfg(target_os = "macos")]
  {
    page = if native::macos_major() >= 14 { page.data_store_identifier(DATA_STORE_ID) } else { page.incognito(true) };
  }
  #[cfg(windows)]
  {
    page = page.data_directory(browsing_dir(app)?);
  }
  #[cfg(not(windows))]
  let _ = app;
  Ok(page)
}

/// The toolbar's one init script: the platform and the window chrome, on its own origin only. Unlike the dashboard's
/// (shell.rs init_script) it carries no token.
fn bar_script(home: &Url) -> String {
  let origin = serde_json::to_string(&home.origin().ascii_serialization()).unwrap_or_else(|_| "\"\"".into());
  let chrome = if cfg!(target_os = "macos") { "unified" } else { "standard" };
  format!(
    "(function(){{ if (location.origin !== {origin}) return; window.__SPLIT_FINDER_SHELL__ = {{ platform: '{platform}', chrome: '{chrome}' }}; }})();",
    platform = std::env::consts::OS,
  )
}

fn build(app: &AppHandle, first: Url) -> Result<(), String> {
  let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
  let window = window_builder(app)?.build().map_err(|e| e.to_string())?;
  let (w, h) = logical_size(&window);

  let bar_origin = Url::parse(&bar_url()).map_err(|e| e.to_string())?;
  let bar_home = bar_origin.clone();
  let bar = WebviewBuilder::new(BAR, WebviewUrl::External(bar_origin))
    // The toolbar is told the platform and the chrome, and nothing else: no agent token, which it does not need.
    .initialization_script(bar_script(&bar_home))
    // The toolbar never leaves its own page.
    .on_navigation(move |url| url.origin() == bar_home.origin())
    .on_new_window(|_, _| NewWindowResponse::Deny)
    .on_download(|_, _| false)
    .on_permission_request(|_, _| PermissionResponse::Deny)
    .on_page_load(|webview, payload| {
      if payload.event() == PageLoadEvent::Finished {
        let app = webview.app_handle().clone();
        push(&app);
        if let Some(window) = app.get_window(WINDOW) {
          let _ = window.show();
          let _ = window.set_focus();
        }
      }
    });
  window
    .add_child(bar, LogicalPosition::new(0.0, 0.0), LogicalSize::new(w, BAR_HEIGHT))
    .map_err(|e| e.to_string())?;
  window
    .add_child(page_builder(app, first)?, LogicalPosition::new(0.0, BAR_HEIGHT), LogicalSize::new(w, (h - BAR_HEIGHT).max(0.0)))
    .map_err(|e| e.to_string())?;

  let handle = app.clone();
  window.on_window_event(move |event| match event {
    WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => layout(&handle),
    WindowEvent::Focused(focused) => menu_focus(&handle, *focused),
    WindowEvent::Destroyed => {
      menu_focus(&handle, false);
      if let Ok(mut g) = STATE.lock() {
        *g = None;
      }
    }
    _ => {}
  });

  // If the toolbar's page is slow, the window still shows.
  let shower = app.clone();
  std::thread::spawn(move || {
    std::thread::sleep(Duration::from_millis(1500));
    if let Some(window) = shower.get_window(WINDOW) {
      if !window.is_visible().unwrap_or(true) {
        let _ = window.show();
        let _ = window.set_focus();
      }
    }
  });
  poll(app.clone(), generation);
  Ok(())
}

fn window_builder(app: &AppHandle) -> Result<WindowBuilder<'_, Wry, AppHandle>, String> {
  let place = placement(app);
  let mut cfg = tauri::utils::config::WindowConfig::default();
  cfg.label = WINDOW.to_string();
  cfg.title = "Page".to_string();
  cfg.width = place.width;
  cfg.height = place.height;
  cfg.min_width = Some(model::MIN_SIZE.0);
  cfg.min_height = Some(model::MIN_SIZE.1);
  cfg.x = place.x;
  cfg.y = place.y;
  cfg.visible = false;
  #[cfg(target_os = "macos")]
  {
    // The toolbar is the title bar, as in the main window: traffic lights centred in its 52pt band.
    cfg.title_bar_style = tauri::TitleBarStyle::Overlay;
    cfg.hidden_title = true;
    cfg.traffic_light_position = Some(tauri::utils::config::LogicalPosition { x: 20.0, y: 26.0 });
  }
  WindowBuilder::from_config(app, &cfg).map_err(|e| e.to_string())
}

/// Where the window first opens: beside the main window on the side with room, else over it (model::place). The
/// window-state plugin puts it back where he left it on every later open.
fn placement(app: &AppHandle) -> model::Placement {
  let main = app.get_webview_window(crate::shell::MAIN).filter(|w| w.is_visible().unwrap_or(false));
  let Some(main) = main else { return model::place(None, None) };
  let sf = main.scale_factor().unwrap_or(1.0);
  let main_rect = match (main.outer_position(), main.outer_size()) {
    (Ok(p), Ok(s)) => {
      let p = p.to_logical::<f64>(sf);
      let s = s.to_logical::<f64>(sf);
      Some(model::Area { x: p.x, y: p.y, width: s.width, height: s.height })
    }
    _ => None,
  };
  let screen = main.current_monitor().ok().flatten().map(|m| {
    let wa = m.work_area();
    let msf = m.scale_factor();
    let p = wa.position.to_logical::<f64>(msf);
    let s = wa.size.to_logical::<f64>(msf);
    model::Area { x: p.x, y: p.y, width: s.width, height: s.height }
  });
  model::place(main_rect, screen)
}

fn logical_size(window: &Window) -> (f64, f64) {
  let sf = window.scale_factor().unwrap_or(1.0);
  window
    .inner_size()
    .map(|s| {
      let l = s.to_logical::<f64>(sf);
      (l.width, l.height)
    })
    .unwrap_or((model::DEFAULT_SIZE.0, model::DEFAULT_SIZE.1))
}

/// The toolbar across the top and the page under it; one of our own states covers the page area (the toolbar's
/// webview grows over it and the page is hidden, so nothing of the page can be typed into).
fn layout(app: &AppHandle) {
  let (Some(window), Some(bar), Some(page)) = (app.get_window(WINDOW), app.get_webview(BAR), app.get_webview(PAGE)) else {
    return;
  };
  let (w, h) = logical_size(&window);
  let covered = with_model(|m| m.screen != Screen::Page);
  let bar_h = if covered { h } else { BAR_HEIGHT };
  let _ = bar.set_bounds(Rect { position: LogicalPosition::new(0.0, 0.0).into(), size: LogicalSize::new(w, bar_h).into() });
  let _ = page.set_bounds(Rect {
    position: LogicalPosition::new(0.0, BAR_HEIGHT).into(),
    size: LogicalSize::new(w, (h - BAR_HEIGHT).max(0.0)).into(),
  });
  let _ = if covered { page.hide() } else { page.show() };
}

/// Sends the toolbar its state, titles the window, and lays out the webviews when the screen changed.
fn push(app: &AppHandle) {
  static LAST: Mutex<Option<BarState>> = Mutex::new(None);
  let (bar_state, title) = with_model(|m| (m.bar(), m.window_title()));
  let screen_changed = {
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    let changed = last.as_ref().map(|l| l.screen != bar_state.screen).unwrap_or(true);
    *last = Some(bar_state.clone());
    changed
  };
  if let Some(window) = app.get_window(WINDOW) {
    let _ = window.set_title(&title);
  }
  if screen_changed {
    layout(app);
  }
  if let Some(bar) = app.get_webview(BAR) {
    let json = serde_json::to_string(&bar_state).unwrap_or_else(|_| "null".into());
    let _ = bar.eval(format!("try {{ window.dispatchEvent(new CustomEvent('split-finder:viewer', {{ detail: {json} }})); }} catch (e) {{}}"));
  }
}

/// Reads the native web view's state while the window is open: often while a page loads, seldom otherwise.
fn poll(app: AppHandle, generation: u64) {
  std::thread::spawn(move || loop {
    let loading = with_model(|m| m.loading);
    std::thread::sleep(Duration::from_millis(if loading { 200 } else { 700 }));
    if GENERATION.load(Ordering::SeqCst) != generation {
      return;
    }
    let Some(page) = app.get_webview(PAGE) else { return };
    let Some(snapshot) = native::snapshot(&page) else { continue };
    let changed = with_model(|m| {
      let before = m.bar();
      m.polled(&snapshot, now());
      m.bar() != before
    });
    if changed {
      push(&app);
    }
  });
}

/// The address the toolbar's actions use (model::Model::address).
fn address() -> Option<String> {
  with_model(|m| m.address())
}

fn act(app: &AppHandle, action: &str) -> Result<(), String> {
  let page = app.get_webview(PAGE);
  match action {
    "back" | "forward" => {
      let Some(page) = page else { return Ok(()) };
      // From our own state (sign-in) back to the page before it.
      native::act(&page, if action == "back" { native::Action::Back } else { native::Action::Forward });
    }
    "stop" => {
      if let Some(page) = page {
        native::act(&page, native::Action::Stop);
      }
      with_model(|m| m.stopped());
      push(app);
    }
    "reload" => {
      let failed = with_model(|m| matches!(m.screen, Screen::Failed { .. }));
      if failed {
        return act(app, "retry");
      }
      if let Some(page) = page {
        page.reload().map_err(|e| e.to_string())?;
      }
    }
    "retry" => {
      let (Some(page), Some(url)) = (page, address()) else { return Ok(()) };
      let url = Url::parse(&url).map_err(|e| e.to_string())?;
      with_model(|m| m.navigate(url.as_str(), now()));
      page.navigate(url).map_err(|e| e.to_string())?;
      push(app);
    }
    "browser" => {
      let url = address().ok_or("There is no page to open.")?;
      prefs::open_external(app.clone(), url)?;
    }
    "copy" => native::copy_text(&address().ok_or("There is no page to copy.")?)?,
    "close" => {
      if let Some(window) = app.get_window(WINDOW) {
        let _ = window.destroy();
      }
    }
    _ => return Err("Unknown viewer action.".to_string()),
  }
  Ok(())
}

/// One of the deal's pages, chosen in the toolbar's page pop-up.
fn go_to_page(app: &AppHandle, index: usize) {
  let url = with_model(|m| m.context.as_ref().and_then(|c| c.pages.get(index)).map(|p| p.url.clone()));
  let (Some(url), Some(page)) = (url.and_then(|u| Url::parse(&u).ok()), app.get_webview(PAGE)) else { return };
  with_model(|m| m.navigate(url.as_str(), now()));
  let _ = page.navigate(url);
  push(app);
}

// ---------------------------------------------------------------------------------------------------- menus

/// The View menu's page items (macOS). Active only while the viewer is the key window; Cmd+R reloads the page there
/// and is Scan now everywhere else, so the accelerator moves between the two as the viewer gains and loses focus.
struct PageMenu {
  back: MenuItem<Wry>,
  forward: MenuItem<Wry>,
  reload: MenuItem<Wry>,
  copy: MenuItem<Wry>,
  close: MenuItem<Wry>,
  scan: MenuItem<Wry>,
}

static PAGE_MENU: Mutex<Option<PageMenu>> = Mutex::new(None);

/// The items for the View menu (shell.rs build_menus); `scan` is the Agent menu's Scan now, whose Cmd+R they borrow.
pub fn menu_items(app: &AppHandle, scan: &MenuItem<Wry>) -> tauri::Result<Vec<MenuItem<Wry>>> {
  let back = MenuItem::with_id(app, "viewer:back", "Back", false, Some("CmdOrCtrl+["))?;
  let forward = MenuItem::with_id(app, "viewer:forward", "Forward", false, Some("CmdOrCtrl+]"))?;
  let reload = MenuItem::with_id(app, "viewer:reload", "Reload page", false, None::<&str>)?;
  let copy = MenuItem::with_id(app, "viewer:copy", "Copy link", false, Some("CmdOrCtrl+Shift+C"))?;
  let close = MenuItem::with_id(app, "viewer:close", "Close page", false, None::<&str>)?;
  let items = vec![back.clone(), forward.clone(), reload.clone(), copy.clone(), close.clone()];
  if let Ok(mut g) = PAGE_MENU.lock() {
    *g = Some(PageMenu { back, forward, reload, copy, close, scan: scan.clone() });
  }
  Ok(items)
}

fn menu_focus(_app: &AppHandle, focused: bool) {
  let Ok(g) = PAGE_MENU.lock() else { return };
  let Some(m) = g.as_ref() else { return };
  for item in [&m.back, &m.forward, &m.reload, &m.copy, &m.close] {
    let _ = item.set_enabled(focused);
  }
  if focused {
    let _ = m.scan.set_accelerator(None::<&str>);
    let _ = m.reload.set_accelerator(Some("CmdOrCtrl+R"));
    let _ = m.close.set_accelerator(Some("Escape"));
  } else {
    let _ = m.reload.set_accelerator(None::<&str>);
    let _ = m.close.set_accelerator(None::<&str>);
    let _ = m.scan.set_accelerator(Some("CmdOrCtrl+R"));
  }
}

/// A menu item of ours was chosen (shell.rs handle_menu passes every `viewer:` id here).
pub fn menu_action(app: &AppHandle, id: &str) {
  if let Some(i) = id.strip_prefix("viewer:page:").and_then(|i| i.parse::<usize>().ok()) {
    go_to_page(app, i);
    return;
  }
  if let Some(action) = id.strip_prefix("viewer:") {
    if let Err(e) = act(app, action) {
      log::warn!("viewer {action}: {e}");
    }
  }
}

/// Text as a native menu item shows it: a menu reads a single `&` as a mnemonic marker and drops it ("Battery &
/// Charger" would read "Battery  Charger"), so each is doubled; a long title is cut at a word with an ellipsis.
fn menu_text(text: &str, max: usize) -> String {
  let cut = if text.chars().count() > max {
    let head: String = text.chars().take(max).collect();
    let at = head.rfind(' ').filter(|i| *i > max / 2).unwrap_or(head.len());
    format!("{}…", head[..at].trim_end_matches([' ', ',', '&', '/', '(', '-']))
  } else {
    text.to_string()
  };
  cut.replace('&', "&&")
}

/// The page pop-up's native menu: the deal's title, then its pages, grouped by site, the one on screen checked.
fn pages_menu(app: &AppHandle) -> tauri::Result<Option<Menu<Wry>>> {
  let (ctx, current) = with_model(|m| (m.context.clone(), m.current()));
  let Some(ctx) = ctx else { return Ok(None) };
  let mut items: Vec<Box<dyn IsMenuItem<Wry>>> = Vec::new();
  items.push(Box::new(MenuItem::with_id(app, "viewer:title", menu_text(&ctx.title, 64), false, None::<&str>)?));
  let mut last_site: Option<String> = None;
  for (i, p) in ctx.pages.iter().enumerate() {
    let site = p.label.split(" · ").next().unwrap_or("").to_string();
    if last_site.as_deref() != Some(site.as_str()) {
      items.push(Box::new(PredefinedMenuItem::separator(app)?));
      last_site = Some(site);
    }
    items.push(Box::new(CheckMenuItem::with_id(app, format!("viewer:page:{i}"), menu_text(&p.label, 80), true, current == Some(i), None::<&str>)?));
  }
  let refs: Vec<&dyn IsMenuItem<Wry>> = items.iter().map(|b| b.as_ref()).collect();
  Ok(Some(Menu::with_items(app, &refs)?))
}

// ---------------------------------------------------------------------------------------------------- commands

fn from_bar(webview: &Webview) -> Result<(), String> {
  if webview.label() == BAR {
    Ok(())
  } else {
    Err("Only the viewer's toolbar may do that.".to_string())
  }
}

/// A page of the app opens a link in the viewer. `context` is the deal it was opened from, if any. Async: on Windows,
/// a webview made from a synchronous command can deadlock (WebviewBuilder docs, "Known issues").
#[tauri::command]
pub async fn viewer_open(app: AppHandle, webview: Webview, url: String, context: Option<Context>) -> Result<(), String> {
  if !OPENERS.contains(&webview.label()) {
    return Err("This window may not open the viewer.".to_string());
  }
  open(&app, &url, context)
}

/// The toolbar asks for its state when it loads (and is then told of every change by an event).
#[tauri::command]
pub fn viewer_state(webview: Webview) -> Result<BarState, String> {
  from_bar(&webview)?;
  Ok(with_model(|m| m.bar()))
}

/// The toolbar's buttons: back, forward, reload, stop, retry, browser, copy, close.
#[tauri::command]
pub fn viewer_do(app: AppHandle, webview: Webview, action: String) -> Result<(), String> {
  from_bar(&webview)?;
  act(&app, &action)
}

/// The toolbar's page pop-up: the native menu at the button, in the toolbar's own coordinates (the toolbar is at the
/// window's top-left).
#[tauri::command]
pub fn viewer_pages(app: AppHandle, webview: Webview, x: f64, y: f64) -> Result<(), String> {
  from_bar(&webview)?;
  if !x.is_finite() || !y.is_finite() {
    return Err("position must be numbers".to_string());
  }
  let window = app.get_window(WINDOW).ok_or("The viewer is not open.")?;
  if let Some(menu) = pages_menu(&app).map_err(|e| e.to_string())? {
    window.popup_menu_at(&menu, LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
  }
  Ok(())
}

/// Settings › Data › Clear viewer browsing data: cookies, storage and cache of the viewer's pages, nothing of the app's.
#[tauri::command]
pub async fn viewer_clear_data(app: AppHandle, webview: Webview) -> Result<(), String> {
  if !OPENERS.contains(&webview.label()) {
    return Err("This window may not clear the viewer's data.".to_string());
  }
  if let Some(page) = app.get_webview(PAGE) {
    page.clear_all_browsing_data().map_err(|e| e.to_string())?;
    let _ = page.reload();
    return Ok(());
  }
  // No viewer open: a hidden one on a blank page, on the same store, cleared, then closed once the store has had time.
  let blank = Url::parse("about:blank").map_err(|e| e.to_string())?;
  let window = window_builder(&app)?.build().map_err(|e| e.to_string())?;
  let page = window
    .add_child(page_builder(&app, blank)?, LogicalPosition::new(0.0, 0.0), LogicalSize::new(1.0, 1.0))
    .map_err(|e| e.to_string())?;
  let result = page.clear_all_browsing_data().map_err(|e| e.to_string());
  std::thread::spawn(move || {
    std::thread::sleep(Duration::from_secs(3));
    // Unless he opened a link meanwhile (then it is the real viewer, with its toolbar).
    if window.app_handle().get_webview(BAR).is_none() {
      let _ = window.destroy();
    }
  });
  result
}

#[cfg(test)]
mod tests {
  use super::*;

  /// A capability's label pattern (Tauri: a glob) against a label. `*` and `?` as globs do; a `[` set counts as
  /// matching, so an unusual pattern fails the check below rather than slipping past it.
  fn glob(pattern: &str, label: &str) -> bool {
    if pattern.contains('[') {
      return true;
    }
    fn go(p: &[char], l: &[char]) -> bool {
      match (p.first(), l.first()) {
        (None, None) => true,
        (Some('*'), _) => go(&p[1..], l) || (!l.is_empty() && go(p, &l[1..])),
        (Some('?'), Some(_)) => go(&p[1..], &l[1..]),
        (Some(a), Some(b)) if a == b => go(&p[1..], &l[1..]),
        _ => false,
      }
    }
    go(&pattern.chars().collect::<Vec<_>>(), &label.chars().collect::<Vec<_>>())
  }

  fn labels(cap: &serde_json::Value, key: &str) -> Vec<String> {
    cap.get(key).and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect()).unwrap_or_default()
  }

  /// Every capability, from capabilities/*.json and any inline in tauri.conf.json.
  fn capabilities() -> Vec<(String, serde_json::Value)> {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut out = Vec::new();
    for entry in std::fs::read_dir(root.join("capabilities")).unwrap() {
      let path = entry.unwrap().path();
      if path.extension().and_then(|e| e.to_str()) == Some("json") {
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        out.push((path.display().to_string(), v));
      }
    }
    let conf: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(root.join("tauri.conf.json")).unwrap()).unwrap();
    for cap in conf.pointer("/app/security/capabilities").and_then(|c| c.as_array()).into_iter().flatten() {
      if cap.is_object() {
        out.push(("tauri.conf.json".to_string(), cap.clone()));
      }
    }
    assert!(out.len() >= 5, "the capability files were not found");
    out
  }

  #[test]
  fn no_capability_reaches_the_sites_page() {
    for (file, cap) in capabilities() {
      for w in labels(&cap, "windows") {
        // A window's capability is every webview's in it: the page's too.
        assert!(!glob(&w, WINDOW), "{file} names the viewer window ({w}): the site's page would get it");
      }
      for w in labels(&cap, "webviews") {
        assert!(!glob(&w, PAGE), "{file} names the viewer's page webview ({w})");
      }
    }
  }

  #[test]
  fn the_toolbar_gets_only_the_viewers_own_commands() {
    let caps: Vec<_> = capabilities().into_iter().filter(|(_, c)| labels(c, "webviews").iter().any(|w| glob(w, BAR))).collect();
    assert_eq!(caps.len(), 1, "exactly one capability names the toolbar");
    let (_, cap) = &caps[0];
    assert!(labels(cap, "windows").is_empty());
    let mut perms = labels(cap, "permissions");
    perms.sort();
    assert_eq!(
      perms,
      vec![
        "allow-viewer-do",
        "allow-viewer-pages",
        "allow-viewer-state",
        "core:window:allow-internal-toggle-maximize",
        "core:window:allow-start-dragging",
      ]
    );
  }

  #[test]
  fn a_menu_shows_an_ampersand_and_cuts_a_long_title_at_a_word() {
    // The real title of homedepot:344305163 (fixtures/e2e-2026-11-23/after-scan6).
    let title = "ONE+ 18V Lithium Starter Kit w/ (1) 2.0 Ah Battery, (1) 4.0 Ah Battery & Charger w/ ONE+ 18V Hybrid LED Work Light";
    let shown = menu_text(title, 64);
    assert!(shown.ends_with('…'));
    assert!(shown.chars().count() <= 65);
    assert_eq!(menu_text("Battery & Charger", 64), "Battery && Charger");
    assert_eq!(menu_text("Amazon · PCG002", 80), "Amazon · PCG002");
  }

  #[test]
  fn the_glob_check_matches_as_tauri_would() {
    assert!(glob("*", PAGE));
    assert!(glob("viewer*", PAGE));
    assert!(glob("v?ewer", WINDOW));
    assert!(glob("[v]iewer", WINDOW));
    assert!(!glob("main", WINDOW));
    assert!(!glob(BAR, PAGE));
  }
}
