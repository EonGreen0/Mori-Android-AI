fn main() {
    let manifest_dir = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let target = std::env::var("TARGET").unwrap_or_default();

    if target.contains("windows") {
        let win_obj = manifest_dir.join("native/windows/morisec.obj");
        if win_obj.exists() {
            println!("cargo:rustc-link-arg={}", win_obj.display());
        }
    } else if target.contains("apple") || target.contains("darwin") {
        let darwin_dir = manifest_dir.join("native/darwin");
        if darwin_dir.exists() {
            println!("cargo:rustc-link-search=native={}", darwin_dir.display());
            println!("cargo:rustc-link-lib=static=morisec");
        }
    }

    tauri_build::build();
}
