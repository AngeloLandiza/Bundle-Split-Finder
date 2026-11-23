//! The menu bar popover and the Dock badge (step 14, D4).
//!
//! A left click on the menu bar icon toggles a small borderless window under the icon; a right click
//! keeps the tray menu. The window loads the dashboard's `#/popover` route (desktop-ui) with the same
//! token as the main window. It hides when it loses focus or on Esc (the page asks), and it is never
//! restored by the window-state plugin (lib.rs denies its label).
//!
//! The Dock badge is the open-question count, set from the same state events as the tray menu
//! (events.rs -> shell::set_open_questions). With the Dock icon hidden there is no badge.
//!
//! Windows: the same popover from the notification-area icon, above it when the taskbar is at the
//! bottom (anchor_in). There is no Dock, and no taskbar overlay badge: the count is in the tray tooltip.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[cfg(not(windows))]
use tauri::LogicalPosition;
use tauri::{AppHandle, Manager, Rect, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

use crate::{agent, shell};

pub const LABEL: &str = "popover";

/// Points. design.md, Desktop app > Menu bar popover.
const WIDTH: f64 = 340.0;
const HEIGHT: f64 = 420.0;
/// Between the menu bar and the popover, and the least distance to a screen edge.
const GAP: f64 = 4.0;
const EDGE: f64 = 8.0;
/// A tray click this soon after the popover hid itself on losing focus is the click that closed it:
/// macOS takes focus away on the mouse down, so the mouse up must not open it again.
const REOPEN_GUARD: Duration = Duration::from_millis(300);

static LAST_BLUR_HIDE: Mutex<Option<Instant>> = Mutex::new(None);

/// Builds the window hidden, so the first click shows it at once. Nothing to do without a proven token
/// (the page could not talk to the agent); `toggle` tries again.
pub fn prepare(app: &AppHandle) {
  if let Err(e) = create(app) {
    log::info!("popover not prepared: {e}");
  }
}

fn create(app: &AppHandle) -> Result<WebviewWindow, String> {
  if let Some(w) = app.get_webview_window(LABEL) {
    return Ok(w);
  }
  let token = agent::proven_token(app).ok_or("the agent has not proven itself")?;
  let url = tauri::Url::parse(&format!("{}#/popover", agent::UI_URL)).map_err(|e| e.to_string())?;
  let (w, h) = window_size();
  let builder = shell::webview_options(WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(url)))
    .title("Split Finder")
    .inner_size(w, h)
    .resizable(false)
    .decorations(false)
    // Windows: the page draws the flyout's shadow in the transparent margin; a native one would frame the margin.
    .shadow(!cfg!(windows))
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .accept_first_mouse(true)
    .visible(false)
    .focused(false)
    .initialization_script(shell::init_script(Some(&token), false))
    // A page that finishes loading after the window was shown has missed the "opened" event.
    .on_page_load(|w, payload| {
      if payload.event() == tauri::webview::PageLoadEvent::Finished && w.is_visible().unwrap_or(false) {
        announce(&w, true);
      }
    });
  let window = effects(builder).build().map_err(|e| e.to_string())?;

  let app = app.clone();
  window.on_window_event(move |event| {
    if let WindowEvent::Focused(false) = event {
      if let Some(w) = app.get_webview_window(LABEL) {
        if w.is_visible().unwrap_or(false) {
          if let Ok(mut g) = LAST_BLUR_HIDE.lock() {
            *g = Some(Instant::now());
          }
          hide(&app);
        }
      }
    }
  });
  Ok(window)
}

/// The popover material behind a transparent webview, with the rounded corners the page paints inside.
/// Elsewhere the window stays an opaque borderless one.
fn effects<'a>(
  builder: WebviewWindowBuilder<'a, tauri::Wry, AppHandle>,
) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
  #[cfg(target_os = "macos")]
  {
    use tauri::window::{Effect, EffectState, EffectsBuilder};
    builder.transparent(true).effects(
      EffectsBuilder::new()
        .effect(Effect::Popover)
        // Always vibrant: the popover never is the key window of an active app in a way the material follows.
        .state(EffectState::Active)
        .radius(10.0)
        .build(),
    )
  }
  // Windows: a transparent borderless window MARGIN larger than the flyout on each side, so the shadow the
  // page draws (desktop-ui windows.css) is not cut off; the page is moved in by MARGIN to sit inside it.
  #[cfg(windows)]
  {
    builder.transparent(true).initialization_script(format!(
      "document.addEventListener('DOMContentLoaded', function () {{ var s = document.createElement('style'); \
       s.textContent = \":root[data-surface='popover'] body {{ padding: {MARGIN}px; margin: 0; }}\"; \
       document.head.appendChild(s); }});"
    ))
  }
  #[cfg(not(any(target_os = "macos", windows)))]
  {
    builder
  }
}

/// Room around the flyout for its shadow, on Windows; none on a Mac (the material carries its own).
const MARGIN: f64 = if cfg!(windows) { 12.0 } else { 0.0 };

/// The window: the flyout and its margin, in points.
fn window_size() -> (f64, f64) {
  (WIDTH + 2.0 * MARGIN, HEIGHT + 2.0 * MARGIN)
}

/// Tells the page it is on screen or not; it follows the agent's events only while it is.
fn announce(window: &WebviewWindow, open: bool) {
  let _ = window.eval(&format!(
    "try {{ window.dispatchEvent(new CustomEvent('split-finder:popover', {{ detail: {{ open: {open} }} }})); }} catch (e) {{}}"
  ));
}

pub fn hide(app: &AppHandle) {
  if let Some(w) = app.get_webview_window(LABEL) {
    let _ = w.hide();
    announce(&w, false);
  }
}

/// The tray icon was clicked with the left button: show the popover under the icon, or hide it.
pub fn toggle(app: &AppHandle, tray: &Rect) {
  let Ok(window) = create(app) else {
    // No popover without the agent: the window explains why (shell::create_window).
    shell::show_window(app);
    return;
  };
  if window.is_visible().unwrap_or(false) {
    hide(app);
    return;
  }
  let just_closed = LAST_BLUR_HIDE
    .lock()
    .ok()
    .and_then(|mut g| g.take())
    .is_some_and(|at| at.elapsed() < REOPEN_GUARD);
  if just_closed {
    return;
  }
  place(&window, tray);
  let _ = window.show();
  let _ = window.set_focus();
  announce(&window, true);
}

/// Where the popover's top-left goes, in points on the screen: centred under the icon, kept 8pt inside
/// the screen's edges. `icon` is the icon's rect and `screen` the screen's, both in points.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn anchor(icon: (f64, f64, f64, f64), screen: (f64, f64, f64, f64)) -> (f64, f64) {
  anchor_in(icon, screen, (WIDTH, HEIGHT), GAP, EDGE)
}

/// The same rule for any taskbar edge: centred on the icon, under it when the icon is in the top half of
/// `area` (the macOS menu bar, a Windows taskbar at the top) and above it otherwise (the Windows taskbar at
/// the bottom, the default), then kept `edge` inside `area` on every side. On Windows `area` is the
/// monitor's work area, so a taskbar on the left or right is never covered. All in one unit.
fn anchor_in(
  icon: (f64, f64, f64, f64),
  area: (f64, f64, f64, f64),
  size: (f64, f64),
  gap: f64,
  edge: f64,
) -> (f64, f64) {
  let (ix, iy, iw, ih) = icon;
  let (ax, ay, aw, ah) = area;
  let (w, h) = size;
  let x = (ix + iw / 2.0 - w / 2.0).min(ax + aw - w - edge).max(ax + edge);
  let below = iy + ih / 2.0 < ay + ah / 2.0;
  let y = if below { iy + ih + gap } else { iy - h - gap };
  (x, y.min(ay + ah - h - edge).max(ay + edge))
}

#[cfg(windows)]
fn place(window: &WebviewWindow, tray: &Rect) {
  use tauri::PhysicalPosition;
  // Windows works in physical pixels throughout: the tray rect, the monitor and its work area.
  let mut pos = tray.position.to_physical::<f64>(1.0);
  let mut size = tray.size.to_physical::<f64>(1.0);
  // An icon in the overflow flyout (Windows 11 puts new icons there) may report no rect: the pointer is on it.
  if size.width < 1.0 || size.height < 1.0 {
    if let Ok(c) = window.cursor_position() {
      pos = PhysicalPosition::new(c.x, c.y);
      size = tauri::PhysicalSize::new(1.0, 1.0);
    }
  }
  let monitor = window
    .monitor_from_point(pos.x + size.width / 2.0, pos.y + size.height / 2.0)
    .ok()
    .flatten()
    .or_else(|| window.primary_monitor().ok().flatten());
  let Some(m) = monitor else { return };
  let s = m.scale_factor();
  let wa = m.work_area();
  let (x, y) = anchor_in(
    (pos.x, pos.y, size.width, size.height),
    (wa.position.x as f64, wa.position.y as f64, wa.size.width as f64, wa.size.height as f64),
    (window_size().0 * s, window_size().1 * s),
    // The visible flyout sits MARGIN inside the window: 12px off the taskbar and the screen's edges.
    0.0,
    0.0,
  );
  let _ = window.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
}

#[cfg(not(windows))]
fn place(window: &WebviewWindow, tray: &Rect) {
  // The icon's rect arrives in physical pixels. The screen it is on gives the scale to turn it into points.
  let phys_pos = tray.position.to_physical::<f64>(1.0);
  let phys_size = tray.size.to_physical::<f64>(1.0);
  let monitor = window
    .monitor_from_point(phys_pos.x + phys_size.width / 2.0, phys_pos.y + phys_size.height / 2.0)
    .ok()
    .flatten()
    .or_else(|| window.primary_monitor().ok().flatten());
  let Some(m) = monitor else { return };
  let s = m.scale_factor();
  let icon = (phys_pos.x / s, phys_pos.y / s, phys_size.width / s, phys_size.height / s);
  let screen = (
    m.position().x as f64 / s,
    m.position().y as f64 / s,
    m.size().width as f64 / s,
    m.size().height as f64 / s,
  );
  let (x, y) = anchor(icon, screen);
  let _ = window.set_position(LogicalPosition::new(x, y));
}

/// The commands the popover page may call (capabilities/popover.json): it can hide itself, open the
/// main window (at a screen), open Preferences, and quit. Everything else it does through the agent's API.
#[tauri::command]
pub fn popover_do(app: AppHandle, action: String, route: Option<String>) -> Result<(), String> {
  match action.as_str() {
    "hide" => hide(&app),
    "open" => {
      hide(&app);
      match route.as_deref() {
        Some(r) if route_allowed(r) => shell::navigate(&app, r),
        Some(_) => return Err("not a screen of Split Finder".into()),
        None => shell::handle_menu(&app, "open"),
      }
    }
    // The one place Preferences is reached from: the "settings" menu item (Cmd+,).
    "preferences" => {
      hide(&app);
      shell::handle_menu(&app, "settings");
    }
    "quit" => shell::handle_menu(&app, "quit"),
    _ => return Err("unknown action".into()),
  }
  Ok(())
}

/// Only the screens the dashboard has, with an optional id: "/review/abc", "/deals/123".
fn route_allowed(route: &str) -> bool {
  let mut parts = route.strip_prefix('/').unwrap_or("").splitn(2, '/');
  let screen = parts.next().unwrap_or("");
  let id_ok = parts
    .next()
    .map_or(true, |id| !id.is_empty() && id.len() <= 200 && id.chars().all(|c| c.is_ascii_graphic()));
  matches!(screen, "today" | "deals" | "review" | "activity" | "settings") && id_ok
}

// ------------------------------------------------------------------ the Dock badge

static QUESTIONS: AtomicU32 = AtomicU32::new(0);
static DOCK_SHOWN: AtomicBool = AtomicBool::new(true);
/// What the Dock tile shows now, so a repeated state event sets nothing.
static APPLIED: Mutex<Option<Option<String>>> = Mutex::new(None);

/// The badge text: the open-question count, nothing at 0, nothing without a Dock icon.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn badge_label(questions: u32, dock_shown: bool) -> Option<String> {
  (dock_shown && questions > 0).then(|| questions.to_string())
}

/// The menu bar icon's count text. With the Dock icon shown the count is its badge, and the menu bar
/// icon stays a plain icon; with it hidden the count has no other place to be seen at a glance.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn tray_title(questions: u32, dock_shown: bool) -> Option<String> {
  (!dock_shown && questions > 0).then(|| questions.to_string())
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn dock_shown() -> bool {
  DOCK_SHOWN.load(Ordering::Relaxed)
}

pub fn set_open_questions(app: &AppHandle, n: u32) {
  QUESTIONS.store(n, Ordering::Relaxed);
  refresh_badge(app);
}

/// `settings.shell.dockIcon`. Returns true when it changed.
pub fn set_dock_icon(app: &AppHandle, shown: bool) -> bool {
  let changed = DOCK_SHOWN.swap(shown, Ordering::Relaxed) != shown;
  if changed {
    // The tile may have been rebuilt by the activation policy change: set the label again.
    if let Ok(mut g) = APPLIED.lock() {
      *g = None;
    }
    refresh_badge(app);
  }
  changed
}

fn refresh_badge(app: &AppHandle) {
  #[cfg(target_os = "macos")]
  {
    let want = badge_label(QUESTIONS.load(Ordering::Relaxed), DOCK_SHOWN.load(Ordering::Relaxed));
    let Ok(mut applied) = APPLIED.lock() else { return };
    if applied.as_ref() == Some(&want) {
      return;
    }
    // The Dock tile belongs to the app; Tauri sets it through any window. The popover is built first.
    let Some(window) = app
      .get_webview_window(LABEL)
      .or_else(|| app.get_webview_window(shell::MAIN))
    else {
      return;
    };
    match window.set_badge_label(want.clone()) {
      Ok(()) => *applied = Some(want),
      Err(e) => log::warn!("dock badge: {e}"),
    }
  }
  #[cfg(not(target_os = "macos"))]
  let _ = app;
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn badge_is_the_count_and_clears_at_zero() {
    assert_eq!(badge_label(0, true), None);
    assert_eq!(badge_label(7, true), Some("7".into()));
    assert_eq!(badge_label(120, true), Some("120".into()));
  }

  #[test]
  fn no_dock_icon_no_badge_but_the_count_moves_to_the_menu_bar() {
    assert_eq!(badge_label(7, false), None);
    assert_eq!(tray_title(7, false), Some("7".into()));
    assert_eq!(tray_title(7, true), None);
    assert_eq!(tray_title(0, false), None);
  }

  #[test]
  fn popover_centres_under_the_icon_and_stays_on_screen() {
    let screen = (0.0, 0.0, 1440.0, 900.0);
    // Mid-screen icon: centred, 4pt under the menu bar.
    assert_eq!(anchor((1000.0, 0.0, 28.0, 24.0), screen), (1000.0 + 14.0 - 170.0, 28.0));
    // Icon at the right edge: the popover stops 8pt short of it.
    assert_eq!(anchor((1420.0, 0.0, 20.0, 24.0), screen).0, 1440.0 - 340.0 - 8.0);
    // A second screen to the left of the first: the clamp follows that screen.
    assert_eq!(anchor((-1900.0, 0.0, 20.0, 24.0), (-1920.0, 0.0, 1920.0, 1080.0)).0, -1920.0 + 8.0);
  }

  // Windows, in physical pixels at 150%: a 1920x1080 monitor, the popover 510x630, gap 6, edge 12.
  const WIN: (f64, f64) = (340.0 * 1.5, 420.0 * 1.5);

  #[test]
  fn windows_taskbar_at_the_bottom_puts_the_popover_above_the_icon() {
    // Work area 1920x1032 (a 48px taskbar below it); the icon near the clock.
    let (x, y) = anchor_in((1700.0, 1040.0, 36.0, 36.0), (0.0, 0.0, 1920.0, 1032.0), WIN, 6.0, 12.0);
    assert_eq!(x, 1920.0 - 510.0 - 12.0);
    // Above the icon would reach into the taskbar's band: it stops 12px above the work area's bottom.
    assert_eq!(y, 1032.0 - 630.0 - 12.0);
  }

  #[test]
  fn windows_taskbar_at_the_top_puts_it_below() {
    let (x, y) = anchor_in((1000.0, 8.0, 36.0, 36.0), (0.0, 48.0, 1920.0, 1032.0), WIN, 6.0, 12.0);
    assert_eq!(x, 1018.0 - 255.0);
    // Under the icon would be 50, inside the taskbar's band: the work area's top edge keeps it at 60.
    assert_eq!(y, 60.0);
  }

  #[test]
  fn windows_taskbar_on_the_left_or_right_is_not_covered() {
    // Left: the work area starts at 62; the icon sits low in the taskbar.
    let (x, y) = anchor_in((12.0, 980.0, 36.0, 36.0), (62.0, 0.0, 1858.0, 1080.0), WIN, 6.0, 12.0);
    assert_eq!(x, 62.0 + 12.0);
    assert_eq!(y, 980.0 - 630.0 - 6.0);
    // Right: the work area ends at 1858.
    let (x, _) = anchor_in((1870.0, 980.0, 36.0, 36.0), (0.0, 0.0, 1858.0, 1080.0), WIN, 6.0, 12.0);
    assert_eq!(x, 1858.0 - 510.0 - 12.0);
  }

  #[test]
  fn only_the_dashboards_screens_may_be_opened() {
    assert!(route_allowed("/review/abc-123"));
    assert!(route_allowed("/deals/4f2a"));
    assert!(route_allowed("/today"));
    assert!(!route_allowed("/popover"));
    assert!(!route_allowed("review"));
    assert!(!route_allowed("/review/"));
    assert!(!route_allowed("/review/a b"));
    // The id arrives percent-encoded (encodeURIComponent), and the page decodes it again.
    assert!(route_allowed("/review/q%2F1%20a"));
  }
}
