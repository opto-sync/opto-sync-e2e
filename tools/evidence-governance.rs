use std::{collections::HashSet, fs, path::{Path, PathBuf}};

const REGISTRY: &str = "conformance/evidence-registry.tsv";
const HEADER: &str = "property_id\tevidence_class\texecutable_lane\timplementation_binding\tnegative_control\tclaim_boundary";
const CLASSES: [&str; 4] = ["declaration-only", "modeling-only", "implementation-linked", "cross-runtime"];

fn fail(message: impl AsRef<str>) -> ! {
    eprintln!("evidence-governance: {}", message.as_ref());
    std::process::exit(1);
}

fn require_file(path: &str, field: &str, property_id: &str) {
    if !Path::new(path).is_file() {
        fail(format!("{property_id}: {field} does not name a repository file: {path}"));
    }
}

fn reject_python(path: &Path) {
    let entries = fs::read_dir(path).unwrap_or_else(|error| fail(format!("cannot read {}: {error}", path.display())));
    for entry in entries {
        let entry = entry.unwrap_or_else(|error| fail(format!("cannot read directory entry: {error}")));
        let child = entry.path();
        if child.is_dir() {
            reject_python(&child);
        } else if child.extension().and_then(|value| value.to_str()) == Some("py") {
            fail(format!("Python conformance tooling is not admissible: {}", child.display()));
        }
    }
}

fn main() {
    let body = fs::read_to_string(REGISTRY).unwrap_or_else(|error| fail(format!("cannot read {REGISTRY}: {error}")));
    let mut lines = body.lines();
    if lines.next() != Some(HEADER) {
        fail("evidence registry header changed or is malformed");
    }

    let mut ids = HashSet::new();
    let mut count = 0usize;
    for (index, line) in lines.enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let columns: Vec<&str> = line.split('\t').collect();
        if columns.len() != 6 {
            fail(format!("registry line {} has {} columns; expected 6", index + 2, columns.len()));
        }
        let property_id = columns[0];
        let evidence_class = columns[1];
        let executable_lane = columns[2];
        let implementation_binding = columns[3];
        let negative_control = columns[4];
        let claim_boundary = columns[5];

        if property_id.is_empty() || !ids.insert(property_id.to_owned()) {
            fail(format!("registry line {} has an empty or duplicate property_id: {property_id}", index + 2));
        }
        if !CLASSES.contains(&evidence_class) {
            fail(format!("{property_id}: unknown evidence_class {evidence_class}"));
        }
        if claim_boundary.is_empty() {
            fail(format!("{property_id}: claim_boundary is required"));
        }

        match evidence_class {
            "declaration-only" => {
                if executable_lane != "none" {
                    fail(format!("{property_id}: declaration-only evidence must use executable_lane=none"));
                }
            }
            "modeling-only" => {
                require_file(executable_lane, "executable_lane", property_id);
                if claim_boundary != "modeling-only-no-runtime-claim" {
                    fail(format!("{property_id}: modeling-only evidence must preserve the no-runtime-claim boundary"));
                }
            }
            "implementation-linked" | "cross-runtime" => {
                require_file(executable_lane, "executable_lane", property_id);
                if !implementation_binding.contains('@') {
                    fail(format!("{property_id}: stronger evidence requires an immutable implementation binding containing @<revision>"));
                }
            }
            _ => unreachable!(),
        }

        if negative_control != "none" {
            require_file(negative_control, "negative_control", property_id);
        }
        count += 1;
    }

    if count == 0 {
        fail("evidence registry contains no properties");
    }

    let conformance = PathBuf::from("conformance");
    if !conformance.is_dir() {
        fail("conformance directory is missing");
    }
    reject_python(&conformance);

    for required in ["contracts/README.md", "conformance/README.md", "governance/PROMOTION.md"] {
        require_file(required, "required governance artifact", "repository");
    }

    println!("evidence-governance: validated {count} registered properties");
}
