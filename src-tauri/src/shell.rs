//! The desktop shell: window, tray, menus, notifications, navigation.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::image::Image;
use tauri::menu::{
  CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu, SubmenuBuilder,
};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_notification::NotificationExt;

use crate::{agent, popover};

/// How long after a native notification a click on the app still counts as "the notification".
const NOTIFICATION_CLICK_WINDOW: Duration = Duration::from_secs(120);

pub const MAIN: &str = "main";

pub struct ShellState {
  pub open_questions: AtomicU32,
  pub paused: AtomicBool,
  /// settings.notifications.sound: the native notification plays the default sound.
  sound: AtomicBool,
  /// settings.updatedAt of the settings last applied; the state event carries it as `settingsAt`.
  pub settings_at: Mutex<Option<String>>,
  /// The window shows the "not our agent" message instead of the dashboard; showing it again
  /// rebuilds it once the agent proves itself.
  error_page: AtomicBool,
  /// The screen the last notification was about. Desktop notification plugins have no click
  /// callback, so the next activation of the app within the window above navigates there.
  pending_nav: Mutex<Option<(Instant, String)>>,
  items: Mutex<Option<TrayItems>>,
}

impl ShellState {
  pub fn new() -> Self {
    Self {
      open_questions: AtomicU32::new(0),
      paused: AtomicBool::new(false),
      sound: AtomicBool::new(false),
      settings_at: Mutex::new(None),
      error_page: AtomicBool::new(false),
      pending_nav: Mutex::new(None),
      items: Mutex::new(None),
    }
  }
}

struct TrayItems {
  tray: TrayIcon,
  questions: MenuItem<tauri::Wry>,
  pause: MenuItem<tauri::Wry>,
  app_questions: MenuItem<tauri::Wry>,
  app_pause: MenuItem<tauri::Wry>,
  login: CheckMenuItem<tauri::Wry>,
}

/// Runs before every page load in the webview: the pairing token and a marker that the page is
/// inside the desktop shell. The page reads `window.__SPLIT_FINDER_TOKEN__`, and
/// `__SPLIT_FINDER_SHELL__.chrome`: "unified" when the window has the macOS unified title bar and the
/// sidebar material behind a transparent webview (native_chrome below), so the page leaves its
/// sidebar clear and paints only the content area.
pub(crate) fn init_script(token: Option<&str>) -> String {
  let token_js = token
    .map(|t| serde_json::to_string(t).unwrap_or_else(|_| "null".into()))
    .unwrap_or_else(|| "null".into());
  let chrome = if cfg!(target_os = "macos") { "unified" } else { "standard" };
  format!(
    "(function(){{ if (location.origin !== '{origin}') return; \
     var t = {token_js}; if (t) window.__SPLIT_FINDER_TOKEN__ = t; \
     window.__SPLIT_FINDER_SHELL__ = {{ platform: '{platform}', chrome: '{chrome}' }}; }})();",
    origin = agent::AGENT_ORIGIN,
    platform = std::env::consts::OS,
  )
}

/// Where the close button's top-left sits, in points from the window's top-left. The page's toolbar
/// and the sidebar's title band are 52px (desktop-ui base.css `--toolbar-h`). Tao sets the title bar
/// container to 14 + y tall and AppKit keeps the 14pt buttons 7pt above its bottom, so y = 26 centres
/// them in that band; 20pt in from the edge, as in Finder and Mail.
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHTS: (f64, f64) = (20.0, 26.0);

/// The macOS window chrome (docs/design.md, Desktop app > Window): a unified title bar with the
/// title hidden and the traffic lights inset into the sidebar, full-size content, and the sidebar
/// material (NSVisualEffectView, following the window's active state) behind a transparent webview.
/// The page paints its content column solid and leaves the sidebar clear, so only the sidebar is
/// translucent. Elsewhere the window keeps its standard frame.
fn native_chrome<'a>(
  builder: WebviewWindowBuilder<'a, Wry, AppHandle>,
) -> WebviewWindowBuilder<'a, Wry, AppHandle> {
  #[cfg(target_os = "macos")]
  {
    use tauri::window::{Effect, EffectState, EffectsBuilder};
    use tauri::{LogicalPosition, TitleBarStyle};
    builder
      .title_bar_style(TitleBarStyle::Overlay)
      .hidden_title(true)
      .traffic_light_position(LogicalPosition::new(TRAFFIC_LIGHTS.0, TRAFFIC_LIGHTS.1))
      .transparent(true)
      .effects(
        EffectsBuilder::new()
          .effect(Effect::Sidebar)
          .state(EffectState::FollowsWindowActiveState)
          .build(),
      )
  }
  // Windows: the standard frame and title bar, with the Mica backdrop on Windows 11 (the title bar takes
  // it; Windows 10 has no Mica and Tauri leaves the window as it is). The webview stays opaque.
  #[cfg(windows)]
  {
    use tauri::window::{Effect, EffectsBuilder};
    builder.effects(EffectsBuilder::new().effect(Effect::Mica).build())
  }
  #[cfg(not(any(target_os = "macos", windows)))]
  {
    builder
  }
}

/// Creates the main window (declared with `create: false` so it can carry the init script).
pub fn create_window(app: &AppHandle) -> Result<WebviewWindow, String> {
  if let Some(w) = app.get_webview_window(MAIN) {
    return Ok(w);
  }
  let cfg = app
    .config()
    .app
    .windows
    .first()
    .ok_or("no window in tauri.conf.json")?
    .clone();
  // The dashboard loads, and the token goes into the page, only after the listener on the port
  // proved it holds the token (agent::proven_token). Otherwise the window says why and loads nothing
  // from the port; Open Split Finder tries again.
  let window = match agent::proven_token(app) {
    Some(token) => {
      app.state::<ShellState>().error_page.store(false, Ordering::Relaxed);
      native_chrome(WebviewWindowBuilder::from_config(app, &cfg).map_err(|e| e.to_string())?)
        .initialization_script(init_script(Some(&token)))
        .build()
        .map_err(|e| e.to_string())?
    }
    None => {
      let message = if agent::port_open() {
        format!("{}. Quit it, then open Split Finder again.", agent::PORT_TAKEN)
      } else {
        "The Split Finder agent is not running. Choose Open Split Finder in the menu bar to try again.".to_string()
      };
      log::warn!("not loading the dashboard: {message}");
      app.state::<ShellState>().error_page.store(true, Ordering::Relaxed);
      let text = serde_json::to_string(&message).unwrap_or_else(|_| "\"\"".into());
      let mut blank_cfg = cfg.clone();
      let blank = tauri::Url::parse("about:blank").map_err(|e| e.to_string())?;
      blank_cfg.url = WebviewUrl::External(blank);
      WebviewWindowBuilder::from_config(app, &blank_cfg)
        .map_err(|e| e.to_string())?
        .title(format!("Split Finder: {message}"))
        .on_page_load(move |w, payload| {
          if payload.event() == PageLoadEvent::Finished {
            let _ = w.eval(&format!(
              "document.body.style.font = '15px -apple-system, system-ui, sans-serif'; \
               document.body.style.margin = '48px'; document.body.textContent = {text};"
            ));
          }
        })
        .build()
        .map_err(|e| e.to_string())?
    }
  };
  let _ = window.show();
  let _ = window.set_focus();
  Ok(window)
}

/// Brings the window back (recreating it if needed) and focuses it.
pub fn show_window(app: &AppHandle) -> Option<WebviewWindow> {
  if app.state::<ShellState>().error_page.load(Ordering::Relaxed) && agent::proven_token(app).is_some() {
    if let Some(old) = app.get_webview_window(MAIN) {
      let _ = old.destroy();
    }
  }
  let window = app
    .get_webview_window(MAIN)
    .or_else(|| create_window(app).ok())?;
  let _ = window.unminimize();
  let _ = window.show();
  let _ = window.set_focus();
  Some(window)
}

/// Opens the dashboard at a route such as "/review" and tells the page.
pub fn navigate(app: &AppHandle, route: &str) {
  let Some(window) = show_window(app) else { return };
  let r = serde_json::to_string(route).unwrap_or_else(|_| "\"/\"".into());
  let js = format!(
    "(function(r){{ try {{ \
       if (location.origin !== '{origin}') {{ location.href = '{ui}#' + r; return; }} \
       if (location.pathname.indexOf('/ui') !== 0) {{ location.href = '{ui}#' + r; return; }} \
       location.hash = '#' + r; \
       window.dispatchEvent(new CustomEvent('split-finder:navigate', {{ detail: {{ route: r }} }})); \
     }} catch (e) {{}} }})({r});",
    origin = agent::AGENT_ORIGIN,
    ui = agent::UI_URL,
  );
  let _ = window.eval(&js);
}

/// Dispatches a window event the page listens for ("split-finder:find").
fn page_event(app: &AppHandle, name: &str) {
  if let Some(window) = show_window(app) {
    let n = serde_json::to_string(name).unwrap_or_default();
    let _ = window.eval(&format!(
      "try {{ window.dispatchEvent(new CustomEvent({n})); }} catch (e) {{}}"
    ));
  }
}

pub fn route_for_kind(kind: &str) -> &'static str {
  match kind {
    "review" => "/review",
    "deal" => "/deals",
    "autopilot" => "/activity",
    "scan" => "/today",
    "error" => "/activity",
    _ => "/today",
  }
}

/// Shows a native notification and remembers where a click should land.
pub fn notify(app: &AppHandle, title: &str, body: &str, kind: &str) {
  let state = app.state::<ShellState>();
  if let Ok(mut p) = state.pending_nav.lock() {
    *p = Some((Instant::now(), route_for_kind(kind).to_string()));
  }
  let mut builder = app.notification().builder().title(title).body(body);
  if state.sound.load(Ordering::Relaxed) {
    // "default" is the system notification sound on macOS; Windows toasts name it "Default". A Windows
    // toast with no sound named is silent.
    builder = builder.sound(if cfg!(windows) { "Default" } else { "default" });
  }
  if let Err(e) = builder.show() {
    log::warn!("notification failed: {e}");
  }
}

/// Called when the app is activated (dock click, window focus, second launch). If a notification
/// was shown a moment ago, treat the activation as a click on it.
pub fn consume_pending_nav(app: &AppHandle) {
  let state = app.state::<ShellState>();
  let route = state
    .pending_nav
    .lock()
    .ok()
    .and_then(|mut p| p.take())
    .filter(|(at, _)| at.elapsed() < NOTIFICATION_CLICK_WINDOW)
    .map(|(_, r)| r);
  if let Some(r) = route {
    navigate(app, &r);
  }
}

pub fn set_open_questions(app: &AppHandle, n: u32) {
  let state = app.state::<ShellState>();
  if state.open_questions.swap(n, Ordering::Relaxed) != n {
    refresh_tray(app);
  }
  popover::set_open_questions(app, n);
}

pub fn set_paused(app: &AppHandle, paused: bool) {
  let state = app.state::<ShellState>();
  if state.paused.swap(paused, Ordering::Relaxed) != paused {
    refresh_tray(app);
  }
}

fn questions_label(n: u32) -> String {
  format!("Open questions ({n})")
}

fn pause_label(paused: bool) -> &'static str {
  if paused {
    "Resume agent"
  } else {
    "Pause agent"
  }
}

pub fn refresh_tray(app: &AppHandle) {
  let state = app.state::<ShellState>();
  let n = state.open_questions.load(Ordering::Relaxed);
  let paused = state.paused.load(Ordering::Relaxed);
  let Ok(guard) = state.items.lock() else { return };
  let Some(items) = guard.as_ref() else { return };
  let _ = items.questions.set_text(questions_label(n));
  let _ = items.app_questions.set_text(questions_label(n));
  let _ = items.pause.set_text(pause_label(paused));
  let _ = items.app_pause.set_text(pause_label(paused));
  // macOS: the menu bar icon is a plain icon while the Dock icon carries the count as its badge. With
  // the Dock icon hidden the count shows as text next to the icon. Other platforms: tooltip only.
  #[cfg(target_os = "macos")]
  let _ = items.tray.set_title(popover::tray_title(n, popover::dock_shown()));
  let tip = if n > 0 {
    format!("Split Finder - {n} open")
  } else {
    "Split Finder".to_string()
  };
  let _ = items.tray.set_tooltip(Some(tip));
}

/// Applies `settings.shell` and `settings.notifications.sound` from a GET /api/settings answer. Each switch is
/// compared with what is in effect, so applying the same settings twice does nothing.
pub fn apply_settings(app: &AppHandle, answer: &serde_json::Value) {
  let Some(settings) = answer.get("settings") else { return };
  let flag = |path: &str, default: bool| settings.pointer(path).and_then(|v| v.as_bool()).unwrap_or(default);
  let menu_bar = flag("/shell/menuBarIcon", true);
  let dock = flag("/shell/dockIcon", true);
  let login = flag("/shell/launchAtLogin", false);
  let state = app.state::<ShellState>();
  state.sound.store(flag("/notifications/sound", false), Ordering::Relaxed);
  if let Some(at) = answer.get("updatedAt").and_then(|v| v.as_str()) {
    if let Ok(mut g) = state.settings_at.lock() {
      *g = Some(at.to_string());
    }
  }

  // The window must stay reachable: with the Dock icon hidden the menu bar icon is the way back in
  // (and on other platforms the tray is the only one), so the last of the two cannot be turned off.
  if popover::set_dock_icon(app, dock) {
    // Where the count shows (Dock badge or menu bar text) follows the Dock icon.
    refresh_tray(app);
  }
  let dock_effective = cfg!(target_os = "macos") && dock;
  let show_tray = menu_bar || !dock_effective;
  if let Ok(guard) = state.items.lock() {
    if let Some(items) = guard.as_ref() {
      let _ = items.tray.set_visible(show_tray);
    }
  }
  #[cfg(target_os = "macos")]
  {
    let policy = if dock {
      tauri::ActivationPolicy::Regular
    } else {
      tauri::ActivationPolicy::Accessory
    };
    if let Err(e) = app.set_activation_policy(policy) {
      log::warn!("dock icon: {e}");
    }
  }
  if launch_at_login(app) != login {
    if let Err(e) = set_launch_at_login(app, login) {
      log::warn!("launch at login: {e}");
    }
  }
}

pub fn launch_at_login(app: &AppHandle) -> bool {
  app.autolaunch().is_enabled().unwrap_or(false)
}

pub fn set_launch_at_login(app: &AppHandle, on: bool) -> Result<bool, String> {
  let m = app.autolaunch();
  if on {
    m.enable().map_err(|e| e.to_string())?;
  } else {
    m.disable().map_err(|e| e.to_string())?;
  }
  let now = m.is_enabled().unwrap_or(on);
  if let Ok(guard) = app.state::<ShellState>().items.lock() {
    if let Some(items) = guard.as_ref() {
      let _ = items.login.set_checked(now);
    }
  }
  Ok(now)
}

/// Builds the tray icon, the tray menu and the application menu (which carries the shortcuts).
pub fn build_menus(app: &AppHandle) -> tauri::Result<()> {
  // Tray menu.
  let t_open = MenuItem::with_id(app, "open", "Open Split Finder", true, None::<&str>)?;
  let t_scan = MenuItem::with_id(app, "scan", "Scan now", true, None::<&str>)?;
  let t_questions = MenuItem::with_id(app, "questions", questions_label(0), true, None::<&str>)?;
  let t_pause = MenuItem::with_id(app, "pause", pause_label(false), true, None::<&str>)?;
  let t_settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
  let t_quit = MenuItem::with_id(app, "quit", "Quit Split Finder", true, None::<&str>)?;
  let tray_menu = Menu::with_items(
    app,
    &[
      &t_open,
      &t_scan,
      &t_questions,
      &t_pause,
      &PredefinedMenuItem::separator(app)?,
      &t_settings,
      &PredefinedMenuItem::separator(app)?,
      &t_quit,
    ],
  )?;

  // macOS: a black template image the menu bar tints. Windows: the app's own colour icon, which reads on a
  // light or a dark taskbar alike.
  #[cfg(target_os = "macos")]
  let icon = Image::from_bytes(include_bytes!("../icons/tray-template.png"))?;
  #[cfg(not(target_os = "macos"))]
  let icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))?;
  let popover_tray = cfg!(any(target_os = "macos", windows));
  let tray = TrayIconBuilder::with_id("main")
    .icon(icon)
    .icon_as_template(cfg!(target_os = "macos"))
    .tooltip("Split Finder")
    .menu(&tray_menu)
    // macOS and Windows: a left click opens the popover and the menu stays on a right click. Elsewhere the menu is the left click's.
    .show_menu_on_left_click(!popover_tray)
    .on_menu_event(|app, event| handle_menu(app, event.id().as_ref()))
    .on_tray_icon_event(move |tray, event| {
      // Windows: a double click opens the window (the popover the first click opened hides as the window takes focus).
      if let TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } = event {
        show_window(tray.app_handle());
      }
      if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        rect,
        ..
      } = event
      {
        if popover_tray {
          popover::toggle(tray.app_handle(), &rect);
        } else {
          consume_pending_nav(tray.app_handle());
        }
      }
    })
    .build(app)?;

  // Application menu: this is where Cmd/Ctrl+R, Cmd/Ctrl+, and Cmd/Ctrl+F live.
  let a_settings = MenuItem::with_id(app, "settings", "Settings...", true, Some("CmdOrCtrl+,"))?;
  let a_login = CheckMenuItem::with_id(
    app,
    "launch_login",
    "Launch at login",
    true,
    launch_at_login(app),
    None::<&str>,
  )?;
  let a_quit = MenuItem::with_id(app, "quit", "Quit Split Finder", true, Some("CmdOrCtrl+Q"))?;
  let app_sub = SubmenuBuilder::new(app, "Split Finder")
    .item(&a_settings)
    .item(&a_login)
    .separator()
    .item(&PredefinedMenuItem::hide(app, None)?)
    .item(&PredefinedMenuItem::hide_others(app, None)?)
    .separator()
    .item(&a_quit)
    .build()?;

  let a_open = MenuItem::with_id(app, "open", "Open Split Finder", true, None::<&str>)?;
  let a_scan = MenuItem::with_id(app, "scan", "Scan now", true, Some("CmdOrCtrl+R"))?;
  let a_questions = MenuItem::with_id(app, "questions", questions_label(0), true, None::<&str>)?;
  let a_pause = MenuItem::with_id(app, "pause", pause_label(false), true, None::<&str>)?;
  let agent_sub = SubmenuBuilder::new(app, "Agent")
    .item(&a_open)
    .item(&a_scan)
    .item(&a_questions)
    .item(&a_pause)
    .build()?;

  let a_find = MenuItem::with_id(app, "find", "Find", true, Some("CmdOrCtrl+F"))?;
  let edit_sub = SubmenuBuilder::new(app, "Edit")
    .undo()
    .redo()
    .separator()
    .cut()
    .copy()
    .paste()
    .select_all()
    .separator()
    .item(&a_find)
    .build()?;

  let helper_sub = Submenu::with_items(
    app,
    "Helper",
    true,
    &[
      &MenuItem::with_id(app, "open_extensions", "Open Chrome extensions", true, None::<&str>)?,
      &MenuItem::with_id(app, "reveal_zip", "Reveal extension zip", true, None::<&str>)?,
    ],
  )?;

  // View: the inspector beside Deals and Review (the page listens for split-finder:inspector).
  let view_sub = SubmenuBuilder::new(app, "View")
    .item(&MenuItem::with_id(
      app,
      "inspector",
      "Show or hide inspector",
      true,
      Some("Alt+CmdOrCtrl+I"),
    )?)
    .separator()
    .fullscreen()
    .build()?;

  let window_sub = SubmenuBuilder::new(app, "Window")
    .minimize()
    .maximize()
    .separator()
    .close_window()
    .build()?;

  // Help: the welcome sheet again, for setup skipped earlier (split-finder:setup).
  // Also the command palette and the shortcuts sheet (split-finder:palette, split-finder:shortcuts).
  let help_sub = SubmenuBuilder::new(app, "Help")
    .item(&MenuItem::with_id(app, "palette", "Command palette...", true, Some("CmdOrCtrl+K"))?)
    .item(&MenuItem::with_id(app, "shortcuts", "Keyboard shortcuts", true, Some("CmdOrCtrl+/"))?)
    .separator()
    .item(&MenuItem::with_id(app, "setup", "Finish setup...", true, None::<&str>)?)
    .build()?;

  let menu = Menu::with_items(
    app,
    &[&app_sub, &edit_sub, &view_sub, &agent_sub, &helper_sub, &window_sub, &help_sub],
  )?;
  // Windows: no menu bar under the title bar (a Windows app of this kind has none). Its items stay built for
  // the tray's state; the page's own key handlers carry the shortcuts there (docs/desktop-app.md, Windows).
  #[cfg(not(windows))]
  app.set_menu(menu)?;
  #[cfg(windows)]
  drop(menu);

  let state = app.state::<ShellState>();
  if let Ok(mut items) = state.items.lock() {
    *items = Some(TrayItems {
      tray,
      questions: t_questions,
      pause: t_pause,
      app_questions: a_questions,
      app_pause: a_pause,
      login: a_login,
    });
  }
  Ok(())
}

/// One handler for the tray menu and the application menu (they share ids).
pub fn handle_menu(app: &AppHandle, id: &str) {
  match id {
    "open" => {
      let _ = agent::start(app);
      show_window(app);
      consume_pending_nav(app);
    }
    "scan" => {
      let app = app.clone();
      std::thread::spawn(move || match agent::http_post(&app, "/api/scan") {
        Ok(()) => navigate(&app, "/today"),
        Err(e) => {
          log::warn!("scan request failed: {e}");
          notify(&app, "Could not start the scan", "The agent did not accept the request.", "error");
        }
      });
    }
    "questions" => navigate(app, "/review"),
    "pause" => {
      let app = app.clone();
      std::thread::spawn(move || {
        let paused = app.state::<ShellState>().paused.load(Ordering::Relaxed);
        let path = if paused { "/api/agent/resume" } else { "/api/agent/pause" };
        match agent::http_post(&app, path) {
          Ok(()) => set_paused(&app, !paused),
          Err(e) => log::warn!("{path} failed: {e}"),
        }
      });
    }
    "settings" => {
      let _ = crate::prefs::open(app, None);
    }
    "find" => page_event(app, "split-finder:find"),
    "inspector" => page_event(app, "split-finder:inspector"),
    "setup" => page_event(app, "split-finder:setup"),
    "palette" => page_event(app, "split-finder:palette"),
    "shortcuts" => page_event(app, "split-finder:shortcuts"),
    "launch_login" => {
      let on = !launch_at_login(app);
      if let Err(e) = set_launch_at_login(app, on) {
        log::warn!("launch at login: {e}");
      }
      // Keep the check box in line with the real state.
      if let Ok(guard) = app.state::<ShellState>().items.lock() {
        if let Some(items) = guard.as_ref() {
          let _ = items.login.set_checked(launch_at_login(app));
        }
      }
    }
    "quit" => app.exit(0),
    "open_extensions" => open_chrome_extensions(app),
    "reveal_zip" => reveal_zip(app),
    _ => {}
  }
}

fn open_chrome_extensions(app: &AppHandle) {
  #[cfg(target_os = "macos")]
  {
    let _ = app;
    let _ = std::process::Command::new("open")
      .args(["-a", "Google Chrome", "chrome://extensions/"])
      .spawn();
  }
  #[cfg(windows)]
  {
    let _ = app;
    open_chrome_extensions_windows();
  }
  #[cfg(not(any(target_os = "macos", windows)))]
  let _ = tauri_plugin_opener::OpenerExt::opener(app).open_url("chrome://extensions/", None::<&str>);
}

/// Where Chrome installs itself on Windows: per machine (64- or 32-bit Program Files) or per user.
#[cfg(any(windows, test))]
fn chrome_candidates(env: impl Fn(&str) -> Option<String>) -> Vec<std::path::PathBuf> {
  let tail = ["Google", "Chrome", "Application", "chrome.exe"];
  ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]
    .iter()
    .filter_map(|v| env(v))
    .map(|base| tail.iter().fold(std::path::PathBuf::from(base), |p, part| p.join(part)))
    .collect()
}

/// Windows has no handler for chrome:// addresses, so Chrome itself is started with the address. When it is
/// not in a standard place, `start chrome` finds it through its App Paths entry.
#[cfg(windows)]
fn open_chrome_extensions_windows() {
  use std::os::windows::process::CommandExt;
  const CREATE_NO_WINDOW: u32 = 0x0800_0000;
  const URL: &str = "chrome://extensions/";
  if let Some(exe) = chrome_candidates(|v| std::env::var(v).ok()).into_iter().find(|p| p.is_file()) {
    if std::process::Command::new(exe).arg(URL).spawn().is_ok() {
      return;
    }
  }
  if let Err(e) = std::process::Command::new("cmd")
    .args(["/C", "start", "", "chrome", URL])
    .creation_flags(CREATE_NO_WINDOW)
    .spawn()
  {
    log::warn!("could not start Chrome: {e}");
  }
}

fn reveal_zip(app: &AppHandle) {
  let path = agent::dev_repo_root()
    .and_then(|r| agent::extension_zip_in_repo(&r))
    .or_else(|| agent::extension_zip_in_resources(app));
  let Some(p) = path else { return };
  #[cfg(target_os = "macos")]
  {
    let _ = std::process::Command::new("open").arg("-R").arg(&p).spawn();
  }
  // Windows: Explorer opens on the folder with the zip selected.
  #[cfg(windows)]
  {
    let _ = app;
    if let Err(e) = tauri_plugin_opener::reveal_item_in_dir(&p) {
      log::warn!("reveal zip: {e}");
    }
  }
  #[cfg(not(any(target_os = "macos", windows)))]
  let _ = tauri_plugin_opener::OpenerExt::opener(app).open_path(p.to_string_lossy(), None::<&str>);
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn chrome_is_looked_for_where_its_installers_put_it() {
    let env = |v: &str| match v {
      "ProgramFiles" => Some("C:\\Program Files".to_string()),
      "LOCALAPPDATA" => Some("C:\\Users\\alex\\AppData\\Local".to_string()),
      _ => None,
    };
    let found: Vec<String> = chrome_candidates(env).iter().map(|p| p.to_string_lossy().into_owned()).collect();
    assert_eq!(found.len(), 2);
    assert!(found[0].starts_with("C:\\Program Files"));
    assert!(found[0].ends_with("chrome.exe"));
    assert!(found[1].contains("AppData"));
  }
}
