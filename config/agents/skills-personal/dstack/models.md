# dstack per-role model choices (overrides skill defaults)
# One line per role. Delete a line to fall back to the skill default.
# `inherit-parent` or `auto`: the role runs on the parent chat model.
feature, refactoring: fireworks/accounts/fireworks/models/deepseek-v4p1-flash:xhigh
bug-fix: openai/gpt-5.6-sol
prose, judgment, review: anthropic/claude-fable-5-1:xhigh
how critics: anthropic/claude-fable-5-1:xhigh
arena runners: anthropic/claude-fable-5-1:xhigh, openai/gpt-5.6-sol, fireworks/accounts/fireworks/models/deepseek-v4p1-flash:xhigh
arena cross-judge pool: anthropic/claude-fable-5-1:xhigh, openai/gpt-5.6-sol
interrogate reviewers: anthropic/claude-fable-5-1:xhigh, openai/gpt-5.6-sol, openrouter/z-ai/glm-5.3-flash:xhigh
swarm workers: fireworks/accounts/fireworks/models/deepseek-v4p1-flash:xhigh
reflect-judgment: anthropic/claude-fable-5-1:xhigh
