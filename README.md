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
# Copy agents and commands to your project or user config
cp -r .opencode/agents/ .opencode/commands/ ~/.config/opencode/

# Or use from project root (auto-detected from .opencode/)
```

In OpenCode, use `Ctrl+K` then select:
- `project:rlm` — invoke RLM for large-context tasks
- `project:rlm-stats` — show token savings dashboard
- `@rlm` — invoke the RLM agent directly

### RLM CLI (optional, for massive datasets)

```bash
uv pip install -e .
```

## Usage

The skill activates automatically when large-context tasks are detected. The PreToolUse hook warns before reading large files and suggests writing code to process them instead.

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

### Hooks

The plugin includes a PreToolUse hook that fires before `Read` and `Bash` tool calls:

- Checks file sizes before reading — suggests writing code to process data instead of dumping it into context
- Detects commands likely to produce large output (`cat`, `grep -r`, `curl`, etc.)
- Logs events to `~/.rlm/stats/events.jsonl` for the token savings dashboard

## Project Structure

```
rlm-skill/
├── .claude-plugin/
│   ├── marketplace.json       # Marketplace registry
│   └── plugin.json            # Claude Code plugin manifest
├── .opencode/
│   ├── agents/
│   │   └── rlm.md             # OpenCode agent definition
│   └── commands/
│       ├── rlm.md             # /rlm command for OpenCode
│       └── rlm-stats.md       # /rlm-stats command for OpenCode
├── hooks/
│   ├── hooks.json             # Hook configuration
│   └── pretooluse-rlm.mjs    # Large-file detection hook
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

For most tasks, writing code to process data externally is faster, cheaper, and equally accurate. The `rlm-cli` tool adds recursive sub-LLM decomposition for truly massive datasets (50MB+).

## Credits

This project builds on the work of:

- **[Alex Zhang, Tim Kraska, Omar Khattab](https://github.com/alexzhang13/rlm)** — MIT's RLM paper and official library ([arXiv:2512.24601](https://arxiv.org/abs/2512.24601))
- **[Mitko Vasilev (@mitkox)](https://github.com/mitkox)** — [RLMGW](https://github.com/mitkox/rlmgw) (RLM Gateway), demonstrating the local vLLM + Claude Code + REPL brain stack that inspired this skill
- **[Mert Koseoglu (@mksglu)](https://github.com/mksglu/claude-context-mode)** — [context-mode](https://github.com/mksglu/claude-context-mode) plugin for Claude Code, which implements the sandbox/REPL execution that keeps raw data out of context

## License

MIT
