import os
from pathlib import Path
import unittest


ROOT = Path(os.environ.get("DOTFILES_ROOT", Path(__file__).resolve().parents[1]))
if not (ROOT / "flake.nix").is_file():
    raise RuntimeError(f"Not a dotfiles checkout: {ROOT}")

RETIRED_PATHS = (
    "config/pi/agent/extensions/pi-herdr",
    "config/pi/agent/extensions/pi-coordination",
    "config/pi/agent/extensions/pi-no-sleep",
    "config/pi/agent/extensions/subagents",
    "config/pi/agent/extensions/herdr-agent-state.ts",
    "config/pi/agent/lib/completion-delivery.ts",
    "config/pi/agent/lib/completion-delivery.test.ts",
    "config/claude/hooks/herdr-agent-state.sh",
    "config/codex/herdr-agent-state.sh",
    "config/opencode/plugins/herdr-agent-state.js",
    "packages/dstack/src/herdr.ts",
    "packages/dstack/tests/herdr.test.ts",
    "tests/agent-profiles/backend.test.ts",
    "tests/agent-profiles/protocol.test.ts",
    "tests/pi-profiled/dispatch.test.ts",
    "tests/herdr-cli-proof.ts",
    "tests/herdr-repo-env.ts",
    "tests/herdr-runtime.ts",
    "tests/scatterer-env.py",
)
RETIRED_REFERENCES = (
    "pi-herdr",
    "pi-coordination",
    "pi-no-sleep",
    "extensions/subagents",
    "subagents_runs",
    "PI_POLICY_TEST_EXTENSION",
    "herdr-agent-state",
    "completion-delivery",
    "worktree_enter",
    "scatterer",
    "terminal-browser",
)
SOURCE_ROOTS = (
    ".github",
    "bin",
    "config",
    "hosts",
    "modules",
    "packages",
    "profiles",
    "tests",
    "flake.nix",
    "flake.lock",
    "treefmt.nix",
)


class RetiredIntegrationsTest(unittest.TestCase):
    def test_retired_implementations_are_absent(self):
        remaining = [path for path in RETIRED_PATHS if (ROOT / path).exists()]
        self.assertEqual(remaining, [], "Retired implementations remain")

    def test_active_sources_do_not_reference_retired_integrations(self):
        matches = []
        for source in SOURCE_ROOTS:
            root = ROOT / source
            files = root.rglob("*") if root.is_dir() else [root]
            for path in files:
                relative = path.relative_to(ROOT)
                if not path.is_file() or relative.as_posix() == "tests/test_retired_integrations.py":
                    continue
                if any(part in {"node_modules", "target", "__pycache__"} for part in relative.parts):
                    continue
                try:
                    content = path.read_text(encoding="utf-8")
                except UnicodeDecodeError:
                    continue
                for marker in RETIRED_REFERENCES:
                    if marker in content:
                        matches.append(f"{path.relative_to(ROOT)}: {marker}")
        self.assertEqual(matches, [], "Active sources still reference retired integrations")


if __name__ == "__main__":
    unittest.main()
