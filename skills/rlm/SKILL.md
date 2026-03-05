---
name: rlm
description: "Recursive Language Model (RLM) pattern for processing large contexts. Use when dealing with massive files, logs, repos, or data that exceeds context windows. Trigger phrases: \"analyze large file\", \"process huge log\", \"scan entire repo\", \"recursive context\", \"RLM\", \"context compilation\", \"unbounded context\", \"too big for context\"."
---

# RLM — Recursive Language Model Pattern

Based on MIT's RLM paper (arXiv:2512.24601). Instead of stuffing data into the token window, write code to process it externally. Only the printed results enter context.

> **Tokens are CPU, not storage.** Never dump raw data into context. Write code to extract what matters, print only the summary.

## When to Use

- File/data too large for context window (logs, databases, binaries)
- Codebase-wide analysis (grep across 100+ files, dependency graphs)
- Multi-step data extraction where each step depends on prior results
- Any task where raw data would burn tokens without adding value

## How It Works

Write a Python script inline via Bash. The raw data never enters context — only stdout does.

### Simple extraction (most tasks)

```bash
python3 -c "
with open('/path/to/huge.log') as f:
    lines = f.readlines()
errors = [l for l in lines if 'ERROR' in l]
print(f'Found {len(errors)} errors in {len(lines)} lines')
for e in errors[:20]:
    print(e.strip())
"
```

### Multi-step analysis (complex tasks)

Chain multiple Bash calls. Each builds on the previous output.

**Step 1 — Survey:**
```bash
python3 -c "
import os
total = 0; by_ext = {}
for root, dirs, files in os.walk('/path/to/repo'):
    dirs[:] = [d for d in dirs if d not in ('.git','node_modules','__pycache__')]
    for f in files:
        ext = os.path.splitext(f)[1]
        by_ext[ext] = by_ext.get(ext, 0) + 1
        total += 1
print(f'Files: {total}')
for ext, n in sorted(by_ext.items(), key=lambda x: -x[1])[:10]:
    print(f'  {ext}: {n}')
"
```

**Step 2 — Slice:**
```bash
python3 -c "
import ast, glob, json
results = []
for f in glob.glob('/path/to/repo/**/*.py', recursive=True):
    tree = ast.parse(open(f).read())
    classes = [n.name for n in ast.walk(tree) if isinstance(n, ast.ClassDef)]
    funcs = [n.name for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)]
    if classes or funcs:
        results.append({'file': f, 'classes': classes, 'functions': funcs})
print(json.dumps(results, indent=2))
"
```

**Step 3 — Deep-dive** on specific files found in Step 2.

### Massive data (50MB+, needs sub-LLM decomposition)

Use `rlm-cli` which breaks data into chunks and processes each with a local LLM:

```bash
# With local Ollama
rlm-cli query "Find all security issues" --file /path/to/large.log --backend openai --model qwen3:8b --base-url http://localhost:11434/v1

# With local vLLM
rlm-cli query "Find bugs" --repo /path/to/repo --backend openai --model Qwen/Qwen3-8B --base-url http://localhost:8000/v1

# With Anthropic API
rlm-cli query "Analyze architecture" --repo /path/to/repo --backend anthropic --model claude-sonnet-4-6
```

## Decision Guide

| Situation | What to do |
|-----------|-----------|
| Large file, simple extraction | Write `python3 -c` via Bash, print summary |
| Multi-file analysis | Chain multiple Bash calls: survey → slice → deep-dive |
| 50MB+ data, needs AI reasoning per chunk | `rlm-cli` with local model (Ollama/vLLM) |
| Private data, no API calls | `rlm-cli` with local model |

## References

- Paper: https://arxiv.org/abs/2512.24601
- Official lib: https://github.com/alexzhang13/rlm
- Blogpost: https://alexzhang13.github.io/blog/2025/rlm/
