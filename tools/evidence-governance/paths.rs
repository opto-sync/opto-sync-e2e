use std::{
    fs,
    path::{Component, Path, PathBuf},
};

/// Validate a stable checked-out tree; this is not a sandbox for concurrent writes.
pub fn repository_file(root: &Path, value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.contains('\\')
        || value.contains(':')
        || value
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || Path::new(value)
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("evidence path must be a normalized repository-relative path".to_owned());
    }
    let path =
        Path::new(value)
            .components()
            .try_fold(root.to_path_buf(), |parent, component| {
                let child = parent.join(component);
                let metadata = fs::symlink_metadata(&child)
                    .map_err(|_| "evidence path is missing or unreadable".to_owned())?;
                if metadata.file_type().is_symlink() {
                    return Err("evidence path must not traverse symlinks".to_owned());
                }
                return Ok::<PathBuf, String>(child);
            })?;
    if !path.is_file() {
        return Err("evidence path must name a regular file".to_owned());
    }
    return Ok(());
}

#[cfg(test)]
mod tests {
    use super::repository_file;
    use std::{fs, path::PathBuf};

    fn fixture(name: &str) -> Result<PathBuf, std::io::Error> {
        let root = PathBuf::from(format!("tmp/evidence-path-{}-{name}", std::process::id()));
        fs::create_dir_all(root.join("nested"))?;
        fs::write(root.join("nested/control.json"), "{}")?;
        return Ok(root);
    }

    #[test]
    fn permits_only_existing_normalized_repository_files() -> Result<(), std::io::Error> {
        let root = fixture("normal")?;
        assert!(repository_file(&root, "nested/control.json").is_ok());
        assert!([
            "",
            "/etc/passwd",
            "../outside",
            "nested/../nested/control.json",
            "./nested/control.json",
            "nested//control.json",
            "nested/",
            "nested",
            "missing",
            "C:/Windows/file",
            "nested\\control.json"
        ]
        .into_iter()
        .all(|value| repository_file(&root, value).is_err()));
        return Ok(());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_file_and_directory_symlinks() -> Result<(), std::io::Error> {
        let root = fixture("symlinks")?;
        std::os::unix::fs::symlink("nested/control.json", root.join("linked.json"))?;
        std::os::unix::fs::symlink("nested", root.join("linked-directory"))?;
        assert!(repository_file(&root, "linked.json").is_err());
        assert!(repository_file(&root, "linked-directory/control.json").is_err());
        return Ok(());
    }
}
