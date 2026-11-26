//! The page viewer on its own, for a developer to look at (src/viewer/preview.rs). Debug builds only:
//!
//!     npm run ui:mock -- --host 127.0.0.1 --port 5199 --strictPort     (in another terminal)
//!     cargo run --example viewer_preview -- http://127.0.0.1:5199/#/viewer https://www.amazon.com/dp/B0C3YBY7CD [context.json] [probe]
//!
//! It opens one page, when run: nothing is loaded that the person running it did not name.

fn main() {
  #[cfg(debug_assertions)]
  {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (Some(bar), Some(first)) = (args.first().cloned(), args.get(1).cloned()) else {
      eprintln!("usage: viewer_preview <toolbar page> <first page> [context.json] [probe]");
      std::process::exit(2);
    };
    let context = args
      .get(2)
      .filter(|a| a.ends_with(".json"))
      .map(|p| serde_json::from_str(&std::fs::read_to_string(p).expect("context file")).expect("context JSON"));
    let probe = args.iter().any(|a| a == "probe");
    let steps: Vec<String> = args.iter().skip(2).filter(|a| !a.ends_with(".json") && *a != "probe").cloned().collect();
    app_lib::viewer::preview::run(tauri::generate_context!(), bar, first, context, probe, steps);
  }
  #[cfg(not(debug_assertions))]
  eprintln!("viewer_preview runs in debug builds only");
}
