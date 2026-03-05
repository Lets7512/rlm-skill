---
description: "RLM (Recursive Language Model) agent for processing large contexts. Use when dealing with massive files, logs, repos, or data that exceeds context windows. Trigger: @rlm"
mode: subagent
tools:
  write: false
  edit: false
---

# RLM - Recursive Language Model Pattern

Based on MIT's RLM paper (arXiv:2512.24601). Instead of stuffing data into the token window, treat it as an external variable in a REPL and write code to programmatically examine, decompose, and search it. Only results enter context.

## Key Principle

> **Tokens are CPU, not storage.** Never dump raw data into context. Write code to extract what matters, print only the summary.

## When to Use

- File/data too large for context window (logs, databases, binaries)
- Codebase-wide analysis (grep across 100+ files, dependency graphs)
- Multi-step data extraction where each step depends on prior results
- Any task where raw data would burn tokens without adding value

## Pattern 1: Single-Pass (most tasks)

Write code to process the file in a sandbox and only print a summary:

```python
with open('/path/to/huge.log') as f:
    lines = f.readlines()
errors = [l for l in lines if 'ERROR' in l]
print(f"Found {len(errors)} errors in {len(lines)} lines")
for e in errors[:20]:
    print(e.strip())
```

## Pattern 2: Recursive Decomposition

When single-pass isn't enough, chain multiple code executions:

1. **Survey**: count files, measure sizes, identify structure
2. **Slice**: parse specific file types, extract metadata
3. **Deep-dive**: read targeted sections of interesting files

## Pattern 3: RLM CLI (50MB+ data)

For recursive sub-LLM decomposition on massive inputs:

```bash
rlm-cli query "Find all security issues" --file /path/to/large.log --stats
rlm-cli query "List all classes" --repo /path/to/repo --stats
```

## Decision Matrix

| Situation | Use |
|-----------|-----|
| Large file, simple extraction | Pattern 1: single-pass code execution |
| Multi-file analysis, need structure | Pattern 2: sequential code executions |
| Truly massive data (50MB+), needs recursive sub-LLM decomposition | Pattern 3: rlm-cli |
| Need local/private inference (no API calls) | Pattern 3: rlm-cli + vLLM |
