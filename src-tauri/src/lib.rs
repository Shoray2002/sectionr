use std::process::Child;
use std::sync::Mutex;
use tauri::{Manager, RunEvent};

// Holds the Deno compute sidecar so we can kill it when the app exits.
struct Sidecar(Mutex<Option<Child>>);

#[tauri::command]
fn save_svg(path: String, content: String) -> Result<(), String> {
    // layered map exports write into a directory named by the save dialog
    if let Some(dir) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

fn spawn_sidecar() -> std::io::Result<Child> {
    if cfg!(debug_assertions) {
        // dev: run from the repo with system deno. server/main.js + deno.json live here.
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();

        std::process::Command::new("deno")
            .current_dir(&root)
            .args([
                "run",
                "-A",
                "--unstable-webgpu",
                "--v8-flags=--max-old-space-size=12000",
                "server/main.js",
                "8787",
            ])
            .spawn()
    } else {
        // release: `deno compile`d sidecar bundled via externalBin, sits next to
        // the app executable in Contents/MacOS. The heap limit and worker module
        // are included by the `sidecar` build command in package.json.
        let bin = std::env::current_exe()?
            .parent()
            .unwrap()
            .join("sectionr-sidecar");

        std::process::Command::new(bin)
            .arg("8787")
            .spawn()
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![save_svg, read_file])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            match spawn_sidecar() {
                Ok(child) => { app.manage(Sidecar(Mutex::new(Some(child)))); }
                Err(e) => eprintln!("failed to spawn deno sidecar (is `deno` on PATH?): {e}"),
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(sidecar) = app.try_state::<Sidecar>() {
                    if let Some(mut child) = sidecar.0.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}
