//! One-time move of the app's data folders after the bundle identifier
//! changed from `me.dorian.waystone-overlay` to `com.captain-vii.waystone-analyzer`
//! (1.0, so the author's name no longer appears in players' folder names).
//! Tauri derives every app dir from the identifier, so without this an
//! updated install would start from scratch: no meta.json, no remapped
//! hotkey, and no localStorage (settings, session history, pins live in the
//! WebView2 profile under the local data dir).

use std::{fs, io, path::Path};

use tauri::Manager;

const LEGACY_IDENTIFIER: &str = "me.dorian.waystone-overlay";

#[derive(Debug, PartialEq)]
pub(crate) enum Migration {
    /// No legacy folder: fresh install or already migrated.
    NothingToMove,
    /// The new folder already holds data; the legacy one is left alone.
    TargetInUse,
    Moved,
    Failed(String),
}

/// Moves `old` to `new` when `old` exists and `new` is absent or empty.
/// A rename, not a copy: same volume (both under the same AppData root), so
/// it's instant and atomic, and nothing is left behind with the old name.
pub(crate) fn migrate_dir(old: &Path, new: &Path) -> Migration {
    if !old.is_dir() {
        return Migration::NothingToMove;
    }
    match fs::read_dir(new) {
        Ok(mut entries) => {
            if entries.next().is_some() {
                return Migration::TargetInUse;
            }
            if let Err(e) = fs::remove_dir(new) {
                return Migration::Failed(e.to_string());
            }
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Migration::Failed(e.to_string()),
    }
    if let Some(parent) = new.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            return Migration::Failed(e.to_string());
        }
    }
    match fs::rename(old, new) {
        Ok(()) => Migration::Moved,
        Err(e) => Migration::Failed(e.to_string()),
    }
}

/// Migrates the roaming config dir (meta.json, hotkey.txt) and the local
/// data dir (WebView2 profile, logs). Must run before anything creates the
/// new folders: logging, meta.json seeding, the webview. Returns one
/// (folder, outcome) pair per dir for logging once logging is up.
pub(crate) fn migrate_legacy_dirs(app: &tauri::AppHandle) -> Vec<(&'static str, Migration)> {
    let paths = app.path();
    [
        ("config", paths.app_config_dir()),
        ("local", paths.app_local_data_dir()),
    ]
    .into_iter()
    .filter_map(|(label, dir)| {
        let new = dir.ok()?;
        let old = new.parent()?.join(LEGACY_IDENTIFIER);
        Some((label, migrate_dir(&old, &new)))
    })
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// A fresh scratch folder per test, removed on drop.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("wsa-migration-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn moves_the_legacy_folder_with_its_files() {
        let s = Scratch::new("move");
        let (old, new) = (s.0.join("old"), s.0.join("new"));
        fs::create_dir_all(old.join("logs")).unwrap();
        fs::write(old.join("meta.json"), "{}").unwrap();
        assert_eq!(migrate_dir(&old, &new), Migration::Moved);
        assert!(!old.exists());
        assert_eq!(fs::read_to_string(new.join("meta.json")).unwrap(), "{}");
        assert!(new.join("logs").is_dir());
    }

    #[test]
    fn replaces_an_empty_target_folder() {
        let s = Scratch::new("empty-target");
        let (old, new) = (s.0.join("old"), s.0.join("new"));
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("hotkey.txt"), "F5").unwrap();
        fs::create_dir_all(&new).unwrap();
        assert_eq!(migrate_dir(&old, &new), Migration::Moved);
        assert_eq!(fs::read_to_string(new.join("hotkey.txt")).unwrap(), "F5");
    }

    #[test]
    fn never_overwrites_a_target_with_data() {
        let s = Scratch::new("in-use");
        let (old, new) = (s.0.join("old"), s.0.join("new"));
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("meta.json"), "old").unwrap();
        fs::create_dir_all(&new).unwrap();
        fs::write(new.join("meta.json"), "new").unwrap();
        assert_eq!(migrate_dir(&old, &new), Migration::TargetInUse);
        assert_eq!(fs::read_to_string(new.join("meta.json")).unwrap(), "new");
        assert!(old.exists());
    }

    #[test]
    fn nothing_to_do_without_a_legacy_folder() {
        let s = Scratch::new("none");
        assert_eq!(
            migrate_dir(&s.0.join("old"), &s.0.join("new")),
            Migration::NothingToMove
        );
    }
}
