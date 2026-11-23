mod agent;
mod events;
mod popover;
mod prefs;
mod shell;

use std::sync::Mutex;

use tauri::{AppHandle, RunEvent, WindowEvent};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_window_state::StateFlags;

#[tauri::command]
fn agent_status() -> bool {
  agent::port_open()
}

#[tauri::command]
fn get_launch_at_login(app: AppHandle) -> bool {
  shell::launch_at_login(&app)
}

#[tauri::command]
fn set_launch_at_login(app: AppHandle, enabled: bool) -> Result<bool, String> {
  shell::set_launch_at_login(&app, enabled)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    // Must be the first plugin: a second launch focuses the running window instead.
    .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
      shell::show_window(app);
    }))
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_autostart::init(
      tauri_plugin_autostart::MacosLauncher::LaunchAgent,
      None,
    ))
    .plugin(
      // Size, position and maximized are remembered. Visibility is not: a window that was hidden
      // to the tray when the app quit must still show on the next launch.
      tauri_plugin_window_state::Builder::default()
        .with_state_flags(StateFlags::all() - StateFlags::VISIBLE)
        // The menu bar popover is placed under the icon each time; the Preferences window fits its pane.
        .with_denylist(&[popover::LABEL, prefs::LABEL])
        .build(),
    )
    .manage(agent::AgentChild(Mutex::new(None)))
    .manage(shell::ShellState::new())
    .setup(|app| {
      let handle = app.handle().clone();
      if cfg!(debug_assertions) {
        handle.plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      shell::build_menus(&handle)?;

      match agent::start(&handle) {
        Ok(()) => agent::wait_until_up(),
        Err(e) => log::warn!("Agent not started: {e}"),
      }
      shell::create_window(&handle)?;
      popover::prepare(&handle);

      // Ask once; macOS remembers the answer.
      let _ = handle.notification().request_permission();
      events::spawn(handle);
      Ok(())
    })
    // Close to tray: the window hides, the agent keeps running. Quit lives in the menus.
    .on_window_event(|window, event| {
      if let WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        let _ = window.hide();
      }
    })
    .invoke_handler(tauri::generate_handler![
      agent_status,
      get_launch_at_login,
      set_launch_at_login,
      popover::popover_do,
      prefs::open_preferences,
      prefs::set_preferences_height,
      prefs::app_info,
      prefs::reveal_data_folder,
      prefs::open_external
    ])
    .build(tauri::generate_context!())
    .expect("error while running tauri application")
    .run(|app, event| match event {
      // Dock icon click or a notification click while the window is hidden.
      #[cfg(target_os = "macos")]
      RunEvent::Reopen { .. } => {
        shell::show_window(app);
        shell::consume_pending_nav(app);
      }
      // The popover taking focus is not the owner opening the app from a notification.
      RunEvent::WindowEvent {
        label,
        event: WindowEvent::Focused(true),
        ..
      } if label != popover::LABEL => shell::consume_pending_nav(app),
      RunEvent::Exit => agent::stop(app),
      _ => {}
    });
}
