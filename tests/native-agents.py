import re
import sys
from pathlib import Path


bundle, agents = map(Path, sys.argv[1:])
contract = bundle / "dstack-mode/references/native-agents.md"
callers = [
    bundle / "dstack-mode/SKILL.md",
    bundle / "models.md",
    *(
        bundle / "skills" / name / "SKILL.md"
        for name in (
            "how", "why", "no-comments", "architect", "arena", "swarm",
            "reflect", "recall", "automate-me", "show-me-your-work",
            "figure-it-out", "run-evals",
        )
    ),
]
legacy = re.compile(
    r"available subagent tool|via the (?:pi )?subagents tool|"
    r"pi `subagents` tool|/subagents\b(?!/)|"
    r"tools\.subagents(?:_runs)?\b|agent: [\"']dstack-agent|"
    r"single Task subagent|one delegation call|subagent response body|"
    r"do not invent a native replacement",
    re.IGNORECASE,
)
errors = []

for path in [*bundle.rglob("*.md"), *agents.glob("*.md")]:
    for number, line in enumerate(path.read_text().splitlines(), 1):
        if legacy.search(line):
            errors.append(f"{path}:{number}: obsolete delegation instruction")

for path in callers:
    if not path.is_file():
        errors.append(f"missing delegation entry point: {path}")
        continue
    links = re.findall(r"\]\(([^)]+)\)", path.read_text())
    if not any((path.parent / link).resolve() == contract.resolve() for link in links):
        errors.append(f"{path}: missing link to shared native hc contract")

if not contract.is_file():
    errors.append(f"missing shared native hc contract: {contract}")
else:
    text = contract.read_text()
    for required in (
        "hc run --bg", "hc templates", "models.json", "--append-system-prompt",
        "first_message.sent", "hc wait --children all", "hc wait --children any",
        "hc send", "hc kill", "hc rm", "procedural", "HC_TERMINAL_ID",
        "-e builtin:mcp -e builtin:codemode",
    ):
        if required not in text:
            errors.append(f"{contract}: missing lifecycle contract {required!r}")

for path in [bundle / "dstack-mode/SKILL.md", agents / "dstack-agent.md"]:
    if "hc" not in path.read_text():
        errors.append(f"{path}: native delegation is not the default")

if errors:
    print("\n".join(f"FAIL: {error}" for error in errors), file=sys.stderr)
    sys.exit(1)

print(f"native agents: {len(callers)} entry points, lifecycle contract, no legacy dispatch")
