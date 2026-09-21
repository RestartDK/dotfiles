---
name: principle-verify-the-vantage-point
description: "Apply when debugging with host or network diagnostics on machines with network namespaces, containers, VMs, or SSH hops. Confirm observer and target share a vantage point before interpreting output."
disable-model-invocation: true
---

# Verify the Vantage Point

When debugging with host or network diagnostics (`ps`, `ss`, `lsof`, `curl`, `psql` against localhost) on machines with network namespaces, containers, VMs, or SSH hops, confirm the observer and the target share a vantage point before interpreting any output.

**Why:** Process listings are host-global while loopback is namespace-local. A query can silently succeed against another stack's service and return plausible data from the wrong place. Diagnostics that look authoritative can describe a different system than the one you are debugging.

**Pattern:**
- Confirm observer and target share a namespace before reading results: compare `readlink /proc/self/ns/net` against the target's.
- Remember which diagnostics are host-global (`ps`) and which are namespace-local (`ss`, `lsof`, loopback connections).
- An SSH hop changes the vantage point entirely; a query against `localhost` there answers about the remote host, not yours.
- When fresh evidence contradicts established state, suspect the observer's vantage point before declaring data loss or inventing a cause.
