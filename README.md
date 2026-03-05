# RLM Skill

A plugin for **Claude Code** and **OpenCode** implementing the **Recursive Language Model (RLM)** pattern from MIT's paper ([arXiv:2512.24601](https://arxiv.org/abs/2512.24601)). Instead of stuffing massive data into the context window, treat it as an external variable in a REPL and write code to programmatically examine, decompose, and search it. Only results enter context.

## Install

### Claude Code

```
/plugin marketplace add lets7512/rlm-skill
/plugin install rlm@rlm-skill
```

Restart Claude Code. Done.

Or load for a single session:
```bash
claude --plugin-dir /path/to/rlm-skill
```

### OpenCode

```bash
# Copy agents, commands, and plugins to your project or user config
cp -r .opencode/agents/ .opencode/commands/ .opencode/plugins/ ~/.config/opencode/

# Or use from project root (auto-detected from .opencode/)
# Install plugin dependencies
cd .opencode && npm install
```

The **RLM interceptor plugin** (`plugins/rlm-interceptor.ts`) automatically rewrites large file reads into metadata summaries and provides custom tools for sandbox execution and knowledge base search.

In OpenCode, use `Ctrl+K` then select:
- `project:rlm` — invoke RLM for large-context tasks
- `project:rlm-stats` — show token savings dashboard
- `@rlm` — invoke the RLM agent directly

### RLM CLI (optional, for massive datasets)

```bash
uv pip install -e .
```

## Usage

The skill activates automatically when large-context tasks are detected. The interceptor silently rewrites tool calls to prevent raw data from entering context.

Invoke directly in Claude Code:
```
/rlm:rlm analyze this 500MB log file for error patterns
```

Invoke in OpenCode:
```
@rlm analyze this 500MB log file for error patterns
```

Check token savings:
```
/rlm:stats
```

### Custom Tools

The plugin provides MCP tools (Claude Code) and custom tools (OpenCode):

| Tool | Purpose |
|------|---------|
| `rlm_execute` | Run code in a sandboxed subprocess (python/js/shell). Only stdout enters context. |
| `rlm_execute_file` | Run code against a file. Content loaded as `FILE_CONTENT` variable, never enters context. |
| `rlm_index` | Index file content into an FTS5 knowledge base for later search. |
| `rlm_search` | Search indexed content with smart snippets + BM25 ranking + 3-layer fallback (porter/trigram/fuzzy). |
| `rlm_batch_execute` | Run multiple commands + search queries in ONE call. Saves tool-call overhead. |
| `rlm_fetch_and_index` | Fetch URL, convert HTML to text, chunk and index. Raw page never enters context. |
| `rlm_stats` | Show knowledge base statistics (indexed sources, chunk count, DB size). |

#### Smart Snippets

Search results use **smart snippet extraction** — instead of returning full chunks, the search highlights windows around matching query terms with `...` context bridges. This minimizes tokens while preserving relevance.

#### 3-Layer Search Fallback

1. **Porter stemming** (FTS5 default) — handles word variants (`running` matches `run`)
2. **Trigram substring** — catches partial matches (`config` matches `configuration`)
3. **Fuzzy Levenshtein** — tolerates typos (`reuslt` matches `result`)

Results are merged and deduplicated with BM25 ranking.

#### Batch Execute

`rlm_batch_execute` accepts multiple shell commands and search queries in a single tool call:

```json
{
  "commands": [
    { "language": "python", "code": "import json; print(len(json.load(open('data.json'))))" },
    { "language": "shell", "code": "wc -l *.log" }
  ],
  "queries": ["error handling", "timeout config"]
}
```

This saves tool-call overhead when you need to run several operations at once.

#### Fetch and Index

`rlm_fetch_and_index` downloads a URL, converts HTML to clean text (stripping scripts, styles, and tags), chunks the content, and indexes it into the FTS5 knowledge base. The raw page never enters context:

```json
{
  "url": "https://docs.example.com/api-reference",
  "source": "API Docs"
}
```

Then use `rlm_search` with `source: "API Docs"` to query specific sections.

### CLI Tool

For truly massive datasets (50MB+) that need recursive sub-LLM decomposition:

```bash
# Analyze a repo
rlm-cli query "Find all security issues" --repo /path/to/repo --stats

# Interactive REPL
rlm-cli repl --file /path/to/data.json

# With local vLLM
rlm-cli query "Find bugs" --repo . --backend openai --model Qwen/Qwen3-8B --base-url http://localhost:8000/v1
```

### Hooks & Interceptors

**Claude Code** — PreToolUse hook (`hooks/pretooluse-rlm.mjs`) fires before `Read`, `Bash`, and `WebFetch` tool calls. Uses `updatedInput` for silent rewriting — the model sees the rewritten result without knowing the original was intercepted.

**OpenCode** — Plugin interceptor (`plugins/rlm-interceptor.ts`) uses `tool.execute.before` to silently rewrite large file reads into metadata scripts via `output.args` modification.

Both platforms:
- Rewrite reads of files >5KB into metadata summaries (size, line count, head/tail preview, protocol instructions)
- Detect large-output commands (`cat`, `grep -r`, `curl`, `Get-Content`, `Select-String`, etc.)
- Redirect WebFetch to python urllib download + process
- Log events to `~/.rlm/stats/events.jsonl` for the token savings dashboard

## How It Works

The core insight from MIT's RLM paper: **tokens are CPU, not storage**. Never dump raw data into context. Write code to extract what matters, print only the summary.

```
Traditional:  LLM(prompt + 500MB_data) → burns entire context window
RLM pattern:  LLM writes code → code runs on data → only stdout enters context
```

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Claude Code / OpenCode                                 │
│                                                         │
│  ┌──────────────┐    ┌──────────────┐                   │
│  │  Hook /       │    │  MCP Server / │                  │
│  │  Interceptor  │    │  Plugin Tools │                  │
│  │              │    │              │                    │
│  │  Read ──┐    │    │  rlm_execute │                   │
│  │  Bash ──┤    │    │  rlm_search  │                   │
│  │  Web  ──┘    │    │  rlm_index   │                   │
│  │    ↓         │    │  rlm_batch   │                   │
│  │  Rewrite to  │    │  rlm_fetch   │                   │
│  │  metadata    │    │  rlm_stats   │                   │
│  └──────────────┘    └──────┬───────┘                   │
│                             │                           │
│                    ┌────────▼────────┐                   │
│                    │  FTS5 Knowledge │                   │
│                    │  Base (SQLite)  │                   │
│                    │                 │                   │
│                    │  Porter + Tri-  │                   │
│                    │  gram + Fuzzy   │                   │
│                    └─────────────────┘                   │
│                                                         │
│                    ┌─────────────────┐                   │
│                    │  Sandbox        │                   │
│                    │  Executor       │                   │
│                    │                 │                   │
│                    │  python/js/sh   │                   │
│                    │  stdout only →  │                   │
│                    │  back to model  │                   │
│                    └─────────────────┘                   │
└─────────────────────────────────────────────────────────┘
```

The plugin operates in three layers:

1. **Interceptor** — silently rewrites `Read`/`Bash`/`WebFetch` calls that would dump large data into context. The model receives a metadata summary with file size, line count, and head/tail preview instead of raw content.

2. **Knowledge Base** — FTS5 SQLite with porter stemming + trigram substring dual virtual tables. Content is chunked (2000 chars, 200 overlap), indexed, and searchable with smart snippet extraction and BM25 ranking.

3. **Sandbox Executor** — isolated subprocess execution (python, javascript, shell). File content is injected as a variable (`FILE_CONTENT`), code runs externally, and only stdout returns to the model.

## Project Structure

```
rlm-skill/
├── .claude-plugin/
│   ├── marketplace.json       # Marketplace registry
│   └── plugin.json            # Claude Code plugin manifest (incl. MCP)
├── .opencode/
│   ├── agents/
│   │   └── rlm.md             # OpenCode agent definition
│   ├── commands/
│   │   ├── rlm.md             # /rlm command for OpenCode
│   │   └── rlm-stats.md       # /rlm-stats command for OpenCode
│   └── plugins/
│       ├── rlm-interceptor.ts  # Intercept + rewrite + 5 custom tools
│       ├── rlm-store.ts        # FTS5 knowledge base (SQLite)
│       └── rlm-executor.ts     # Sandbox subprocess executor
├── mcp/
│   ├── server.mjs             # MCP server (7 tools)
│   ├── store.mjs              # FTS5 knowledge base (shared)
│   └── package.json           # MCP dependencies
├── hooks/
│   ├── hooks.json             # Hook configuration
│   └── pretooluse-rlm.mjs     # Silent rewrite hook (updatedInput)
├── skills/
│   ├── rlm/
│   │   └── SKILL.md           # Skill instructions
│   └── stats/
│       └── SKILL.md           # Token savings dashboard skill
├── src/
│   ├── __init__.py
│   ├── cli.py                 # RLM CLI tool (rlm-cli)
│   └── stats.py               # Token savings dashboard (rlm-stats)
├── tests/
│   ├── test_plugin_structure.py  # 23 structural tests
│   └── generate_testbench.py     # 1M-token benchmark generator
├── pyproject.toml
├── LICENSE
└── README.md
```

## Benchmarks

Tested with OpenCode 1.2.15 + MiniMax M2.5 on OpenRouter (Novita):

| Test | File Size | Tokens Used | Without RLM (est.) | Savings |
|------|-----------|-------------|---------------------|---------|
| JSON analysis | 121 KB | 24,670 | ~30K+ (file in context) | Blocked read, used python |
| Multi-query analysis | 978 KB | 28,557 | ~250K+ (file in context) | 89%+ reduction |
| Web fetch + summarize | ~15 KB | 73,912 | Similar (small file) | WebFetch redirected |
| **1M-token testbench** | **4.1 MB** | **~240K** (12 calls) | **~1M+ per call** | **96%+ reduction** |

### 1M-Token Benchmark Details

**Dataset:** `tests/testbench_1M.json` — 1,500 realistic HTTP server log entries with nested JSON (headers, query params, response bodies, stack traces). Generated by `tests/generate_testbench.py`.

**Prompt:** "Analyze testbench_1M.json — find all 500 errors, slowest endpoints, SQL injection attempts, traffic patterns, and suspicious users"

**What happened:**
1. Interceptor rewrote `Read` to metadata summary (size, head/tail preview, protocol hint)
2. Model used `rlm_execute` with python scripts across ~8 tool calls
3. Each call: ~20-25K tokens (system prompt + code + stdout)
4. Raw file never entered context

**Results found:**
- 11 HTTP 500 errors grouped by endpoint (auth/login, admin/logs, health top)
- P50/P95/P99 latency by endpoint (auth/login slowest at P99)
- 2 SQL injection attempts (`'; DROP TABLE users; --`)
- Traffic patterns by hour (peak: hours 10, 13 at 77 req each)
- No users exceeding 100 req/min threshold

**Cost:** $0.016 total for 12 API calls (~$0.0013/call avg)

## Credits

This project builds on the work of:

- **[Alex Zhang, Tim Kraska, Omar Khattab](https://github.com/alexzhang13/rlm)** — MIT's RLM paper and official library ([arXiv:2512.24601](https://arxiv.org/abs/2512.24601))
- **[Mitko Vasilev (@mitkox)](https://github.com/mitkox)** — [RLMGW](https://github.com/mitkox/rlmgw) (RLM Gateway), demonstrating the local vLLM + Claude Code + REPL brain stack that inspired this skill
- **[Mert Koseoglu (@mksglu)](https://github.com/mksglu/claude-context-mode)** — [context-mode](https://github.com/mksglu/claude-context-mode) plugin for Claude Code, which implements the sandbox/REPL execution and FTS5 knowledge base patterns that inspired the OpenCode plugin architecture

## License

MIT
