use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, RunEvent, State, WebviewWindow};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

struct AgentChild(Mutex<Option<CommandChild>>);

const AGENT_PORT: u16 = 8790;
const DASHBOARD_URL: &str = "http://127.0.0.1:8790/";

fn dev_repo_root() -> PathBuf {
  PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    .parent()
    .expect("src-tauri has a parent")
    .to_path_buf()
}

fn repo_root() -> PathBuf {
  if let Ok(home) = std::env::var("SPLIT_FINDER_HOME") {
    let p = PathBuf::from(home);
    if p.join("package.json").is_file() {
      return p;
    }
  }
  let built = dev_repo_root();
  if built.join("package.json").is_file() {
    return built;
  }
  if let Ok(home) = std::env::var("HOME") {
    let guess = PathBuf::from(home).join("Developer/GitHub/Bundle-Split-Finder");
    if guess.join("package.json").is_file() {
      return guess;
    }
  }
  built
}

fn agent_port_open() -> bool {
  TcpStream::connect_timeout(
    &format!("127.0.0.1:{AGENT_PORT}").parse().expect("parse addr"),
    Duration::from_millis(400),
  )
  .is_ok()
}

fn start_agent(app: &AppHandle, agent: &State<AgentChild>) -> Result<(), String> {
  if agent_port_open() {
    return Ok(());
  }
  let mut guard = agent.0.lock().map_err(|_| "agent lock poisoned".to_string())?;
  if guard.is_some() {
    return Ok(());
  }
  let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
  std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;

  let extension_dir = std::env::var("HOME")
    .map(|h| PathBuf::from(h).join("Documents").join("split-finder"))
    .unwrap_or_else(|_| data_dir.join("split-finder-extension"));

  let mut sidecar = app
    .shell()
    .sidecar("agent-dashboard")
    .map_err(|e| format!("Dashboard binary missing (reinstall Split Finder): {e}"))?
    .env("SPLIT_FINDER_DATA_DIR", data_dir)
    .env("SPLIT_FINDER_EXTENSION_DIR", &extension_dir)
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

  let (mut _rx, child) = sidecar
    .spawn()
    .map_err(|e| format!("Could not start dashboard: {e}"))?;
  *guard = Some(child);
  Ok(())
}

fn stop_agent(agent: &State<AgentChild>) {
  if let Ok(mut guard) = agent.0.lock() {
    if let Some(mut child) = guard.take() {
      let _ = child.kill();
    }
  }
}

fn open_dashboard_window(window: &WebviewWindow) {
  let url = tauri::Url::parse(DASHBOARD_URL).expect("dashboard url");
  if window.navigate(url).is_err() {
    let _ = window.eval(&format!("window.location.replace('{DASHBOARD_URL}');"));
  }
}

fn wait_for_dashboard() {
  for _ in 0..80 {
    if agent_port_open() {
      return;
    }
    std::thread::sleep(Duration::from_millis(250));
  }
}

fn extension_zip_in_repo(root: &Path) -> Option<PathBuf> {
  let out = root.join("output");
  let Ok(entries) = std::fs::read_dir(out) else {
    return None;
  };
  entries
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

fn extension_zip_in_resources(app: &tauri::AppHandle) -> Option<PathBuf> {
  let dir = app.path().resource_dir().ok()?;
  let Ok(entries) = std::fs::read_dir(dir) else {
    return None;
  };
  entries
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

#[tauri::command]
fn agent_status(_agent: State<AgentChild>) -> bool {
  agent_port_open()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_shell::init())
    .manage(AgentChild(Mutex::new(None)))
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      let open_dash =
        MenuItem::with_id(app, "open_dashboard", "Open dashboard", true, None::<&str>)?;
      let open_ext = MenuItem::with_id(
        app,
        "open_extensions",
        "Open Chrome extensions",
        true,
        None::<&str>,
      )?;
      let reveal_zip =
        MenuItem::with_id(app, "reveal_zip", "Reveal extension zip", true, None::<&str>)?;
      let quit = PredefinedMenuItem::quit(app, Some("Quit"))?;
      let app_menu = Submenu::with_items(
        app,
        "Split Finder",
        true,
        &[&open_dash, &open_ext, &reveal_zip, &quit],
      )?;
      let menu = Menu::with_items(app, &[&app_menu])?;
      app.set_menu(menu)?;

      let handle = app.handle().clone();
      let agent = app.state::<AgentChild>();
      if let Err(e) = start_agent(&handle, &agent) {
        log::warn!("Agent not started: {e}");
      } else {
        wait_for_dashboard();
      }

      if let Some(window) = app.get_webview_window("main") {
        if agent_port_open() {
          open_dashboard_window(&window);
        }
      }

      Ok(())
    })
    .on_menu_event(|app, event| {
      match event.id().as_ref() {
        "open_dashboard" => {
          let _ = start_agent(app, &app.state::<AgentChild>());
          if let Some(w) = app.get_webview_window("main") {
            open_dashboard_window(&w);
          } else {
            let _ = tauri_plugin_opener::OpenerExt::opener(app)
              .open_url(DASHBOARD_URL, None::<&str>);
          }
        }
        "open_extensions" => {
          #[cfg(target_os = "macos")]
          let _ = std::process::Command::new("open")
            .args(["-a", "Google Chrome", "chrome://extensions/"])
            .spawn();
          #[cfg(target_os = "windows")]
          let _ = std::process::Command::new("cmd")
            .args(["/C", "start", "chrome", "chrome://extensions/"])
            .spawn();
          #[cfg(not(any(target_os = "macos", target_os = "windows")))]
          let _ = tauri_plugin_opener::OpenerExt::opener(app)
            .open_url("chrome://extensions/", None::<&str>);
        }
        "reveal_zip" => {
          let root = repo_root();
          let path = extension_zip_in_repo(&root).or_else(|| extension_zip_in_resources(app));
          if let Some(p) = path {
            #[cfg(target_os = "macos")]
            let _ = std::process::Command::new("open").arg("-R").arg(&p).spawn();
            #[cfg(target_os = "windows")]
            let _ = std::process::Command::new("explorer")
              .arg(format!("/select,{}", p.display()))
              .spawn();
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            let _ = tauri_plugin_opener::OpenerExt::opener(app)
              .open_path(p.to_string_lossy(), None::<&str>);
          }
        }
        _ => {}
      }
    })
    .invoke_handler(tauri::generate_handler![agent_status])
    .build(tauri::generate_context!())
    .expect("error while running tauri application")
    .run(|app, event| {
      if let RunEvent::Exit = event {
        stop_agent(&app.state::<AgentChild>());
      }
    });
}