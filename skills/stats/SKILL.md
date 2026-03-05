---
name: stats
description: |
  Show RLM token savings dashboard — how much context was saved by using RLM patterns
  instead of dumping raw data into the context window.
  Trigger: /rlm:stats
user_invocable: true
---

# RLM Token Savings Dashboard

Show how much context window space RLM patterns have saved.

## Instructions

1. Run the stats script using Bash:
   ```
   python "${CLAUDE_PLUGIN_ROOT}/src/stats.py"
   ```
   If `${CLAUDE_PLUGIN_ROOT}` is not set (e.g., during local dev), use the plugin directory path directly.

2. **CRITICAL**: Copy-paste the ENTIRE output as markdown into your response. Do NOT summarize or collapse it. The user must see the full dashboard.

3. After the dashboard, add a one-line highlight, e.g.:
   - "RLM saved **45,000 tokens** (~97% reduction) by keeping raw data out of context."
   - If no events yet: "No RLM events logged yet. The PreToolUse hook will start tracking when it detects large file operations (>500KB)."

4. If the user says "reset", run:
   ```
   python "${CLAUDE_PLUGIN_ROOT}/src/stats.py" reset
   ```
