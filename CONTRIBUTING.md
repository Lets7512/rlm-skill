# Contributing to rlm-skill

This project is MIT-licensed and welcomes contributions. Every issue, PR, and idea matters.

Don't overthink it. If you found a bug, report it. If you have an idea, open an issue. If you wrote a fix, submit the PR. A rough draft beats a perfect plan that never ships.

---

## Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) v1.0.33+ installed
- Node.js 20+ or [Bun](https://bun.sh/) (bun preferred for hook speed)
- Python 3.10+ (for stats and CLI)
- Optionally: [OpenCode](https://github.com/opencode-ai/opencode) for testing OpenCode integration

## Local Development Setup

### 1. Clone the repo

```bash
git clone https://github.com/lets7512/rlm-skill.git
cd rlm-skill
```

### 2. Test the plugin in Claude Code

```bash
claude --plugin-dir ./
```

This loads the plugin directly without installation. Inside the session:

- `/rlm:rlm` — test the main skill
- `/rlm:stats` — test the stats dashboard
- Try reading a large file (>500KB) to trigger the PreToolUse hook

### 3. Test in OpenCode

```bash
opencode
```

Then use `Ctrl+K` → `project:rlm` or `@rlm` to invoke the agent.

### 4. Run the test suite

```bash
pip install pytest
pytest tests/test_plugin_structure.py -v
```

## Making Changes

### Plugin structure

```
rlm-skill/
├── .claude-plugin/plugin.json   # Plugin manifest
├── skills/                      # Claude Code skills
│   ├── rlm/SKILL.md
│   └── stats/SKILL.md
├── hooks/
│   ├── hooks.json               # Hook configuration (auto-discovered)
│   └── pretooluse-rlm.mjs       # Large-file detection hook
├── .opencode/
│   ├── agents/rlm.md            # OpenCode agent
│   └── commands/                # OpenCode commands
├── src/
│   ├── cli.py                   # RLM CLI tool
│   └── stats.py                 # Token savings dashboard
└── tests/
```

### Key files

| File | What it does | Language |
|------|-------------|----------|
| `skills/rlm/SKILL.md` | Main skill — teaches Claude the RLM pattern | Markdown |
| `skills/stats/SKILL.md` | Stats dashboard skill | Markdown |
| `hooks/pretooluse-rlm.mjs` | Detects large files, suggests RLM, logs events | JavaScript |
| `src/stats.py` | Token savings dashboard and event logging | Python |
| `src/cli.py` | CLI for sub-LLM decomposition on massive data | Python |

### After making changes

Restart Claude Code to pick up plugin changes. There's no hot-reload — you need to exit and re-run:

```bash
claude --plugin-dir ./
```

## Submitting a PR

### Guidelines

1. **Test your changes** — run `pytest tests/ -v` and verify manually in a Claude Code session
2. **Keep PRs focused** — one feature or fix per PR
3. **Use conventional commits**:
   - `feat:` new features
   - `fix:` bug fixes
   - `docs:` documentation changes
   - `chore:` maintenance, version bumps
   - `ci:` CI/CD changes
4. **Update tests** if you change plugin structure, hooks, or manifest fields
5. **Don't break the hook** — the PreToolUse hook must read from stdin and exit cleanly even on errors

### PR checklist

- [ ] Tests pass (`pytest tests/ -v`)
- [ ] Plugin loads without errors (`claude --plugin-dir ./`)
- [ ] Hook fires correctly on large files
- [ ] No path traversal (`../`) in manifest references
- [ ] Hook commands use `${CLAUDE_PLUGIN_ROOT}` for portability

## Filing Issues

### Bug reports

Include:
- Your Claude Code version (`claude --version`)
- The exact prompt/command you ran
- Error output or unexpected behavior
- OS and shell environment

### Feature requests

Describe what you want and why. If you have a rough idea of how to implement it, share that too.

## Release Process

Releases are automated via GitHub Actions:

1. Update version in `.claude-plugin/plugin.json`
2. Commit and tag: `git tag v0.x.x`
3. Push: `git push origin master v0.x.x`
4. The release workflow generates a changelog and creates a GitHub Release

## Code of Conduct

Be kind. Be constructive. We're all here to build something useful.
