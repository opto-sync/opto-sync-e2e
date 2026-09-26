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
