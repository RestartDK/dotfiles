### Stack-up

**You own a demo-ready environment, not a list of Running services.** For "get the stack up", "get the app demoable", "set up my dev environment", "seed a user and log in", or as the blocking first step of any playbook that needs a live local stack. Success is visual or endpoint evidence, never a process table.

1. Check for an already-running stack first. One dev stack per user (repo rule); if one is up, ask before touching it, per Autonomy's irreversible-writes line. `process-compose list` or the repo layer names the check.
2. Run the orchestrator script, `scripts/stack-up.sh`, from the repo root (the **principle-build-the-lever** skill; the script is the artifact, this playbook only interprets it). Flags: `--port <n>`, `--reset` (down + wipe local DB state, the migration-checksum escape hatch), `--seed` (predefined profiles), `--fixture` (real prod fixture import), `--reauth` (force new JWT/API key), `--demo` (screenshot proof).
3. On failure, read the failing step's output and the service logs (`journalctl -t <service>`, service names in the repo layer) before rerunning anything. Diagnose, then rerun only the failed step; the script is idempotent per **principle-make-operations-idempotent**. Never loop the whole script hoping.
4. Prove it works on the real surface (the **principle-prove-it-works** skill). Minimum: the app endpoint answers and a dev-login URL resolves. With `--demo`: a headless chromium screenshot of the logged-in app, saved to a printed path. For interactive demos, use the repo's browser-automation skill.
5. Report the one-click login URL, the auth artifact path, seeded profiles, and the evidence path. Stack-up never reports success without evidence.

**Reply:** endpoint, login URL(s), auth file path, what was seeded, evidence (screenshot path or curl proof), and any service that needed a retry with its cause.
