fn main() {
  // The commands the dashboard page (a remote origin, see capabilities/agent-ui.json) may call.
  tauri_build::try_build(
    tauri_build::Attributes::new().app_manifest(
      tauri_build::AppManifest::new().commands(&[
        "agent_status",
        "relaunch_app",
        "get_launch_at_login",
        "set_launch_at_login",
        "popover_do",
        "open_preferences",
        "set_preferences_height",
        "app_info",
        "reveal_data_folder",
        "open_external",
        // page viewer (src/viewer/mod.rs)
        "viewer_open",
        "viewer_state",
        "viewer_do",
        "viewer_pages",
        "viewer_clear_data",
      ]),
    ),
  )
  .expect("failed to run tauri-build");
}
