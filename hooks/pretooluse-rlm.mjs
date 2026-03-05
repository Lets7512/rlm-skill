#!/usr/bin/env node
/**
 * PreToolUse hook v2: silently rewrites large file reads into metadata scripts
 * and redirects WebFetch to python download.
 *
 * Fires before Read/Bash/WebFetch tool calls.
 * - Read: rewrites to Bash with python metadata script (updatedInput)
 * - Bash: adds advisory context for large-output commands (additionalContext)
 * - WebFetch: blocks and suggests python fetch (decision: block)
 *
 * Node 12+ compatible: no optional chaining, no nullish coalescing.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

var __filename = fileURLToPath(import.meta.url);
var __dirname = path.dirname(__filename);

var SIZE_THRESHOLDS = {
  SINGLE_PASS: 5 * 1024,
  FULL_PROTOCOL: 500 * 1024,
  RLM_CLI: 50 * 1024 * 1024,
};

var LARGE_OUTPUT_COMMANDS = [
  /\bcat\b/,
  /\bhead\s+-n\s+\d{4,}/,
  /\btail\s+-n\s+\d{4,}/,
  /\bfind\s+/,
  /\bgrep\s+-r/,
  /\brg\s+/,
  /\bwc\s+-l/,
  /\bcurl\b/,
  /\bwget\b/,
  /\bGet-Content\b/i,
  /\btype\s+/,
  /\bSelect-String\b/i,
  /\bGet-ChildItem\b/i,
  /\bInvoke-WebRequest\b/i,
  /\bInvoke-RestMethod\b/i,
  /\biwr\b/i,
];

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + "MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + "KB";
  return bytes + "B";
}

function suggestPattern(sizeBytes) {
  if (sizeBytes >= SIZE_THRESHOLDS.RLM_CLI) return 3;
  if (sizeBytes >= SIZE_THRESHOLDS.FULL_PROTOCOL) return 2;
  if (sizeBytes >= SIZE_THRESHOLDS.SINGLE_PASS) return 1;
  return 0;
}

function logEvent(event, details) {
  try {
    var statsDir = path.join(os.homedir(), ".rlm", "stats");
    fs.mkdirSync(statsDir, { recursive: true });
    var entry = JSON.stringify(Object.assign({ ts: new Date().toISOString(), event: event }, details));
    fs.appendFileSync(path.join(statsDir, "events.jsonl"), entry + "\n");
  } catch (e) {}
}

function buildMetadataScript(filePath, sizeStr, pattern) {
  var escaped = filePath.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  var protocolHint = pattern >= 2
    ? "Use FULL RLM Protocol (6 steps): METADATA->PEEK->SEARCH->ANALYZE->SYNTHESIZE->SUBMIT. Use rlm_execute, rlm_index, rlm_search MCP tools."
    : "Use RLM Protocol steps 1-3: METADATA->PEEK->SEARCH. Use rlm_execute MCP tool or python -c via Bash.";

  return "python -c \"\nimport os\nf = '" + escaped + "'\nsize = os.path.getsize(f)\nwith open(f, 'rb') as fh:\n    head = fh.read(500).decode('utf-8', errors='replace')\n    fh.seek(max(0, size - 500))\n    tail = fh.read(500).decode('utf-8', errors='replace')\nlines = sum(1 for _ in open(f, 'rb'))\next = os.path.splitext(f)[1]\nprint(f'[RLM METADATA] File: {os.path.basename(f)}')\nprint(f'Size: {size:,} bytes (" + sizeStr + ") | Lines: {lines:,} | Type: {ext}')\nprint(f'--- HEAD (first 500 chars) ---')\nprint(head)\nprint(f'--- TAIL (last 500 chars) ---')\nprint(tail)\nprint()\nprint('" + protocolHint + "')\nprint('Do NOT read the full file into context.')\n\"";
}

function getPluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, "..");
}

function findPython() {
  var candidates = ["python3", "python"];
  var extraPaths = [
    "/usr/bin/python3",
    "/usr/local/bin/python3",
    "/opt/homebrew/bin/python3",
  ];

  for (var i = 0; i < candidates.length; i++) {
    try {
      execSync(candidates[i] + ' -c "print(1)"', { stdio: "pipe", timeout: 3000 });
      return candidates[i];
    } catch (e) {}
  }

  for (var j = 0; j < extraPaths.length; j++) {
    try {
      if (fs.existsSync(extraPaths[j])) {
        execSync(extraPaths[j] + ' -c "print(1)"', { stdio: "pipe", timeout: 3000 });
        return extraPaths[j];
      }
    } catch (e) {}
  }

  try {
    var optEntries = fs.readdirSync("/opt");
    for (var k = 0; k < optEntries.length; k++) {
      if (/^[Pp]ython/.test(optEntries[k])) {
        var pyBin = "/opt/" + optEntries[k] + "/python";
        if (fs.existsSync(pyBin)) {
          try { execSync(pyBin + ' -c "print(1)"', { stdio: "pipe", timeout: 3000 }); return pyBin; } catch (e) {}
        }
        var pyBin3 = "/opt/" + optEntries[k] + "/bin/python3";
        if (fs.existsSync(pyBin3)) {
          try { execSync(pyBin3 + ' -c "print(1)"', { stdio: "pipe", timeout: 3000 }); return pyBin3; } catch (e) {}
        }
      }
    }
  } catch (e) {}

  return "python3";
}

function handleRead(input) {
  var toolInput = input.tool_input || {};
  var filePath = toolInput.file_path;
  if (!filePath) return null;

  try {
    var cwd = input.cwd || ".";
    var resolved = path.resolve(cwd, filePath);
    var stat = fs.statSync(resolved);
    var pattern = suggestPattern(stat.size);
    if (pattern === 0) return null;

    logEvent("rlm_intercept_rewrite", {
      file: filePath,
      size_bytes: stat.size,
      pattern: pattern,
      original_tool: "Read",
    });

    // Silently rewrite Read -> Bash with metadata script
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: {
          tool_name: "Bash",
          tool_input: {
            command: buildMetadataScript(resolved, formatSize(stat.size), pattern),
            description: "RLM: analyze " + path.basename(filePath) + " metadata (" + formatSize(stat.size) + ")",
          },
        },
      },
    };
  } catch (e) {
    return null;
  }
}

function handleBash(input) {
  var toolInput = input.tool_input || {};
  var command = toolInput.command;
  if (!command) return null;

  var cwd = input.cwd || ".";

  // Track python commands that open() large files
  if (/\bpython[23]?\b/.test(command)) {
    var openMatches = command.match(/open\s*\(\s*['"]([^'"]+)['"]/g);
    if (openMatches) {
      for (var i = 0; i < openMatches.length; i++) {
        var pathMatch = openMatches[i].match(/open\s*\(\s*['"]([^'"]+)['"]/);
        if (pathMatch) {
          try {
            var resolved = path.resolve(cwd, pathMatch[1]);
            var stat = fs.statSync(resolved);
            var pattern = suggestPattern(stat.size);
            if (pattern > 0) {
              logEvent("large_file_detected", { file: pathMatch[1], size_bytes: stat.size, pattern: pattern });
            }
          } catch (e) {}
        }
      }
    }
  }

  var isLargeOutputCmd = LARGE_OUTPUT_COMMANDS.some(function (re) { return re.test(command); });
  if (!isLargeOutputCmd) return null;

  // Check if targeting a specific file
  var fileMatch = command.match(/(?:cat|head|tail|type|Get-Content)\s+(?:-[^\s]+\s+)*["']?([^"'\s|>]+)/i);
  if (fileMatch) {
    try {
      var resolvedFile = path.resolve(cwd, fileMatch[1]);
      var fileStat = fs.statSync(resolvedFile);
      var filePattern = suggestPattern(fileStat.size);
      if (filePattern > 0) {
        logEvent("rlm_intercept_rewrite", {
          file: fileMatch[1],
          size_bytes: fileStat.size,
          pattern: filePattern,
          original_tool: "Bash",
        });

        // Rewrite to metadata script
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            updatedInput: {
              tool_name: "Bash",
              tool_input: {
                command: buildMetadataScript(resolvedFile, formatSize(fileStat.size), filePattern),
                description: "RLM: analyze " + path.basename(fileMatch[1]) + " metadata (" + formatSize(fileStat.size) + ")",
              },
            },
          },
        };
      }
    } catch (e) {}
  }

  // Advisory for generic large-output commands
  if (/\b(find|grep\s+-r|rg\s+|curl|wget|Get-ChildItem|Select-String|Invoke-WebRequest|Invoke-RestMethod|iwr)\b/i.test(command)) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext:
          "[RLM] This command may produce large output. Use rlm_execute MCP tool to run it in a sandbox, or write python -c code to process the data and only print a summary.",
      },
    };
  }

  return null;
}

function handleWebFetch(input) {
  var toolInput = input.tool_input || {};
  var url = toolInput.url || toolInput.URL || "";
  if (!url) return null;

  var pluginRoot = getPluginRoot();
  var fetchScript = path.join(pluginRoot, "src", "fetch.py").replace(/\\/g, "/");
  var pythonBin = findPython();

  logEvent("rlm_intercept_rewrite", { original_tool: "WebFetch", url: url.slice(0, 200) });

  var reason = [
    "[RLM] WebFetch dumps raw content into context — blocked.",
    "",
    "Use Python fetch instead (data stays in a file, only metadata enters context):",
    "",
    '  ' + pythonBin + ' "' + fetchScript + '" "' + url + '"',
    "",
    "Then use rlm_index to index the downloaded file, and rlm_search to query it.",
    "Or use rlm_execute to run python code that processes the file.",
  ].join("\n");

  return {
    decision: "block",
    reason: reason,
  };
}

function main() {
  var raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", function (chunk) {
    raw += chunk;
  });
  process.stdin.on("end", function () {
    try {
      var input = JSON.parse(raw);
      var toolName = input.tool_name;

      var result = null;
      if (toolName === "Read") {
        result = handleRead(input);
      } else if (toolName === "Bash") {
        result = handleBash(input);
      } else if (toolName === "WebFetch") {
        result = handleWebFetch(input);
      }

      if (result) {
        process.stdout.write(JSON.stringify(result));
      }
    } catch (e) {}
    process.exit(0);
  });
}

main();
