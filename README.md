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

### Custom Tools (Both Platforms)

The plugin provides MCP tools (Claude Code) and custom tools (OpenCode):

| Tool | Purpose |
|------|---------|
| `rlm_execute` | Run code in a sandboxed subprocess (python/js/shell). Only stdout enters context. |
| `rlm_execute_file` | Run code against a file. Content loaded as `FILE_CONTENT` variable, never enters context. |
| `rlm_index` | Index file content into an FTS5 knowledge base for later search. |
| `rlm_search` | Search indexed content with BM25 ranking + 3-layer fallback (porter/trigram/fuzzy). |
| `rlm_stats` | Show knowledge base statistics. |

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

**Claude Code** — PreToolUse hook (`hooks/pretooluse-rlm.mjs`) fires before `Read`, `Bash`, and `WebFetch` tool calls.

**OpenCode** — Plugin interceptor (`plugins/rlm-interceptor.ts`) uses `tool.execute.before` to silently rewrite large file reads into metadata scripts via `output.args` modification.

Both platforms:
- Rewrite reads of files >5KB into metadata summaries (size, head/tail preview, protocol instructions)
- Detect large-output commands (`cat`, `grep -r`, `curl`, `Get-Content`, `Select-String`, etc.)
- Redirect WebFetch to python urllib download + process
- Log events to `~/.rlm/stats/events.jsonl` for the token savings dashboard

## Project Structure

```
rlm-skill/
├── .claude-plugin/
│   ├── marketplace.json       # Marketplace registry
│   └── plugin.json            # Claude Code plugin manifest
├── .opencode/
│   ├── agents/
│   │   └── rlm.md             # OpenCode agent definition
│   ├── commands/
│   │   ├── rlm.md             # /rlm command for OpenCode
│   │   └── rlm-stats.md       # /rlm-stats command for OpenCode
│   └── plugins/
│       ├── rlm-interceptor.ts  # Intercept + rewrite + custom tools
│       ├── rlm-store.ts        # FTS5 knowledge base (SQLite)
│       └── rlm-executor.ts     # Sandbox subprocess executor
├── mcp/
│   ├── server.mjs             # MCP server (rlm_execute/search/index)
│   └── store.mjs              # FTS5 knowledge base (shared)
├── hooks/
│   ├── hooks.json             # Hook configuration
│   └── pretooluse-rlm.mjs    # Silent rewrite hook (updatedInput)
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
│   └── test_plugin_structure.py
├── pyproject.toml
├── LICENSE
└── README.md
```

## How It Works

The core insight from MIT's RLM paper: **tokens are CPU, not storage**. Never dump raw data into context. Write code to extract what matters, print only the summary.

```
Traditional:  LLM(prompt + 500MB_data) → burns entire context window
RLM pattern:  LLM writes code → code runs on data → only stdout enters context
```

The OpenCode plugin adds three layers:
1. **Interceptor** — silently rewrites `Read`/`Bash`/`WebFetch` calls that would dump large data into context
2. **Knowledge Base** — FTS5 SQLite with porter+trigram dual tables for indexing and searching large content
3. **Sandbox Executor** — isolated subprocess execution, only stdout returns to the model

For most tasks, writing code to process data externally is faster, cheaper, and equally accurate. The `rlm-cli` tool adds recursive sub-LLM decomposition for truly massive datasets (50MB+).

## Benchmarks

Tested with OpenCode 1.2.15 on OpenRouter:

| Test | File Size | Tokens Used | Without RLM (est.) | Savings |
|------|-----------|-------------|---------------------|---------|
| JSON analysis | 121 KB | 24,670 | ~30K+ (file in context) | Blocked read, used python |
| Multi-query analysis | 978 KB | 28,557 | ~250K+ (file in context) | 89%+ reduction |
| Web fetch + summarize | ~15 KB | 73,912 | Similar (small file) | WebFetch redirected |

## Credits

This project builds on the work of:

- **[Alex Zhang, Tim Kraska, Omar Khattab](https://github.com/alexzhang13/rlm)** — MIT's RLM paper and official library ([arXiv:2512.24601](https://arxiv.org/abs/2512.24601))
- **[Mitko Vasilev (@mitkox)](https://github.com/mitkox)** — [RLMGW](https://github.com/mitkox/rlmgw) (RLM Gateway), demonstrating the local vLLM + Claude Code + REPL brain stack that inspired this skill
- **[Mert Koseoglu (@mksglu)](https://github.com/mksglu/claude-context-mode)** — [context-mode](https://github.com/mksglu/claude-context-mode) plugin for Claude Code, which implements the sandbox/REPL execution and FTS5 knowledge base patterns that inspired the OpenCode plugin architecture

## License

MIT
