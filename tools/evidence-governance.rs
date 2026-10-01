#[path = "evidence-governance/binding.rs"]
mod binding;
#[path = "evidence-governance/paths.rs"]
mod paths;

use std::{collections::HashSet, fs, path::Path};

const REGISTRY: &str = "conformance/evidence-registry.tsv";
const HEADER: &str = "property_id\tevidence_class\texecutable_lane\timplementation_binding\tnegative_control\tclaim_boundary";
const CLASSES: [&str; 4] = [
    "declaration-only",
    "modeling-only",
    "implementation-linked",
    "cross-runtime",
];

type CheckResult<T> = Result<T, String>;

#[derive(Clone, Copy)]
struct EvidenceRow<'a> {
    property_id: &'a str,
    evidence_class: &'a str,
    executable_lane: &'a str,
    implementation_binding: &'a str,
    negative_control: &'a str,
    claim_boundary: &'a str,
}

fn require_file(path: &str, field: &str, property_id: &str) -> CheckResult<()> {
    return paths::repository_file(Path::new("."), path)
        .map_err(|error| format!("{property_id}: {field}: {error}"));
}

fn reject_python(path: &Path) -> CheckResult<()> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| "cannot inspect conformance directory".to_owned())?;
    if !metadata.file_type().is_dir() {
        return Err("conformance scan requires a real directory".to_owned());
    }
    fs::read_dir(path)
        .map_err(|error| format!("cannot read {}: {error}", path.display()))?
        .map(|entry| entry.map_err(|error| format!("cannot read directory entry: {error}")))
        .collect::<CheckResult<Vec<_>>>()?
        .into_iter()
        .try_for_each(|entry| {
            let child = entry.path();
            let file_type = entry.file_type()
                .map_err(|_| "cannot inspect conformance entry".to_owned())?;
            if file_type.is_symlink() {
                return Err("symlinked conformance entries are not admissible".to_owned());
            }
            if file_type.is_dir() {
                reject_python(&child)
            } else if child.extension().and_then(|value| value.to_str()) == Some("py") {
                Err(format!(
                    "Python conformance tooling is not admissible: {}",
                    child.display()
                ))
            } else {
                Ok(())
            }
        })
}

fn parse_row(index: usize, line: &str) -> CheckResult<EvidenceRow<'_>> {
    let columns = line.split('\t').collect::<Vec<_>>();
    let [property_id, evidence_class, executable_lane, implementation_binding, negative_control, claim_boundary] =
        columns.as_slice()
    else {
        return Err(format!(
            "registry line {} has {} columns; expected 6",
            index + 2,
            columns.len()
        ));
    };
    Ok(EvidenceRow {
        property_id,
        evidence_class,
        executable_lane,
        implementation_binding,
        negative_control,
        claim_boundary,
    })
}

fn parse_registry(body: &str) -> CheckResult<Vec<EvidenceRow<'_>>> {
    if body.lines().next() != Some(HEADER) {
        return Err("evidence registry header changed or is malformed".to_owned());
    }
    body.lines()
        .skip(1)
        .filter(|line| !line.trim().is_empty())
        .enumerate()
        .map(|(index, line)| parse_row(index, line))
        .collect()
}

fn validate_class(row: EvidenceRow<'_>) -> CheckResult<()> {
    if !CLASSES.contains(&row.evidence_class) {
        return Err(format!(
            "{}: unknown evidence_class {}",
            row.property_id, row.evidence_class
        ));
    }
    if row.claim_boundary.is_empty() {
        return Err(format!("{}: claim_boundary is required", row.property_id));
    }
    if row.evidence_class == "declaration-only" && row.executable_lane != "none" {
        return Err(format!(
            "{}: declaration-only evidence must use executable_lane=none",
            row.property_id
        ));
    }
    if row.evidence_class == "modeling-only" {
        require_file(row.executable_lane, "executable_lane", row.property_id)?;
        if row.claim_boundary != "modeling-only-no-runtime-claim" {
            return Err(format!(
                "{}: modeling-only evidence must preserve the no-runtime-claim boundary",
                row.property_id
            ));
        }
    }
    Ok(())
}

fn validate_strong_evidence(row: EvidenceRow<'_>) -> CheckResult<()> {
    if row.evidence_class != "implementation-linked" && row.evidence_class != "cross-runtime" {
        return Ok(());
    }
    require_file(row.executable_lane, "executable_lane", row.property_id)?;
    return binding::immutable_binding(row.implementation_binding).then_some(()).ok_or_else(|| {
        format!(
            "{}: stronger evidence requires owner/repository@<40 lowercase hex commit>",
            row.property_id
        )
    });
}

fn validate_row(row: EvidenceRow<'_>) -> CheckResult<()> {
    if row.property_id.is_empty() {
        return Err("property_id must not be empty".to_owned());
    }
    validate_class(row)?;
    validate_strong_evidence(row)?;
    if row.negative_control != "none" {
        require_file(row.negative_control, "negative_control", row.property_id)?;
    }
    Ok(())
}

fn validate_registry(body: &str) -> CheckResult<()> {
    let rows = parse_registry(body)?;
    if rows.is_empty() {
        return Err("evidence registry contains no properties".to_owned());
    }
    rows.iter().copied().try_for_each(validate_row)?;
    let ids = rows.iter().map(|row| row.property_id).collect::<Vec<_>>();
    let unique_ids = ids.iter().copied().collect::<HashSet<_>>();
    (ids.len() == unique_ids.len())
        .then_some(())
        .ok_or_else(|| "evidence registry contains duplicate property_id values".to_owned())
}

fn validate_repository() -> CheckResult<()> {
    let body = fs::read_to_string(REGISTRY)
        .map_err(|error| format!("cannot read {REGISTRY}: {error}"))?;
    validate_registry(&body)?;
    let conformance = Path::new("conformance");
    if !conformance.is_dir() {
        return Err("conformance directory is missing".to_owned());
    }
    reject_python(conformance)?;
    [
        "contracts/README.md",
        "conformance/README.md",
        "governance/PROMOTION.md",
    ]
    .into_iter()
    .try_for_each(|required| require_file(required, "required governance artifact", "repository"))
}

fn main() -> CheckResult<()> {
    validate_repository()
}

#[cfg(test)]
#[path = "evidence-governance/tests.rs"]
mod tests;
