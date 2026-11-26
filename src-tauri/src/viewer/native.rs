//! The few things Tauri's `Webview` does not offer, asked of the platform's own web view: back, forward, stop, and
//! whether it can go back or forward or is loading. Nothing here runs script in the site's page.
//! macOS: WKWebView (`goBack`, `goForward`, `stopLoading`, `canGoBack`, `canGoForward`, `isLoading`, `estimatedProgress`).
//! Windows: ICoreWebView2 (`GoBack`, `GoForward`, `Stop`, `CanGoBack`, `CanGoForward`); it reports no loading state.

use std::sync::mpsc;
use std::time::Duration;

use tauri::Webview;

use super::model::Snapshot;

#[derive(Clone, Copy)]
pub enum Action {
  Back,
  Forward,
  Stop,
}

pub fn act(page: &Webview, action: Action) {
  let _ = page.with_webview(move |w| {
    #[cfg(target_os = "macos")]
    unsafe {
      use objc2::msg_send;
      use objc2::runtime::AnyObject;
      let view = w.inner() as *mut AnyObject;
      if view.is_null() {
        return;
      }
      let view = &*view;
      match action {
        Action::Back => {
          let _: *mut AnyObject = msg_send![view, goBack];
        }
        Action::Forward => {
          let _: *mut AnyObject = msg_send![view, goForward];
        }
        Action::Stop => {
          let _: () = msg_send![view, stopLoading];
        }
      }
    }
    #[cfg(windows)]
    unsafe {
      if let Ok(core) = w.controller().CoreWebView2() {
        let _ = match action {
          Action::Back => core.GoBack(),
          Action::Forward => core.GoForward(),
          Action::Stop => core.Stop(),
        };
      }
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
      let _ = (w, action);
    }
  });
}

/// What the web view says about itself now, or None when it did not answer in time (the window is closing).
pub fn snapshot(page: &Webview) -> Option<Snapshot> {
  let (tx, rx) = mpsc::channel::<Snapshot>();
  let url = page.url().ok().map(|u| u.to_string());
  page
    .with_webview(move |w| {
      #[allow(unused_mut)]
      let mut s = Snapshot { url, ..Default::default() };
      #[cfg(target_os = "macos")]
      unsafe {
        use objc2::msg_send;
        use objc2::runtime::AnyObject;
        let view = w.inner() as *mut AnyObject;
        if !view.is_null() {
          let view = &*view;
          let loading: bool = msg_send![view, isLoading];
          let progress: f64 = msg_send![view, estimatedProgress];
          s.loading = Some(loading);
          s.progress = Some(progress);
          s.can_back = msg_send![view, canGoBack];
          s.can_forward = msg_send![view, canGoForward];
        }
      }
      #[cfg(windows)]
      unsafe {
        if let Ok(core) = w.controller().CoreWebView2() {
          let mut b = windows::core::BOOL::default();
          if core.CanGoBack(&mut b).is_ok() {
            s.can_back = b.as_bool();
          }
          let mut f = windows::core::BOOL::default();
          if core.CanGoForward(&mut f).is_ok() {
            s.can_forward = f.as_bool();
          }
        }
      }
      #[cfg(not(any(target_os = "macos", windows)))]
      let _ = w;
      let _ = tx.send(s);
    })
    .ok()?;
  rx.recv_timeout(Duration::from_millis(800)).ok()
}

/// The macOS major version, for the separate browsing-data store (WKWebsiteDataStore by identifier needs macOS 14).
#[cfg(target_os = "macos")]
pub fn macos_major() -> u32 {
  static MAJOR: std::sync::OnceLock<u32> = std::sync::OnceLock::new();
  *MAJOR.get_or_init(|| {
    std::process::Command::new("/usr/bin/sw_vers")
      .arg("-productVersion")
      .output()
      .ok()
      .and_then(|o| String::from_utf8(o.stdout).ok())
      .and_then(|v| v.trim().split('.').next().and_then(|m| m.parse().ok()))
      .unwrap_or(0)
  })
}

/// Puts plain text on the clipboard: the toolbar's Copy link and Cmd+Shift+C, which must work while the focus is in
/// the site's page (where no script of ours runs). The address is ASCII: the URL parser percent-encodes the rest and
/// writes the host in punycode.
pub fn copy_text(text: &str) -> Result<(), String> {
  use std::io::Write;
  if !text.is_ascii() {
    return Err("The address could not be copied.".to_string());
  }
  #[cfg(target_os = "macos")]
  let mut cmd = std::process::Command::new("/usr/bin/pbcopy");
  #[cfg(windows)]
  let mut cmd = {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
    let mut c = std::process::Command::new(std::path::Path::new(&root).join("System32").join("clip.exe"));
    use std::os::windows::process::CommandExt;
    c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    c
  };
  #[cfg(not(any(target_os = "macos", windows)))]
  return Err("Copy is not available here.".to_string());
  #[cfg(any(target_os = "macos", windows))]
  {
    let mut child = cmd
      .stdin(std::process::Stdio::piped())
      .stdout(std::process::Stdio::null())
      .stderr(std::process::Stdio::null())
      .spawn()
      .map_err(|e| e.to_string())?;
    child.stdin.take().ok_or("no stdin")?.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    let status = child.wait().map_err(|e| e.to_string())?;
    if status.success() {
      Ok(())
    } else {
      Err("The address could not be copied.".to_string())
    }
  }
}
