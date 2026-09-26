use super::{validate_registry, HEADER};

fn registry(class: &str, binding: &str) -> String {
    return format!("{HEADER}\nregression.binding\t{class}\ttools/evidence-governance.rs\t{binding}\tnone\tstructural-test-only\n");
}

#[test]
fn strong_registry_rows_reject_branch_bindings() {
    assert!(["implementation-linked", "cross-runtime"]
        .into_iter()
        .all(|class| {
            validate_registry(&registry(class, "opto-sync/opto-sync-core@main")).is_err()
        }));
}

#[test]
fn strong_registry_rows_accept_complete_commit_bindings() {
    assert!(["implementation-linked", "cross-runtime"]
        .into_iter()
        .all(|class| {
            validate_registry(&registry(
                class,
                "opto-sync/opto-sync-core@0123456789abcdef0123456789abcdef01234567",
            ))
            .is_ok()
        }));
}

#[test]
fn registry_rejects_existing_absolute_lane() -> Result<(), std::io::Error> {
    let absolute = std::fs::canonicalize("tools/evidence-governance.rs")?;
    let row = format!(
        "{HEADER}\npath.escape\tmodeling-only\t{}\tnone\tnone\tmodeling-only-no-runtime-claim\n",
        absolute.display()
    );
    assert!(validate_registry(&row).is_err());
    return Ok(());
}

#[cfg(unix)]
#[test]
fn conformance_scan_rejects_symlink_cycles() -> Result<(), std::io::Error> {
    let root = std::path::PathBuf::from(format!("tmp/conformance-cycle-{}", std::process::id()));
    std::fs::create_dir_all(&root)?;
    std::os::unix::fs::symlink(".", root.join("loop"))?;
    assert!(super::reject_python(&root).is_err());
    return Ok(());
}
