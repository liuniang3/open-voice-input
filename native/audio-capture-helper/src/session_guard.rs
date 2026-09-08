use std::fs;
use std::path::{Component, Path, PathBuf};

/// Whitelist start/output paths under a canonical session root.
pub struct SessionRootGuard {
    root: PathBuf,
}

impl SessionRootGuard {
    pub fn new(session_root: &str) -> Result<Self, String> {
        if session_root.trim().is_empty() {
            return Err("session_root is empty".to_string());
        }
        let raw = PathBuf::from(session_root);
        if raw.as_os_str().is_empty() {
            return Err("session_root is empty".to_string());
        }
        if has_parent_component(&raw) {
            return Err("session_root must not contain ..".to_string());
        }
        fs::create_dir_all(&raw).map_err(|e| format!("create session_root failed: {e}"))?;
        let root = dunce_canonicalize(&raw)
            .map_err(|e| format!("canonicalize session_root failed: {e}"))?;
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Resolve candidate under root. Never create directories outside root.
    /// For non-existent paths: walk to nearest existing ancestor, canonicalize it,
    /// verify containment, then create only after the check passes.
    pub fn resolve_under_root(&self, candidate: &str) -> Result<PathBuf, String> {
        if candidate.trim().is_empty() {
            return Err("path is empty".to_string());
        }
        let path = PathBuf::from(candidate);
        if has_parent_component(&path) {
            return Err("path must not contain ..".to_string());
        }

        let abs = if path.is_absolute() {
            path
        } else {
            self.root.join(path)
        };

        if abs.exists() {
            let resolved =
                dunce_canonicalize(&abs).map_err(|e| format!("canonicalize failed: {e}"))?;
            if !is_path_within(&self.root, &resolved) {
                return Err(format!(
                    "path escapes session root: {} not under {}",
                    resolved.display(),
                    self.root.display()
                ));
            }
            return Ok(resolved);
        }

        // Nearest existing ancestor + relative suffix (no create yet).
        let (existing_ancestor, suffix) = nearest_existing_ancestor(&abs)?;
        let ancestor_c = dunce_canonicalize(&existing_ancestor)
            .map_err(|e| format!("canonicalize ancestor failed: {e}"))?;
        if !is_path_within(&self.root, &ancestor_c) {
            return Err(format!(
                "path escapes session root: ancestor {} not under {}",
                ancestor_c.display(),
                self.root.display()
            ));
        }
        let resolved = join_suffix(&ancestor_c, &suffix);
        if !is_path_within(&self.root, &resolved) {
            return Err(format!(
                "path escapes session root: {} not under {}",
                resolved.display(),
                self.root.display()
            ));
        }
        // Safe to create parents now — resolved is under root.
        if let Some(parent) = resolved.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("create parent failed: {e}"))?;
        }
        Ok(resolved)
    }
}

fn nearest_existing_ancestor(path: &Path) -> Result<(PathBuf, Vec<std::ffi::OsString>), String> {
    let mut cur = path.to_path_buf();
    let mut suffix: Vec<std::ffi::OsString> = Vec::new();
    loop {
        if cur.exists() {
            suffix.reverse();
            return Ok((cur, suffix));
        }
        let name = cur
            .file_name()
            .ok_or_else(|| "path has no resolvable ancestor".to_string())?
            .to_os_string();
        suffix.push(name);
        cur = cur
            .parent()
            .ok_or_else(|| "path has no resolvable ancestor".to_string())?
            .to_path_buf();
    }
}

fn join_suffix(base: &Path, suffix: &[std::ffi::OsString]) -> PathBuf {
    let mut out = base.to_path_buf();
    for part in suffix {
        out.push(part);
    }
    out
}

fn has_parent_component(path: &Path) -> bool {
    path.components().any(|c| matches!(c, Component::ParentDir))
}

fn is_path_within(root: &Path, candidate: &Path) -> bool {
    let root_s = root.as_os_str().to_string_lossy().to_ascii_lowercase();
    let cand_s = candidate.as_os_str().to_string_lossy().to_ascii_lowercase();
    if cand_s == root_s {
        return true;
    }
    let prefix = if root_s.ends_with('\\') || root_s.ends_with('/') {
        root_s.clone()
    } else {
        format!("{root_s}\\")
    };
    cand_s.starts_with(&prefix)
}

fn dunce_canonicalize(path: &Path) -> std::io::Result<PathBuf> {
    let c = fs::canonicalize(path)?;
    Ok(strip_extended_prefix(c))
}

fn strip_extended_prefix(path: PathBuf) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        if let Some(unc) = rest.strip_prefix(r"UNC\") {
            PathBuf::from(format!(r"\\{unc}"))
        } else {
            PathBuf::from(rest)
        }
    } else {
        path
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(tag: &str) -> PathBuf {
        env::temp_dir().join(format!(
            "ovi-sg-{}-{}",
            tag,
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis()
        ))
    }

    #[test]
    fn denies_parent_escape() {
        let tmp = temp_dir("parent");
        fs::create_dir_all(&tmp).unwrap();
        let guard = SessionRootGuard::new(tmp.to_str().unwrap()).unwrap();
        let err = guard.resolve_under_root("../outside").unwrap_err();
        assert!(err.contains("..") || err.contains("escapes"));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn denies_absolute_outside_without_creating() {
        let tmp = temp_dir("abs");
        fs::create_dir_all(&tmp).unwrap();
        let guard = SessionRootGuard::new(tmp.to_str().unwrap()).unwrap();

        let outside_base = env::temp_dir().join(format!(
            "ovi-sg-outside-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis()
        ));
        // Do not create outside_base — resolve must deny without creating it.
        let outside = outside_base.join("nested").join("track");
        assert!(!outside_base.exists());
        let err = guard
            .resolve_under_root(outside.to_str().unwrap())
            .unwrap_err();
        assert!(err.contains("escapes"), "err={err}");
        assert!(
            !outside_base.exists(),
            "must not create directories outside root"
        );
        let _ = fs::remove_dir_all(&tmp);
        let _ = fs::remove_dir_all(&outside_base);
    }

    #[test]
    fn allows_relative_under_root_and_creates() {
        let tmp = temp_dir("ok");
        fs::create_dir_all(&tmp).unwrap();
        let guard = SessionRootGuard::new(tmp.to_str().unwrap()).unwrap();
        let resolved = guard
            .resolve_under_root("audio/microphone")
            .expect("under root");
        assert!(is_path_within(guard.root(), &resolved));
        // parent created
        assert!(resolved.parent().unwrap().exists() || resolved.exists());
        let _ = fs::remove_dir_all(&tmp);
    }
}
