"""Integration tests for rlm-skill plugin structure and marketplace readiness."""

import json
import os
from pathlib import Path

PLUGIN_ROOT = Path(__file__).parent.parent


def test_plugin_json_exists():
    manifest = PLUGIN_ROOT / ".claude-plugin" / "plugin.json"
    assert manifest.exists(), "plugin.json must exist at .claude-plugin/plugin.json"


def test_plugin_json_valid():
    manifest = PLUGIN_ROOT / ".claude-plugin" / "plugin.json"
    data = json.loads(manifest.read_text())
    assert "name" in data, "plugin.json must have a 'name' field"
    assert data["name"] == "rlm"


def test_plugin_json_marketplace_fields():
    manifest = PLUGIN_ROOT / ".claude-plugin" / "plugin.json"
    data = json.loads(manifest.read_text())
    required_for_marketplace = ["name", "version", "description", "author", "license"]
    for field in required_for_marketplace:
        assert field in data, f"plugin.json missing marketplace field: {field}"
    assert "name" in data["author"], "author must have a 'name' field"


def test_plugin_hooks_auto_discovered():
    """hooks/hooks.json should NOT be in manifest (auto-discovered by convention)."""
    manifest = PLUGIN_ROOT / ".claude-plugin" / "plugin.json"
    data = json.loads(manifest.read_text())
    assert "hooks" not in data, "hooks/hooks.json is auto-discovered; do not declare in manifest"
    hooks_path = PLUGIN_ROOT / "hooks" / "hooks.json"
    assert hooks_path.exists(), "hooks/hooks.json must exist for auto-discovery"


def test_hooks_json_valid():
    hooks_file = PLUGIN_ROOT / "hooks" / "hooks.json"
    assert hooks_file.exists(), "hooks/hooks.json must exist"
    data = json.loads(hooks_file.read_text())
    assert "hooks" in data, "hooks.json must have a 'hooks' key"
    assert "PreToolUse" in data["hooks"], "Must have PreToolUse hooks"
    for entry in data["hooks"]["PreToolUse"]:
        assert "hooks" in entry, "Each hook entry must have a 'hooks' array"
        for hook in entry["hooks"]:
            assert "type" in hook, "Each hook handler must have a 'type'"
            assert "command" in hook, "Each command hook must have a 'command'"


def test_hook_script_exists():
    script = PLUGIN_ROOT / "hooks" / "pretooluse-rlm.mjs"
    assert script.exists(), "Hook script pretooluse-rlm.mjs must exist"
    content = script.read_text()
    assert "process.stdin" in content, "Hook must read from stdin"
    assert "PreToolUse" in content, "Hook must reference PreToolUse event"


def test_skill_md_exists():
    skill = PLUGIN_ROOT / "skills" / "rlm" / "SKILL.md"
    assert skill.exists(), "SKILL.md must exist at skills/rlm/SKILL.md"


def test_skill_md_frontmatter():
    skill = PLUGIN_ROOT / "skills" / "rlm" / "SKILL.md"
    content = skill.read_text()
    assert content.startswith("---"), "SKILL.md must have YAML frontmatter"
    # Check frontmatter has name and description
    end = content.index("---", 3)
    frontmatter = content[3:end]
    assert "name:" in frontmatter, "SKILL.md frontmatter must have 'name'"
    assert "description:" in frontmatter, "SKILL.md frontmatter must have 'description'"


def test_skill_has_core_sections():
    skill = PLUGIN_ROOT / "skills" / "rlm" / "SKILL.md"
    content = skill.read_text()
    assert "When to Use" in content, "SKILL.md must document when to use RLM"
    assert "python3" in content or "python" in content, "SKILL.md must show code execution examples"
    assert "rlm-cli" in content, "SKILL.md must reference rlm-cli for massive data"


def test_cli_module_exists():
    cli = PLUGIN_ROOT / "src" / "cli.py"
    assert cli.exists(), "CLI module must exist at src/cli.py"
    content = cli.read_text()
    assert "def main" in content, "CLI must have main() entry point"
    assert "query" in content, "CLI must have query subcommand"
    assert "repl" in content, "CLI must have repl subcommand"


def test_no_path_traversal():
    """Ensure no files reference paths outside the plugin root."""
    manifest = PLUGIN_ROOT / ".claude-plugin" / "plugin.json"
    data = json.loads(manifest.read_text())
    for key in ["hooks", "skills", "agents", "mcpServers"]:
        if key in data and isinstance(data[key], str):
            assert not data[key].startswith(".."), f"{key} must not traverse outside plugin root"
            assert not data[key].startswith("/"), f"{key} must use relative paths"


def test_hooks_use_plugin_root_var():
    """Ensure hook commands use ${CLAUDE_PLUGIN_ROOT} for portability."""
    hooks_file = PLUGIN_ROOT / "hooks" / "hooks.json"
    data = json.loads(hooks_file.read_text())
    for event, entries in data["hooks"].items():
        for entry in entries:
            for hook in entry.get("hooks", []):
                if "command" in hook:
                    assert "${CLAUDE_PLUGIN_ROOT}" in hook["command"], \
                        f"Hook command must use ${{CLAUDE_PLUGIN_ROOT}} for portability: {hook['command']}"


def test_opencode_store_exists():
    store = PLUGIN_ROOT / ".opencode" / "plugins" / "rlm-store.ts"
    assert store.exists(), "rlm-store.ts must exist for FTS5 knowledge base"
    content = store.read_text()
    assert "ContentStore" in content, "Must export ContentStore class"
    assert "fts5" in content.lower(), "Must use FTS5"


def test_opencode_executor_exists():
    executor = PLUGIN_ROOT / ".opencode" / "plugins" / "rlm-executor.ts"
    assert executor.exists(), "rlm-executor.ts must exist for sandbox execution"
    content = executor.read_text()
    assert "execute" in content, "Must export execute function"
    assert "execSync" in content, "Must use child_process execSync"


def test_opencode_interceptor_no_throws():
    interceptor = PLUGIN_ROOT / ".opencode" / "plugins" / "rlm-interceptor.ts"
    assert interceptor.exists(), "rlm-interceptor.ts must exist"
    content = interceptor.read_text()
    assert 'throw new Error("[RLM]' not in content, \
        "Interceptor must NOT throw errors — use output.args rewriting instead"


def test_opencode_interceptor_has_tools():
    interceptor = PLUGIN_ROOT / ".opencode" / "plugins" / "rlm-interceptor.ts"
    content = interceptor.read_text()
    assert "rlm_execute" in content, "Must register rlm_execute tool"
    assert "rlm_search" in content, "Must register rlm_search tool"
    assert "rlm_index" in content, "Must register rlm_index tool"


def test_mcp_server_exists():
    server = PLUGIN_ROOT / "mcp" / "server.mjs"
    assert server.exists(), "MCP server must exist at mcp/server.mjs"
    content = server.read_text()
    assert "rlm_execute" in content, "MCP server must provide rlm_execute tool"
    assert "rlm_search" in content, "MCP server must provide rlm_search tool"
    assert "rlm_index" in content, "MCP server must provide rlm_index tool"


def test_mcp_store_exists():
    store = PLUGIN_ROOT / "mcp" / "store.mjs"
    assert store.exists(), "FTS5 store must exist at mcp/store.mjs"
    content = store.read_text()
    assert "ContentStore" in content, "Must export ContentStore class"
    assert "fts5" in content.lower(), "Must use FTS5"


def test_plugin_json_has_mcp():
    manifest = PLUGIN_ROOT / ".claude-plugin" / "plugin.json"
    data = json.loads(manifest.read_text())
    assert "mcpServers" in data, "plugin.json must declare mcpServers"
    assert "rlm" in data["mcpServers"], "Must have 'rlm' MCP server"


def test_hook_no_throws():
    hook = PLUGIN_ROOT / "hooks" / "pretooluse-rlm.mjs"
    content = hook.read_text()
    assert "updatedInput" in content, "Hook must use updatedInput for silent rewriting"


def test_opencode_package_has_sqlite():
    pkg = PLUGIN_ROOT / ".opencode" / "package.json"
    data = json.loads(pkg.read_text())
    assert "better-sqlite3" in data.get("dependencies", {}), \
        "package.json must include better-sqlite3"


def test_readme_exists():
    readme = PLUGIN_ROOT / "README.md"
    assert readme.exists(), "README.md must exist"
    content = readme.read_text()
    assert "RLM" in content, "README must mention RLM"


def test_license_exists():
    license_file = PLUGIN_ROOT / "LICENSE"
    assert license_file.exists(), "LICENSE file must exist"


if __name__ == "__main__":
    import sys
    failures = []
    tests = [v for k, v in globals().items() if k.startswith("test_") and callable(v)]
    for test in tests:
        try:
            test()
            print(f"  PASS  {test.__name__}")
        except AssertionError as e:
            print(f"  FAIL  {test.__name__}: {e}")
            failures.append(test.__name__)
        except Exception as e:
            print(f"  ERROR {test.__name__}: {e}")
            failures.append(test.__name__)
    print(f"\n{len(tests) - len(failures)}/{len(tests)} passed")
    sys.exit(1 if failures else 0)
