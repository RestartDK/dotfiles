# dstack per-role model choices (overrides skill defaults)
# One line per role. Delete a line to fall back to the skill default.
# `inherit-parent` or `auto`: the role runs on the parent chat model.
feature, refactoring: accounts/fireworks/models/kimi-k3
bug-fix: openai/gpt-5.6-sol
prose, judgment, review: anthropic/claude-fable-5:xhigh
how critics: anthropic/claude-fable-5:xhigh
arena runners: anthropic/claude-fable-5:xhigh, openai/gpt-5.6-sol, accounts/fireworks/models/kimi-k3
arena cross-judge pool: anthropic/claude-fable-5:xhigh, openai/gpt-5.6-sol
interrogate reviewers: anthropic/claude-fable-5:xhigh, openai/gpt-5.6-sol, accounts/fireworks/models/kimi-k3
swarm workers: accounts/fireworks/models/kimi-k3
reflect-judgment: anthropic/claude-fable-5:xhigh
