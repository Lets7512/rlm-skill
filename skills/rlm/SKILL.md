---
name: rlm
description: "Recursive Language Model (RLM) pattern for processing large contexts. Use when dealing with massive files, logs, repos, or data that exceeds context windows. Trigger phrases: \"analyze large file\", \"process huge log\", \"scan entire repo\", \"recursive context\", \"RLM\", \"context compilation\", \"unbounded context\", \"too big for context\"."
---

# RLM — Recursive Language Model Protocol

Based on MIT's RLM paper (arXiv:2512.24601) and DSPy's structured REPL pattern. Instead of stuffing data into the token window, explore it programmatically through a structured protocol. Only printed results enter context.

> **Tokens are CPU, not storage.** Never dump raw data into context. Write code to extract what matters, print only the summary.

## When to Use

- File/data too large for context window (logs, databases, binaries)
- Codebase-wide analysis (grep across 100+ files, dependency graphs)
- Multi-step data extraction where each step depends on prior results
- Any task where raw data would burn tokens without adding value

## Decision Logic

| Size | Protocol |
|------|----------|
| < 5KB | Read directly — no RLM needed |
| 5KB–500KB | Steps 1-3 only (METADATA, PEEK, SEARCH) |
| 500KB+ | Full protocol steps 1-6 with sub-agent decomposition |

## The 6-Step Protocol

Follow these steps IN ORDER. Each step uses `python3 -c` via Bash. Raw data never enters context — only stdout does.

### Step 1: METADATA

Assess the file before touching it.

**For multi-file discovery:** Use Glob (Claude Code) or glob tool (OpenCode) to find files by pattern. Never use `find` via Bash — Glob is faster and keeps output compact.

**WebFetch is blocked.** Never use WebFetch/fetch to pull remote data into context. Instead, download via `python3 -c` using urllib/requests, save to a local file, then process that file through the protocol.

```bash
python3 -c "
import os
path = '/path/to/file'
size = os.path.getsize(path)
print(f'File: {path}')
print(f'Size: {size:,} bytes ({size/1024/1024:.1f}MB)')
print(f'Type: {os.path.splitext(path)[1] or \"unknown\"}')
with open(path, 'rb') as f:
    head = f.read(200)
    try: preview = head.decode('utf-8', errors='replace')
    except: preview = repr(head)
print(f'Preview: {preview[:200]}')
try:
    with open(path) as f:
        lines = sum(1 for _ in f)
    print(f'Lines: {lines:,}')
except: pass
"
```

Log: `python3 -c "import sys; sys.path.insert(0,'${CLAUDE_PLUGIN_ROOT}/src'); from stats import log_event; log_event('rlm_metadata','FILE_PATH',SIZE_BYTES,1)"`

### Step 2: PEEK

Sample strategically — head, tail, random slices, structure detection.

```bash
python3 -c "
with open('/path/to/file') as f:
    lines = f.readlines()
print('=== HEAD (first 20 lines) ===')
for l in lines[:20]: print(l.rstrip())
print(f'\n=== TAIL (last 10 lines) ===')
for l in lines[-10:]: print(l.rstrip())
print(f'\n=== SAMPLE (every {max(1,len(lines)//10)}th line, 10 samples) ===')
step = max(1, len(lines)//10)
for i in range(0, len(lines), step):
    print(f'L{i}: {lines[i].rstrip()[:120]}')
"
```

Log: `python3 -c "import sys; sys.path.insert(0,'${CLAUDE_PLUGIN_ROOT}/src'); from stats import log_event; log_event('rlm_peek','FILE_PATH',SIZE_BYTES,1)"`

### Step 3: SEARCH

Targeted extraction based on what PEEK revealed.

```bash
python3 -c "
import re
with open('/path/to/file') as f:
    content = f.read()
# Adapt search to what you're looking for:
matches = re.findall(r'PATTERN', content)
print(f'Found {len(matches)} matches')
for m in matches[:30]:
    print(m[:200])
"
```

Log: `python3 -c "import sys; sys.path.insert(0,'${CLAUDE_PLUGIN_ROOT}/src'); from stats import log_event; log_event('rlm_search','FILE_PATH',SIZE_BYTES,2)"`

### Step 4: ANALYZE (500KB+ only)

Decompose into sub-queries. **Max 15 sub-queries.**

**Both Claude Code and OpenCode support sub-agents for parallel analysis.**

For each chunk identified in SEARCH, spawn a sub-agent:
- **Claude Code:** Use the Agent tool to spawn sub-agents per chunk
- **OpenCode:** Use @explore sub-agents or session agents per chunk
- Pass ONLY the chunk + the specific question (never the full file)
- Each sub-agent returns a focused summary (max 1,000 chars)

To extract a chunk for a sub-agent:

```bash
python3 -c "
with open('/path/to/file') as f:
    lines = f.readlines()
chunk = lines[START:END]
print(f'=== Chunk N ({len(chunk)} lines) ===')
for l in chunk: print(l.rstrip())
"
```

Log each sub-agent: `python3 -c "import sys; sys.path.insert(0,'${CLAUDE_PLUGIN_ROOT}/src'); from stats import log_event; log_event('rlm_analyze','FILE_PATH',CHUNK_SIZE,2)"`

Sub-query types:
- **Chunk analysis**: split large file by sections
- **Cross-reference**: find callers/references across files
- **Semantic filter**: narrow down too many SEARCH results
- **Recursive drill**: sub-query reveals deeper structure to explore

### Step 5: SYNTHESIZE

Combine findings from all sub-queries. Cross-reference. Resolve conflicts. This is reasoning — no code needed unless aggregating data.

### Step 6: SUBMIT

Always end with an explicit SUBMIT block:

```
=== RLM SUBMIT ===
Query: [original question]
Confidence: [high/medium/low]
Protocol: [steps executed, e.g. METADATA->PEEK->SEARCH->ANALYZE->SYNTHESIZE]
Sub-queries: [N spawned, N completed]
Data processed: [size of original file]
Context used: [estimated tokens that entered context]

[Final structured answer here]
=== END ===
```

Log: `python3 -c "import sys; sys.path.insert(0,'${CLAUDE_PLUGIN_ROOT}/src'); from stats import log_event; log_event('rlm_submit','FILE_PATH',SIZE_BYTES,2)"`

Confidence levels:
- **high**: All relevant data found, cross-referenced, no ambiguity
- **medium**: Answer found but some sections couldn't be fully analyzed
- **low**: Iteration budget exhausted or data was ambiguous

## Iteration Budget

| Parameter | Limit |
|-----------|-------|
| Max REPL iterations | 20 |
| Max output per step | 15,000 chars |
| Max sub-queries | 15 |

If you hit max iterations without resolving, SUBMIT with confidence: low.

## Massive Data (50MB+)

Use `rlm-cli` which adds recursive sub-LLM decomposition:

```bash
# With local Ollama
rlm-cli query "Find all security issues" --file /path/to/large.log --backend openai --model qwen3:8b --base-url http://localhost:11434/v1

# With local vLLM
rlm-cli query "Find bugs" --repo /path/to/repo --backend openai --model Qwen/Qwen3-8B --base-url http://localhost:8000/v1

# With Anthropic API
rlm-cli query "Analyze architecture" --repo /path/to/repo --backend anthropic --model claude-sonnet-4-6
```

Log: `python3 -c "import sys; sys.path.insert(0,'${CLAUDE_PLUGIN_ROOT}/src'); from stats import log_event; log_event('rlm_cli','FILE_PATH',SIZE_BYTES,3)"`

## References

- Paper: https://arxiv.org/abs/2512.24601
- DSPy RLM: https://dspy.ai/api/modules/RLM/
- Official lib: https://github.com/alexzhang13/rlm
