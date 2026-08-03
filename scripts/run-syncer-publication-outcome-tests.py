#!/usr/bin/env python3
"""Run the syncer publication-outcome tests with a safe dynamic-import boundary.

The production audit intentionally keeps its CLI filename hyphenated.  The unit
suite loads that file through ``importlib.util.spec_from_file_location``.  Python
3.12's dataclass implementation expects the executing module to be registered
in ``sys.modules`` while class decorators run, so this runner supplies that
normal import invariant only for the audit module and restores ``importlib``
immediately after the test module has loaded.
"""

from __future__ import annotations

import importlib
import importlib.util
import sys
import unittest
from types import ModuleType
from typing import Any

AUDIT_MODULE_NAME = "syncer_publication_outcome"
TEST_MODULE_NAME = "suite.operations.test_syncer_publication_outcome"


def _load_test_module() -> ModuleType:
    original_module_from_spec = importlib.util.module_from_spec

    def registered_module_from_spec(spec: Any) -> ModuleType:
        module = original_module_from_spec(spec)
        if getattr(spec, "name", None) == AUDIT_MODULE_NAME:
            sys.modules[AUDIT_MODULE_NAME] = module
        return module

    importlib.util.module_from_spec = registered_module_from_spec
    try:
        return importlib.import_module(TEST_MODULE_NAME)
    finally:
        importlib.util.module_from_spec = original_module_from_spec


def main() -> int:
    test_module = _load_test_module()
    suite = unittest.defaultTestLoader.loadTestsFromModule(test_module)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
