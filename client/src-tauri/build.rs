fn main() {
    // The default update source names the GitHub repository of the release
    // (`make release RELEASE_REPO=owner/name`, ADR 0026); see src/updates.rs.
    println!("cargo:rerun-if-env-changed=ROSTALK_RELEASE_REPO");
    tauri_build::build();
}
