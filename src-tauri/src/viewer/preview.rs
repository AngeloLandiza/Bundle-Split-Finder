//! Development only (debug builds): the page viewer on its own, without the agent, to look at it and to check its
//! security model on a real page while the installed app holds the agent's port. `examples/viewer_preview.rs` runs it:
//!
//!     cargo run --example viewer_preview -- <toolbar page> <first page> [context.json] [probe]
//!
//! The toolbar page is the dashboard bundle from `npm run ui:mock` (for example http://127.0.0.1:5199/#/viewer), which
//! a runtime capability lets call the viewer's own commands, as capabilities/viewer-bar.json does for the agent's port.
//! `probe` then asks the site's page, once it has loaded, to call Tauri commands and to read the agent token, and
//! prints what it got: every call must be refused and the token absent. It is the one script that ever runs in the
//! site's page, and only here.

use std::time::Duration;

use tauri::ipc::CapabilityBuilder;
use tauri::menu::{Menu, MenuItem, SubmenuBuilder};
use tauri::Manager;

use super::model::Context;
use super::{BAR, PAGE};

/// What the preview does after it opens, so each state can be seen without a click: `wait:<seconds>`, `page:<n>` (the
/// deal's page n, as the pop-up's menu chooses it), `menu` (pops the pages menu up), `go:<address>` (our navigation to
/// any address, bypassing the first-page check but not the navigation rule: to show a failed load or a sign-in page).
fn run_steps(app: tauri::AppHandle, steps: Vec<String>) {
  for step in steps {
    if let Some(s) = step.strip_prefix("wait:").and_then(|s| s.parse::<u64>().ok()) {
      std::thread::sleep(Duration::from_secs(s));
    } else if let Some(n) = step.strip_prefix("page:") {
      super::menu_action(&app, &format!("viewer:page:{n}"));
    } else if step == "menu" {
      let handle = app.clone();
      let _ = app.run_on_main_thread(move || {
        if let (Some(window), Ok(Some(menu))) = (handle.get_window(super::WINDOW), super::pages_menu(&handle)) {
          let _ = window.popup_menu_at(&menu, tauri::LogicalPosition::new(84.0, 42.0));
        }
      });
    } else if let Some(url) = step.strip_prefix("go:").and_then(|u| tauri::Url::parse(u).ok()) {
      super::with_model(|m| m.navigate(url.as_str(), super::now()));
      if let Some(page) = app.get_webview(PAGE) {
        let _ = page.navigate(url);
      }
      super::push(&app);
    }
    println!("preview: {step}");
  }
}

pub fn run(tauri_context: tauri::Context<tauri::Wry>, bar_url: String, first: String, context: Option<Context>, probe: bool, steps: Vec<String>) {
  super::preview_bar_url(&bar_url);
  let origin = tauri::Url::parse(&bar_url).expect("toolbar address").origin().ascii_serialization();
  tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    .setup(move |app| {
      let handle = app.handle().clone();
      handle.add_capability(
        CapabilityBuilder::new("viewer-bar-preview")
          .remote(format!("{origin}/*"))
          .webview(BAR)
          .permission("allow-viewer-state")
          .permission("allow-viewer-do")
          .permission("allow-viewer-pages")
          .permission("core:window:allow-start-dragging")
          .permission("core:window:allow-internal-toggle-maximize"),
      )?;
      // The View menu's page items, with a stand-in Scan now whose Cmd+R they borrow, as in the app.
      let scan = MenuItem::with_id(&handle, "scan", "Scan now", true, Some("CmdOrCtrl+R"))?;
      let mut view = SubmenuBuilder::new(&handle, "View");
      for item in super::menu_items(&handle, &scan)? {
        view = view.item(&item);
      }
      let app_menu = SubmenuBuilder::new(&handle, "Viewer preview").item(&scan).quit().build()?;
      let window_menu = SubmenuBuilder::new(&handle, "Window").minimize().close_window().build()?;
      handle.set_menu(Menu::with_items(&handle, &[&app_menu, &view.build()?, &window_menu])?)?;
      handle.on_menu_event(|app, e| {
        let id = e.id().as_ref();
        if id.starts_with("viewer:") {
          super::menu_action(app, id);
        } else if id == "scan" {
          println!("preview: Scan now chosen (in the app this would scan)");
        }
      });
      super::open(&handle, &first, context.clone()).map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
      let steps = steps.clone();
      let later = handle.clone();
      std::thread::spawn(move || run_steps(later, steps));
      if probe {
        std::thread::spawn(move || run_probe(handle));
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![super::viewer_open, super::viewer_state, super::viewer_do, super::viewer_pages, super::viewer_clear_data])
    .run(tauri_context)
    .expect("viewer preview");
}

/// Waits for the site's page, then asks it to reach the app: a viewer command, a core command, a plugin command, and
/// the agent token. Prints each answer (the page writes them into its own address fragment, which the shell reads).
fn run_probe(app: tauri::AppHandle) {
  std::thread::sleep(Duration::from_secs(8));
  let Some(page) = app.get_webview(PAGE) else { return println!("probe: no page") };
  let js = r#"(async function(){
    const out = [];
    const i = window.__TAURI_INTERNALS__;
    out.push('internals=' + (i ? 'present' : 'absent'));
    out.push('token=' + typeof window.__SPLIT_FINDER_TOKEN__);
    out.push('shell=' + typeof window.__SPLIT_FINDER_SHELL__);
    const tryCall = async (name, cmd, args) => {
      if (!i) { out.push(name + '=no-ipc'); return; }
      try { await i.invoke(cmd, args || {}); out.push(name + '=ALLOWED'); }
      catch (e) { out.push(name + '=refused:' + String(e && e.message || e).slice(0, 80).replace(/[^a-zA-Z0-9 .:_-]/g, '')); }
    };
    await tryCall('viewer_do', 'viewer_do', { action: 'copy' });
    await tryCall('viewer_open', 'viewer_open', { url: 'https://www.amazon.com/dp/B0C3YBY7CD' });
    await tryCall('open_external', 'open_external', { url: 'https://example.com' });
    await tryCall('agent_status', 'agent_status');
    await tryCall('window_close', 'plugin:window|close', { label: 'viewer' });
    await tryCall('opener', 'plugin:opener|open_url', { url: 'https://example.com' });
    await tryCall('event_emit', 'plugin:event|emit', { event: 'x', payload: null });
    location.hash = 'probe:' + out.join(';');
  })();"#;
  let _ = page.eval(js);
  std::thread::sleep(Duration::from_secs(4));
  let url = page.url().map(|u| u.to_string()).unwrap_or_default();
  match url.split_once("#probe:") {
    Some((_, result)) => {
      for line in result.split(';') {
        println!("probe: {}", percent_decode(line));
      }
    }
    None => println!("probe: no answer from the page ({url})"),
  }
  // The toolbar must not hold the token either.
  if let Some(bar) = app.get_webview(BAR) {
    let _ = bar.eval("history.replaceState(null, '', '#/viewer-token=' + typeof window.__SPLIT_FINDER_TOKEN__);");
    std::thread::sleep(Duration::from_secs(1));
    println!("probe: toolbar {}", bar.url().map(|u| u.fragment().unwrap_or("").to_string()).unwrap_or_default());
  }
}

fn percent_decode(s: &str) -> String {
  let bytes = s.as_bytes();
  let mut out = Vec::with_capacity(bytes.len());
  let mut i = 0;
  while i < bytes.len() {
    if bytes[i] == b'%' && i + 2 < bytes.len() {
      if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
        out.push(b);
        i += 3;
        continue;
      }
    }
    out.push(bytes[i]);
    i += 1;
  }
  String::from_utf8_lossy(&out).into_owned()
}
