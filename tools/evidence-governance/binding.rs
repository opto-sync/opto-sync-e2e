//! Registry bindings identify Git source, never mutable branches or tags.

pub fn immutable_binding(value: &str) -> bool {
    let Some((repository, revision)) = value.split_once('@') else {
        return false;
    };
    let segments = repository.split('/').collect::<Vec<_>>();
    return segments.len() == 2
        && segments.iter().all(|segment| {
            !segment.is_empty()
                && *segment != "."
                && *segment != ".."
                && segment
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        })
        && revision.len() == 40
        && revision
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        && revision.bytes().any(|byte| byte != b'0');
}

#[cfg(test)]
mod tests {
    use super::immutable_binding;

    #[test]
    fn admits_full_repository_commit_identity() {
        assert!(immutable_binding(
            "opto-sync/opto-sync-core@0123456789abcdef0123456789abcdef01234567"
        ));
    }

    #[test]
    fn rejects_mutable_missing_and_malformed_identities() {
        let invalid = [
            "@",
            "repo@main",
            "owner/repo@main",
            "owner/repo@v1.0.0",
            "owner/repo@abcdef1",
            "owner/repo@0000000000000000000000000000000000000000",
            "owner/repo@gggggggggggggggggggggggggggggggggggggggg",
            "owner/repo@0123456789ABCDEF0123456789abcdef01234567",
            "owner/repo/extra@0123456789abcdef0123456789abcdef01234567",
            "../repo@0123456789abcdef0123456789abcdef01234567",
            "owner/repo@0123456789abcdef0123456789abcdef01234567@main",
            "owner/repo@0123456789abcdef0123456789abcdef01234567 ",
        ];
        assert!(invalid.into_iter().all(|value| !immutable_binding(value)));
    }
}
