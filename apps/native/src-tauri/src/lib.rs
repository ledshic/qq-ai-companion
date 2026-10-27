#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientInfo {
    platform: &'static str,
    architecture: &'static str,
    version: &'static str,
}

#[tauri::command]
fn client_info() -> ClientInfo {
    ClientInfo {
        platform: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
        version: env!("CARGO_PKG_VERSION"),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![client_info])
        .run(tauri::generate_context!())
        .expect("failed to launch Companion client");
}
