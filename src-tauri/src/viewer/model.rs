//! The page viewer's state, pure (docs/design.md, Desktop app > Page viewer): what the toolbar shows and which of the
//! viewer's own screens covers the page. The window code (mod.rs) feeds it what the webview reports and draws what it
//! says. Times are milliseconds from any fixed start, passed in, so the rules can be tested without a clock.

use serde::{Deserialize, Serialize};
use tauri::Url;

use super::policy;

/// One of a deal's source pages, as the toolbar's page pop-up lists it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextPage {
  /// "Home Depot · PSK1212SB-PCL633B", "Amazon · PCG002".
  pub label: String,
  pub url: String,
}

/// What the viewer was opened from: a deal, its title and its source pages.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Context {
  pub title: String,
  pub pages: Vec<ContextPage>,
}

/// The longest a context's words may be, and how many pages it may list: the page is ours, but its text is stored data.
const MAX_LABEL: usize = 120;
const MAX_PAGES: usize = 40;

impl Context {
  /// The context with only the pages the viewer may open, and words cut to size. None when no page is left.
  pub fn checked(self) -> Option<Context> {
    let cut = |s: &str| s.chars().filter(|c| !c.is_control()).take(MAX_LABEL).collect::<String>();
    let pages: Vec<ContextPage> = self
      .pages
      .iter()
      .filter_map(|p| policy::first_page(&p.url).map(|(u, _)| ContextPage { label: cut(&p.label), url: u.to_string() }))
      .take(MAX_PAGES)
      .collect();
    if pages.is_empty() {
      return None;
    }
    Some(Context { title: cut(&self.title), pages })
  }
}

/// Which surface fills the page area.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Screen {
  /// The site's own page.
  Page,
  /// Our own state: the page did not load (offline, no answer).
  Failed { url: String },
  /// Our own state: the page asks him to sign in or pay.
  SignIn { url: String },
}

/// What the native webview says about itself, read each poll (macOS; Windows reports back and forward only).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Snapshot {
  pub url: Option<String>,
  /// None when the platform cannot tell.
  pub loading: Option<bool>,
  pub progress: Option<f64>,
  pub can_back: bool,
  pub can_forward: bool,
}

/// After our own navigation, how long WebKit may stay quiet before an idle, uncommitted load counts as failed.
const SETTLE_MS: u64 = 600;

#[derive(Debug, Clone, PartialEq)]
pub struct Model {
  pub context: Option<Context>,
  /// The webview's real address, never the page's own text.
  pub url: Option<String>,
  pub loading: bool,
  pub progress: Option<f64>,
  pub can_back: bool,
  pub can_forward: bool,
  pub screen: Screen,
  /// Our last navigation (open, a context page, Try again) until its page commits.
  pending: Option<(String, u64)>,
}

/// What the toolbar draws (desktop-ui/src/screens/ViewerBar.tsx reads exactly this).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BarState {
  pub url: Option<String>,
  pub loading: bool,
  pub progress: Option<f64>,
  pub can_back: bool,
  pub can_forward: bool,
  pub screen: Screen,
  /// The deal's title, when opened from a deal.
  pub title: Option<String>,
  /// "Amazon · PCG002" when the page on screen is one of the deal's; else the site's name, or None.
  pub label: Option<String>,
  pub pages: usize,
  /// Which of the deal's pages is on screen (0-based), when one is.
  pub current: Option<usize>,
}

impl Model {
  pub fn new() -> Self {
    Model { context: None, url: None, loading: false, progress: None, can_back: false, can_forward: false, screen: Screen::Page, pending: None }
  }

  /// A link was opened (from the app) or one of the deal's pages chosen: our navigation to `url`.
  pub fn navigate(&mut self, url: &str, now: u64) {
    self.url = Some(url.to_string());
    self.loading = true;
    self.progress = None;
    self.screen = Screen::Page;
    self.pending = Some((url.to_string(), now));
  }

  pub fn open(&mut self, url: &str, context: Option<Context>, now: u64) {
    self.context = context;
    self.can_back = false;
    self.can_forward = false;
    self.navigate(url, now);
  }

  /// The webview committed a page (main frame): it is now on screen, unless it is a sign-in page.
  pub fn committed(&mut self, url: &str) {
    self.pending = None;
    self.url = Some(url.to_string());
    self.loading = true;
    self.screen = match Url::parse(url) {
      Ok(u) if policy::asks_sign_in(&u) => Screen::SignIn { url: url.to_string() },
      _ => Screen::Page,
    };
  }

  /// The webview finished loading the page.
  pub fn finished(&mut self, url: &str) {
    if self.pending.is_none() {
      self.url = Some(url.to_string());
    }
    self.loading = false;
    self.progress = None;
  }

  /// A poll of the native webview. An address change without a load (a page's own history, as Amazon does on a
  /// variant) moves the address; a load of ours that ended without its page committing is a failed load.
  pub fn polled(&mut self, s: &Snapshot, now: u64) {
    self.can_back = s.can_back;
    self.can_forward = s.can_forward;
    if let Some(loading) = s.loading {
      if let Some((target, at)) = &self.pending {
        if !loading && now.saturating_sub(*at) >= SETTLE_MS {
          self.screen = Screen::Failed { url: target.clone() };
          self.pending = None;
          self.loading = false;
          self.progress = None;
          return;
        }
      }
      self.loading = loading || self.pending.is_some();
      self.progress = if self.loading { s.progress.filter(|p| p.is_finite()).map(|p| p.clamp(0.0, 1.0)) } else { None };
    }
    if self.pending.is_none() {
      if let Some(u) = &s.url {
        if !u.is_empty() && u != "about:blank" {
          self.url = Some(u.clone());
          if let (Screen::SignIn { .. }, Ok(parsed)) = (&self.screen, Url::parse(u)) {
            if !policy::asks_sign_in(&parsed) {
              self.screen = Screen::Page;
            }
          }
        }
      }
    }
  }

  /// Stop: the load is abandoned, and the page as it stands stays.
  pub fn stopped(&mut self) {
    self.pending = None;
    self.loading = false;
    self.progress = None;
  }

  /// The address Open in browser, Copy link and Try again use: the failed or sign-in page's, else the page's own.
  pub fn address(&self) -> Option<String> {
    match &self.screen {
      Screen::Failed { url } | Screen::SignIn { url } => Some(url.clone()),
      Screen::Page => self.url.clone(),
    }
  }

  /// Which of the deal's pages is the one on screen.
  pub fn current(&self) -> Option<usize> {
    let ctx = self.context.as_ref()?;
    let here = Url::parse(self.address()?.as_str()).ok()?;
    let key = policy::page_key(&here);
    ctx.pages.iter().position(|p| Url::parse(&p.url).map(|u| policy::page_key(&u) == key).unwrap_or(false))
  }

  pub fn bar(&self) -> BarState {
    let current = self.current();
    let label = match (current, &self.context) {
      (Some(i), Some(ctx)) => Some(ctx.pages[i].label.clone()),
      _ => self.address().and_then(|a| Url::parse(&a).ok()).and_then(|u| policy::site_name(&u).map(str::to_string)),
    };
    BarState {
      url: self.address(),
      loading: self.loading,
      progress: self.progress,
      can_back: self.can_back,
      can_forward: self.can_forward,
      screen: self.screen.clone(),
      title: self.context.as_ref().map(|c| c.title.clone()),
      label,
      pages: self.context.as_ref().map(|c| c.pages.len()).unwrap_or(0),
      current,
    }
  }

  /// The window's title: what the page is, for the Window menu, Mission Control and the Windows title bar.
  pub fn window_title(&self) -> String {
    let bar = self.bar();
    match (bar.label, bar.url.as_deref().and_then(|u| Url::parse(u).ok())) {
      (Some(l), _) => l,
      (None, Some(u)) => u.host_str().unwrap_or("Page").to_string(),
      (None, None) => "Page".to_string(),
    }
  }
}

pub const DEFAULT_SIZE: (f64, f64) = (1100.0, 820.0);
pub const MIN_SIZE: (f64, f64) = (640.0, 420.0);
const GAP: f64 = 8.0;
const INSET: f64 = 40.0;

/// A rectangle in logical points.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Area {
  pub x: f64,
  pub y: f64,
  pub width: f64,
  pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Placement {
  /// None: centred by the system.
  pub x: Option<f64>,
  pub y: Option<f64>,
  pub width: f64,
  pub height: f64,
}

/// Where the viewer first opens: beside the main window on the side with more room when one side fits it, else over
/// the main window, 40pt in. It never asks the main window to move.
pub fn place(main: Option<Area>, screen: Option<Area>) -> Placement {
  let (Some(main), Some(screen)) = (main, screen) else {
    return Placement { x: None, y: None, width: DEFAULT_SIZE.0, height: DEFAULT_SIZE.1 };
  };
  let height = DEFAULT_SIZE.1.min(screen.height).max(MIN_SIZE.1);
  let top = main.y.clamp(screen.y, (screen.y + screen.height - height).max(screen.y));
  let right = screen.x + screen.width - (main.x + main.width) - GAP;
  let left = main.x - screen.x - GAP;
  if right >= MIN_SIZE.0 && right >= left {
    let width = DEFAULT_SIZE.0.min(right);
    return Placement { x: Some(main.x + main.width + GAP), y: Some(top), width, height };
  }
  if left >= MIN_SIZE.0 {
    let width = DEFAULT_SIZE.0.min(left);
    return Placement { x: Some(main.x - GAP - width), y: Some(top), width, height };
  }
  let x = (main.x + INSET).min(screen.x + screen.width - MIN_SIZE.0).max(screen.x);
  let y = (main.y + INSET).min(screen.y + screen.height - MIN_SIZE.1).max(screen.y);
  let width = DEFAULT_SIZE.0.min(screen.x + screen.width - x).max(MIN_SIZE.0);
  let height = DEFAULT_SIZE.1.min(screen.y + screen.height - y).max(MIN_SIZE.1);
  Placement { x: Some(x), y: Some(y), width, height }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_window_opens_beside_the_main_window_when_a_side_has_room_else_over_it() {
    let screen = Area { x: 0.0, y: 25.0, width: 2560.0, height: 1415.0 };
    // A 1280-wide main window at the left of a wide screen: to its right.
    let p = place(Some(Area { x: 40.0, y: 60.0, width: 1280.0, height: 800.0 }), Some(screen));
    assert_eq!((p.x, p.y, p.width), (Some(1328.0), Some(60.0), 1100.0));
    // At the right: to its left, as wide as fits.
    let p = place(Some(Area { x: 1240.0, y: 60.0, width: 1280.0, height: 800.0 }), Some(screen));
    assert_eq!(p.x, Some(1240.0 - 8.0 - 1100.0));
    // A laptop screen the main window fills: over it, 40pt in, inside the screen.
    let laptop = Area { x: 0.0, y: 25.0, width: 1512.0, height: 920.0 };
    let p = place(Some(Area { x: 0.0, y: 25.0, width: 1512.0, height: 920.0 }), Some(laptop));
    assert_eq!((p.x, p.y), (Some(40.0), Some(65.0)));
    assert!(p.x.unwrap() + p.width <= 1512.0);
    assert!(p.y.unwrap() + p.height <= 945.0);
    // Nothing known: the system centres it.
    assert_eq!(place(None, None).x, None);
  }

  const HD: &str = "https://www.homedepot.com/p/322138483";
  const PART: &str = "https://www.amazon.com/dp/B0C3YBY7CD";

  fn deal() -> Context {
    Context {
      title: "RYOBI ONE+ 18V Cordless 2-Tool Combo Kit".into(),
      pages: vec![
        ContextPage { label: "Home Depot · PCL1200K2".into(), url: HD.into() },
        ContextPage { label: "Amazon · PCL205B".into(), url: PART.into() },
      ],
    }
  }

  #[test]
  fn a_context_keeps_only_pages_the_viewer_may_open() {
    let mut c = deal();
    c.pages.push(ContextPage { label: "Seller Central".into(), url: "https://sellercentral.amazon.com/".into() });
    c.pages.push(ContextPage { label: "Agent".into(), url: "http://127.0.0.1:8790/ui/".into() });
    c.title = format!("{}\u{7}", "x".repeat(300));
    let c = c.checked().unwrap();
    assert_eq!(c.pages.len(), 2);
    assert_eq!(c.title.chars().count(), MAX_LABEL);
    assert!(!c.title.contains('\u{7}'));
    let none = Context { title: "t".into(), pages: vec![ContextPage { label: "x".into(), url: "chrome://extensions".into() }] };
    assert!(none.checked().is_none());
  }

  #[test]
  fn opening_loads_then_shows_the_page_and_names_it() {
    let mut m = Model::new();
    m.open(HD, Some(deal()), 0);
    assert!(m.loading);
    assert_eq!(m.bar().label.as_deref(), Some("Home Depot · PCL1200K2"));
    m.committed("https://www.homedepot.com/p/RYOBI-ONE-Kit/322138483");
    m.finished("https://www.homedepot.com/p/RYOBI-ONE-Kit/322138483");
    let bar = m.bar();
    assert!(!bar.loading);
    assert_eq!(bar.screen, Screen::Page);
    assert_eq!(bar.current, Some(0));
    assert_eq!(bar.pages, 2);
    assert_eq!(bar.url.as_deref(), Some("https://www.homedepot.com/p/RYOBI-ONE-Kit/322138483"));
    assert_eq!(m.window_title(), "Home Depot · PCL1200K2");
  }

  #[test]
  fn a_load_that_ends_without_its_page_is_failed() {
    let mut m = Model::new();
    m.open(PART, None, 1_000);
    // WebKit has not started yet: too early to judge.
    m.polled(&Snapshot { loading: Some(false), ..Default::default() }, 1_100);
    assert_eq!(m.screen, Screen::Page);
    assert!(m.loading);
    m.polled(&Snapshot { loading: Some(true), progress: Some(0.1), ..Default::default() }, 1_400);
    assert_eq!(m.bar().progress, Some(0.1));
    m.polled(&Snapshot { loading: Some(false), ..Default::default() }, 2_000);
    assert_eq!(m.screen, Screen::Failed { url: PART.into() });
    assert!(!m.loading);
    // Try again is our navigation to the same page.
    m.navigate(PART, 3_000);
    assert_eq!(m.screen, Screen::Page);
    m.committed(PART);
    m.polled(&Snapshot { loading: Some(false), url: Some(PART.into()), ..Default::default() }, 9_000);
    assert_eq!(m.screen, Screen::Page);
  }

  #[test]
  fn windows_reports_no_loading_state_and_never_fails_a_load_by_itself() {
    let mut m = Model::new();
    m.open(PART, None, 0);
    m.polled(&Snapshot { loading: None, can_back: false, ..Default::default() }, 60_000);
    assert_eq!(m.screen, Screen::Page);
    assert!(m.loading);
  }

  #[test]
  fn a_sign_in_page_is_covered_and_going_back_uncovers_it() {
    let mut m = Model::new();
    m.open(PART, Some(deal()), 0);
    m.committed(PART);
    m.finished(PART);
    m.committed("https://www.amazon.com/ap/signin?openid.return_to=x");
    assert!(matches!(m.screen, Screen::SignIn { .. }));
    // Open in browser and Copy link use the sign-in page's own address.
    assert!(m.address().unwrap().contains("/ap/signin"));
    m.committed(PART);
    assert_eq!(m.screen, Screen::Page);
    assert_eq!(m.bar().current, Some(1));
  }

  #[test]
  fn a_page_moving_its_own_address_moves_the_field() {
    let mut m = Model::new();
    m.open(PART, Some(deal()), 0);
    m.committed(PART);
    m.finished(PART);
    m.polled(&Snapshot { url: Some("https://www.amazon.com/dp/B0C3YBY7CD?th=1".into()), loading: Some(false), can_back: true, ..Default::default() }, 5_000);
    let bar = m.bar();
    assert_eq!(bar.url.as_deref(), Some("https://www.amazon.com/dp/B0C3YBY7CD?th=1"));
    assert!(bar.can_back);
    assert_eq!(bar.current, Some(1));
    // Away from the deal's pages: the site's name.
    m.committed("https://www.amazon.com/dp/B000000001");
    assert_eq!(m.bar().current, None);
    assert_eq!(m.bar().label.as_deref(), Some("Amazon"));
  }

  #[test]
  fn stop_keeps_the_page() {
    let mut m = Model::new();
    m.open(PART, None, 0);
    m.stopped();
    m.polled(&Snapshot { loading: Some(false), ..Default::default() }, 10_000);
    assert_eq!(m.screen, Screen::Page);
    assert!(!m.loading);
  }
}
