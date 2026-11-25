//! Signed in-app updates (stage 6.2, default source since P13).
//!
//! The shell reads the update source from `ROSTALK_UPDATE_SOURCE` or, when that
//! is empty, from [`ClientSettings::update_source`] (ADR 0019). When neither is
//! set, the official GitHub release of the repository the client was built for
//! is used (ADR 0026): `https://github.com/<repo>/releases/latest/download/
//! latest.json`, where `<repo>` comes from `ROSTALK_RELEASE_REPO` at build time
//! (`make release RELEASE_REPO=…`). The source can be:
//!
//! * `https://…/latest.json` — a static manifest served over TLS;
//! * a local directory containing `latest.json` and the installer, for a
//!   LAN share or an offline test. A directory manifest references its files by
//!   relative name, not by an absolute URL.
//!
//! Both paths use `tauri-plugin-updater` for the manifest, the minisign
//! signature (the public key is in `tauri.conf.json`) and the Windows
//! installer. A local directory is read by us and handed to
//! [`tauri_plugin_updater::Updater::restore_update`]; the signature is still
//! checked by the plugin before anything is executed, and `restore_update`
//! additionally binds the signed version to the announced one.
//!
//! The update never starts on its own: the UI checks, shows the version and
//! asks before installing. Installing exits the client (a Windows installer
//! limitation) and the NSIS installer restarts it, so this is the one point
//! where a conversation is interrupted — and only after the user confirms.

use std::path::{Component, Path, PathBuf};

use rostalk_core::{ClientSettings, CoreError, CoreErrorCode};
#[cfg(test)]
use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_updater::{Error as UpdaterError, Update, UpdaterExt};
use tauri_specta::Event as _;
use url::Url;

/// Environment variable that overrides the settings value. Useful for a
/// support run and for the local update smoke test.
pub const SOURCE_ENV: &str = "ROSTALK_UPDATE_SOURCE";

/// Repository whose GitHub releases are the default update source. Set at
/// build time by `make release RELEASE_REPO=owner/name` (build.rs reruns when
/// it changes); the fallback is the project repository.
pub const RELEASE_REPO: &str = match option_env!("ROSTALK_RELEASE_REPO") {
    Some(repo) => repo,
    None => "v4dikos1/RosTalk",
};

/// The official update manifest: the `latest.json` asset of the newest
/// GitHub release. GitHub answers with a redirect to its download host, which
/// the updater's HTTP client follows; the signature check does not depend on
/// the transport.
#[must_use]
pub fn default_source() -> String {
    format!("https://github.com/{RELEASE_REPO}/releases/latest/download/latest.json")
}

/// The source actually used: environment, then settings, then the official
/// release manifest.
#[must_use]
pub fn effective_source(setting: Option<&str>, environment: Option<&str>) -> String {
    source_from(setting, environment).unwrap_or_else(default_source)
}

/// Largest installer accepted from a directory source, bytes. The Windows
/// installer is a few megabytes; this bounds an accidental huge file.
const MAX_ARTIFACT_BYTES: u64 = 256 * 1024 * 1024;

/// Endpoint used only to build an [`Updater`] for a directory source.
/// `restore_update` does not make a request; the host is reserved by RFC 2606.
const DIRECTORY_ENDPOINT: &str = "https://updates.invalid/latest.json";

/// One available release, as shown in the settings window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// Version of the running client.
    pub current_version: String,
    /// Version announced by the manifest.
    pub version: String,
    /// Release notes from the manifest, if any.
    pub notes: Option<String>,
    /// RFC 3339 publish date, if any.
    pub date: Option<String>,
    /// Source description without credentials or query strings.
    pub source: String,
}

/// Result of a manual update check.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    /// Always true since P13: without a configured source the official release
    /// manifest is used. Kept so the IPC shape stays the same.
    pub configured: bool,
    /// Source description, for the settings window.
    pub source: Option<String>,
    /// Version of the running client.
    pub current_version: String,
    /// A newer signed release, if one was found.
    pub available: Option<UpdateInfo>,
}

/// Download progress sent to the window while an update installs.
#[derive(
    Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type, tauri_specta::Event,
)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgressEvent {
    /// Bytes received so far.
    pub downloaded: u64,
    /// Total size when the source announced it.
    pub total: Option<u64>,
}

/// Where an update comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateSource {
    /// A `latest.json` manifest served over HTTPS.
    Url(Url),
    /// A directory with `latest.json` and the installer.
    Directory(PathBuf),
}

impl UpdateSource {
    /// Source description that is safe to show: no userinfo, query or fragment.
    fn describe(&self) -> String {
        match self {
            Self::Url(url) => {
                let mut clean = url.clone();
                let _ = clean.set_username("");
                let _ = clean.set_password(None);
                clean.set_query(None);
                clean.set_fragment(None);
                clean.to_string()
            }
            Self::Directory(path) => path.display().to_string(),
        }
    }
}

/// Picks the configured source: the environment wins over the settings so a
/// deployment can point an installed client at a mirror without touching the
/// UI. An empty value means "not configured".
#[must_use]
pub fn source_from(setting: Option<&str>, environment: Option<&str>) -> Option<String> {
    let value = environment
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| setting.map(str::trim).filter(|value| !value.is_empty()))?;
    Some(value.to_owned())
}

/// Parses a source string. Remote sources must use HTTPS; everything else is
/// treated as a directory. A path is canonicalised, so the manifest and the
/// installer cannot escape it through a relative name.
pub fn resolve_source(raw: &str) -> Result<UpdateSource, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("the update source is empty".to_owned());
    }
    if trimmed.starts_with("https://") || trimmed.starts_with("HTTPS://") {
        let url = Url::parse(trimmed).map_err(|_| "the update URL is malformed".to_owned())?;
        return Ok(UpdateSource::Url(url));
    }
    if trimmed.contains("://") {
        return Err(
            "an update URL must use https; use a local directory for offline files".to_owned(),
        );
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err("a local update source must be an absolute directory path".to_owned());
    }
    if !path.is_dir() {
        return Err("the local update directory does not exist".to_owned());
    }
    let path = std::fs::canonicalize(&path)
        .map_err(|_| "the local update directory cannot be read".to_owned())?;
    Ok(UpdateSource::Directory(plain_path(path)))
}

/// Removes the Windows verbatim prefix (`\\?\`), which `Url::from_file_path`
/// rejects. `canonicalize` adds it on Windows; a directory source still needs a
/// normal absolute path for file URLs. UNC verbatim paths keep their server and
/// share.
fn plain_path(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path
}

/// Checks the configured source for a newer release.
pub async fn check_for_update(
    app: &AppHandle,
    settings: &ClientSettings,
) -> Result<UpdateCheck, CoreError> {
    let current_version = app.package_info().version.to_string();
    let environment = std::env::var(SOURCE_ENV).ok();
    let raw = effective_source(settings.update_source.as_deref(), environment.as_deref());
    let source = resolve_source(&raw)
        .map_err(|message| CoreError::new(CoreErrorCode::InvalidRequest, message))?;
    let described = source.describe();
    let update = match &source {
        UpdateSource::Url(url) => check_url(app, url.clone()).await?,
        UpdateSource::Directory(directory) => check_directory(app, directory.clone())?,
    };
    Ok(UpdateCheck {
        configured: true,
        source: Some(described.clone()),
        current_version,
        available: update.as_ref().map(|update| UpdateInfo {
            current_version: update.current_version.clone(),
            version: update.version.clone(),
            notes: update.body.clone(),
            // Keep the manifest's RFC 3339 string; `OffsetDateTime`'s Display
            // is not understood by JavaScript's Date parser.
            date: update
                .raw_json
                .get("pub_date")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned),
            source: described,
        }),
    })
}

/// Downloads and installs the release announced by the configured source.
///
/// The caller must have shown the version to the user first. On Windows the
/// plugin starts the NSIS installer and exits the process; the installer
/// restarts the client when it finishes.
pub async fn install_update(app: &AppHandle, settings: &ClientSettings) -> Result<(), CoreError> {
    let environment = std::env::var(SOURCE_ENV).ok();
    let raw = effective_source(settings.update_source.as_deref(), environment.as_deref());
    let source = resolve_source(&raw)
        .map_err(|message| CoreError::new(CoreErrorCode::InvalidRequest, message))?;

    match source {
        UpdateSource::Url(url) => {
            let update = check_url(app, url).await?.ok_or_else(no_update_error)?;
            let handle = app.clone();
            let mut last_emit = 0_u64;
            update
                .download_and_install(
                    move |chunk, total| {
                        last_emit = last_emit.saturating_add(chunk as u64);
                        emit_progress(&handle, last_emit, total);
                    },
                    || {},
                )
                .await
                .map_err(updater_error)?;
        }
        UpdateSource::Directory(directory) => {
            let update = check_directory(app, directory.clone())?.ok_or_else(no_update_error)?;
            let artifact = directory_artifact(&update)?;
            let size = std::fs::metadata(&artifact)
                .map_err(|_| {
                    CoreError::new(CoreErrorCode::Internal, "the update package cannot be read")
                })?
                .len();
            if size == 0 || size > MAX_ARTIFACT_BYTES {
                return Err(CoreError::new(
                    CoreErrorCode::Internal,
                    "the update package has an unexpected size",
                ));
            }
            emit_progress(app, 0, Some(size));
            let bytes = std::fs::read(&artifact).map_err(|_| {
                CoreError::new(CoreErrorCode::Internal, "the update package cannot be read")
            })?;
            emit_progress(app, bytes.len() as u64, Some(size));
            update.install(bytes).map_err(updater_error)?;
        }
    }
    Ok(())
}

/// Remote manifest: the plugin fetches it over TLS, compares versions and
/// verifies the installer signature on download.
async fn check_url(app: &AppHandle, url: Url) -> Result<Option<Update>, CoreError> {
    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(updater_error)?
        .build()
        .map_err(updater_error)?;
    updater.check().await.map_err(updater_error)
}

/// Local manifest: read `latest.json`, rewrite relative package names into
/// `file:` URLs inside the same directory, and let the plugin apply its target
/// and version selection.
fn check_directory(app: &AppHandle, directory: PathBuf) -> Result<Option<Update>, CoreError> {
    check_directory_inner(app, directory).map_err(|error| {
        // Directory paths and a local manifest are not secrets; the technical
        // reason is what a support run needs. Remote errors are not logged
        // because a signed URL may carry a token.
        log::warn!("local update check failed: {error}");
        error
    })
}

fn check_directory_inner(app: &AppHandle, directory: PathBuf) -> Result<Option<Update>, CoreError> {
    let manifest_path = directory.join("latest.json");
    let raw = std::fs::read_to_string(&manifest_path).map_err(|_| {
        CoreError::new(
            CoreErrorCode::InvalidRequest,
            "the update directory has no latest.json",
        )
    })?;
    let mut manifest = parse_manifest(&raw)?;
    normalize_directory_urls(&mut manifest, &directory)?;

    let updater = app
        .updater_builder()
        .endpoints(vec![
            Url::parse(DIRECTORY_ENDPOINT).map_err(|_| internal_error())?
        ])
        .map_err(updater_error)?
        .build()
        .map_err(updater_error)?;
    updater.restore_update(manifest).map_err(updater_error)
}

/// Parses a static manifest. PowerShell 5 writes a BOM by default, and editors
/// do it too; a UTF-8 BOM is the only tolerated prefix and is not part of JSON.
fn parse_manifest(raw: &str) -> Result<serde_json::Value, CoreError> {
    let raw = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    serde_json::from_str(raw).map_err(|_| {
        CoreError::new(
            CoreErrorCode::InvalidRequest,
            "the update manifest is invalid",
        )
    })
}

/// Rewrites every `platforms.*.url` of a local manifest into an absolute file
/// URL under `directory`. Absolute URLs are rejected: a directory source must
/// not silently download from elsewhere.
fn normalize_directory_urls(
    manifest: &mut serde_json::Value,
    directory: &Path,
) -> Result<(), CoreError> {
    let Some(platforms) = manifest
        .get_mut("platforms")
        .and_then(serde_json::Value::as_object_mut)
    else {
        return Err(CoreError::new(
            CoreErrorCode::InvalidRequest,
            "the update manifest has no platforms",
        ));
    };
    if platforms.is_empty() {
        return Err(CoreError::new(
            CoreErrorCode::InvalidRequest,
            "the update manifest has no platforms",
        ));
    }
    for platform in platforms.values_mut() {
        let Some(url) = platform
            .get("url")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
        else {
            return Err(CoreError::new(
                CoreErrorCode::InvalidRequest,
                "the update manifest has no package URL",
            ));
        };
        let relative = Path::new(&url);
        if url.contains("://")
            || relative.is_absolute()
            || relative
                .components()
                .any(|component| matches!(component, Component::ParentDir))
        {
            return Err(CoreError::new(
                CoreErrorCode::InvalidRequest,
                "a local update source must reference files by relative name",
            ));
        }
        let absolute = directory.join(relative);
        let file_url = Url::from_file_path(&absolute).map_err(|()| {
            CoreError::new(
                CoreErrorCode::InvalidRequest,
                "the update package path is invalid",
            )
        })?;
        platform["url"] = serde_json::Value::String(file_url.to_string());
    }
    Ok(())
}

/// Absolute installer path of a directory update. The URL was produced by
/// [`normalize_directory_urls`], so it is a `file:` URL.
fn directory_artifact(update: &Update) -> Result<PathBuf, CoreError> {
    update.download_url.to_file_path().map_err(|()| {
        CoreError::new(
            CoreErrorCode::Internal,
            "the update package path is not local",
        )
    })
}

fn emit_progress(app: &AppHandle, downloaded: u64, total: Option<u64>) {
    let _ = UpdateProgressEvent { downloaded, total }.emit(app);
}

fn no_update_error() -> CoreError {
    CoreError::new(
        CoreErrorCode::InvalidRequest,
        "no newer release is available",
    )
}

fn internal_error() -> CoreError {
    CoreError::internal("the updater is not available")
}

/// Maps plugin errors to a safe user-facing category. The technical message
/// can contain a URL (and a signed URL may carry a token), so it is not copied
/// into the visible error or the log.
fn updater_error(error: UpdaterError) -> CoreError {
    use tauri_plugin_updater::Error as E;
    let (message, retryable) = match &error {
        E::Minisign(_)
        | E::SignatureUtf8(_)
        | E::SignedVersionMismatch { .. }
        | E::MissingSignedVersion => (
            "the update signature is invalid; nothing was installed",
            false,
        ),
        E::InsecureTransportProtocol => ("the update source must use https", false),
        E::TargetNotFound(_) | E::TargetsNotFound(_) => (
            "the update manifest has no package for this platform",
            false,
        ),
        E::UnsupportedArch | E::UnsupportedOs => {
            ("updates are not supported on this platform", false)
        }
        E::ReleaseNotFound | E::Reqwest(_) | E::Network(_) => {
            ("could not fetch the update manifest", true)
        }
        E::InvalidUpdaterFormat | E::BinaryNotFoundInArchive => {
            ("the update package has an unexpected format", false)
        }
        _ => ("the update could not be installed", true),
    };
    CoreError::new(CoreErrorCode::Internal, message).retryable(retryable)
}

/// Compares versions for the tests. The plugin makes the actual decision; this
/// helper exists so the update contract is testable without a network and never
/// accepts a downgrade.
#[cfg(test)]
pub fn is_newer(current: &str, announced: &str) -> Result<bool, String> {
    let current = Version::parse(current.trim_start_matches('v'))
        .map_err(|_| "the current version is not semver".to_owned())?;
    let announced = Version::parse(announced.trim_start_matches('v'))
        .map_err(|_| "the announced version is not semver".to_owned())?;
    Ok(announced > current)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn environment_overrides_the_setting_and_empty_values_are_ignored() {
        assert_eq!(
            source_from(Some("https://setting.example/latest.json"), None).as_deref(),
            Some("https://setting.example/latest.json")
        );
        assert_eq!(
            source_from(
                Some("https://setting.example/latest.json"),
                Some("  https://mirror.example/latest.json ")
            )
            .as_deref(),
            Some("https://mirror.example/latest.json")
        );
        assert_eq!(
            source_from(Some("https://setting.example/latest.json"), Some("  ")).as_deref(),
            Some("https://setting.example/latest.json")
        );
        assert_eq!(source_from(Some("  "), None), None);
        assert_eq!(source_from(None, None), None);
    }

    #[test]
    fn the_official_release_manifest_is_the_fallback() {
        let fallback = effective_source(None, None);
        assert_eq!(
            fallback,
            format!("https://github.com/{RELEASE_REPO}/releases/latest/download/latest.json")
        );
        assert!(matches!(
            resolve_source(&fallback),
            Ok(UpdateSource::Url(_))
        ));
        // owner/name, nothing that could escape the GitHub path.
        let mut parts = RELEASE_REPO.split('/');
        let (owner, name) = (parts.next(), parts.next());
        assert!(parts.next().is_none());
        for part in [owner, name] {
            let part = part.unwrap_or_default();
            assert!(!part.is_empty());
            assert!(part
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.'));
        }
        assert_eq!(
            effective_source(Some("  "), Some("https://mirror.example/latest.json")),
            "https://mirror.example/latest.json"
        );
        assert_eq!(
            effective_source(Some("https://setting.example/latest.json"), None),
            "https://setting.example/latest.json"
        );
    }

    #[test]
    fn https_urls_are_accepted_and_other_schemes_are_rejected() {
        let source =
            resolve_source("https://updates.example/rostalk/latest.json").expect("https source");
        assert!(matches!(source, UpdateSource::Url(_)));
        assert_eq!(
            source.describe(),
            "https://updates.example/rostalk/latest.json"
        );

        // A query string may carry a token; it is not shown in the UI.
        let source =
            resolve_source("https://updates.example/latest.json?token=secret").expect("source");
        assert!(!source.describe().contains("secret"));

        assert!(resolve_source("http://updates.example/latest.json").is_err());
        assert!(resolve_source("ftp://updates.example/latest.json").is_err());
        assert!(resolve_source("relative/dir").is_err());
        assert!(resolve_source("").is_err());
    }

    #[test]
    fn a_directory_source_is_canonical_and_keeps_only_its_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = resolve_source(dir.path().to_str().expect("utf-8")).expect("dir source");
        let UpdateSource::Directory(path) = source else {
            panic!("expected a directory source");
        };
        assert!(path.is_absolute());

        let mut manifest = serde_json::json!({
            "version": "0.2.0",
            "platforms": {
                "windows-x86_64": {
                    "url": "RosTalk_0.2.0_x64-setup.exe",
                    "signature": "sig"
                }
            }
        });
        normalize_directory_urls(&mut manifest, &path).expect("rewrite");
        let url = manifest["platforms"]["windows-x86_64"]["url"]
            .as_str()
            .expect("url");
        assert!(url.starts_with("file:"));
        assert!(url.ends_with("RosTalk_0.2.0_x64-setup.exe"));

        let mut escape = serde_json::json!({
            "version": "0.2.0",
            "platforms": {
                "windows-x86_64": {
                    "url": "../outside.exe",
                    "signature": "sig"
                }
            }
        });
        assert!(normalize_directory_urls(&mut escape, &path).is_err());

        let mut remote = serde_json::json!({
            "version": "0.2.0",
            "platforms": {
                "windows-x86_64": {
                    "url": "https://elsewhere.example/setup.exe",
                    "signature": "sig"
                }
            }
        });
        assert!(normalize_directory_urls(&mut remote, &path).is_err());
    }

    #[test]
    fn a_manifest_with_a_utf8_bom_is_accepted() {
        let manifest = parse_manifest("\u{feff}{\"version\":\"0.1.1\",\"platforms\":{}}")
            .expect("BOM is tolerated");
        assert_eq!(manifest["version"], "0.1.1");
        assert!(parse_manifest("{ not json").is_err());
    }

    #[test]
    fn only_strictly_newer_versions_are_offered() {
        assert!(is_newer("0.1.0", "0.1.1").expect("newer"));
        assert!(is_newer("v0.1.0", "0.2.0").expect("newer"));
        assert!(!is_newer("0.1.0", "0.1.0").expect("same"));
        assert!(!is_newer("0.2.0", "0.1.9").expect("older"));
        assert!(is_newer("0.1.0", "not-a-version").is_err());
    }
}
