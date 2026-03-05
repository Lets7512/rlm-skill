#!/usr/bin/env node
/**
 * PreToolUse hook: detects large file/output scenarios and blocks WebFetch.
 *
 * Fires before Read/Bash/WebFetch tool calls.
 * - Read/Bash: suggests RLM pattern for large files (additionalContext)
 * - WebFetch: blocks entirely and suggests Python fetch instead
 *
 * Node 12+ compatible: no optional chaining, no nullish coalescing,
 * no top-level await, classic function syntax.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

var __filename = fileURLToPath(import.meta.url);
var __dirname = path.dirname(__filename);

var SIZE_THRESHOLDS = {
  SUGGEST_PATTERN_1: 500 * 1024,       // 500 KB
  SUGGEST_PATTERN_2: 5 * 1024 * 1024,  // 5 MB
  SUGGEST_PATTERN_3: 50 * 1024 * 1024, // 50 MB
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
];

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + "MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + "KB";
  return bytes + "B";
}

function suggestPattern(sizeBytes) {
  if (sizeBytes >= SIZE_THRESHOLDS.SUGGEST_PATTERN_3) return 3;
  if (sizeBytes >= SIZE_THRESHOLDS.SUGGEST_PATTERN_2) return 2;
  if (sizeBytes >= SIZE_THRESHOLDS.SUGGEST_PATTERN_1) return 1;
  return 0;
}

function logEvent(filePath, sizeBytes, pattern) {
  try {
    var statsDir = path.join(os.homedir(), ".rlm", "stats");
    fs.mkdirSync(statsDir, { recursive: true });
    var entry = JSON.stringify({
      ts: new Date().toISOString(),
      event: "large_file_detected",
      file: filePath,
      size_bytes: sizeBytes,
      pattern: pattern,
    });
    fs.appendFileSync(path.join(statsDir, "events.jsonl"), entry + "\n");
  } catch (e) {
    // Stats logging is best-effort
  }
}

function patternAdvice(pattern, sizeStr) {
  switch (pattern) {
    case 1:
      return "File is " + sizeStr + ". Use RLM Pattern 1: write code to process it in a sandbox/REPL and only print a summary. Don't read the whole file into context.";
    case 2:
      return "File is " + sizeStr + ". Use RLM Pattern 2: chain multiple code executions to survey, slice, and deep-dive. Don't read it all at once.";
    case 3:
      return "File is " + sizeStr + ". Use RLM Pattern 3: rlm-cli with sub-LLM decomposition for this massive dataset. Run: rlm-cli query \"your question\" --file <path>";
    default:
      return null;
  }
}

function getPluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, "..");
}

function findPython() {
  // Try candidates in order of preference
  var candidates = ["python3", "python"];
  // Also check common install paths on Linux/macOS
  var extraPaths = [
    "/usr/bin/python3",
    "/usr/local/bin/python3",
    "/opt/homebrew/bin/python3",
  ];

  for (var i = 0; i < candidates.length; i++) {
    try {
      execSync(candidates[i] + ' -c "print(1)"', { stdio: "pipe", timeout: 3000 });
      return candidates[i];
    } catch (e) {
      // broken or missing, try next
    }
  }

  for (var j = 0; j < extraPaths.length; j++) {
    try {
      if (fs.existsSync(extraPaths[j])) {
        execSync(extraPaths[j] + ' -c "print(1)"', { stdio: "pipe", timeout: 3000 });
        return extraPaths[j];
      }
    } catch (e) {
      // broken or missing
    }
  }

  // Also scan /opt for Python installations
  try {
    var optEntries = fs.readdirSync("/opt");
    for (var k = 0; k < optEntries.length; k++) {
      if (/^[Pp]ython/.test(optEntries[k])) {
        var pyBin = "/opt/" + optEntries[k] + "/python";
        if (fs.existsSync(pyBin)) {
          try {
            execSync(pyBin + ' -c "print(1)"', { stdio: "pipe", timeout: 3000 });
            return pyBin;
          } catch (e) {
            // broken
          }
        }
        var pyBin3 = "/opt/" + optEntries[k] + "/bin/python3";
        if (fs.existsSync(pyBin3)) {
          try {
            execSync(pyBin3 + ' -c "print(1)"', { stdio: "pipe", timeout: 3000 });
            return pyBin3;
          } catch (e) {
            // broken
          }
        }
      }
    }
  } catch (e) {
    // /opt doesn't exist or not readable
  }

  return "python3"; // fallback, hope for the best
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

    logEvent(filePath, stat.size, pattern);
    var advice = patternAdvice(pattern, formatSize(stat.size));
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: "[RLM] " + advice,
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

  var isLargeOutputCmd = LARGE_OUTPUT_COMMANDS.some(function (re) {
    return re.test(command);
  });
  if (!isLargeOutputCmd) return null;

  // Check if the command targets a specific file we can stat
  var fileMatch = command.match(/(?:cat|head|tail)\s+(?:-[^\s]+\s+)*["']?([^"'\s|>]+)/);
  if (fileMatch) {
    try {
      var cwd = input.cwd || ".";
      var resolved = path.resolve(cwd, fileMatch[1]);
      var stat = fs.statSync(resolved);
      var pattern = suggestPattern(stat.size);
      if (pattern > 0) {
        logEvent(fileMatch[1], stat.size, pattern);
        var advice = patternAdvice(pattern, formatSize(stat.size));
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            additionalContext: "[RLM] " + advice,
          },
        };
      }
    } catch (e) {
      // File doesn't exist or can't stat - fall through
    }
  }

  // Generic large-output warning for commands like find/grep -r/curl
  if (/\b(find|grep\s+-r|rg\s+|curl|wget)\b/.test(command)) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext:
          "[RLM] This command may produce large output. Consider writing code to process the data in a sandbox and only print a summary to context.",
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

  // Stats logging happens in fetch.py (it knows the actual size)

  var reason = [
    "[RLM] WebFetch dumps raw content into context — blocked.",
    "",
    "Use Python fetch instead (data stays in a file, only metadata enters context):",
    "",
    '  ' + pythonBin + ' "' + fetchScript + '" "' + url + '"',
    "",
    "Then process the downloaded file:",
    "",
    '  ' + pythonBin + ' -c "',
    "  with open('<output_path>') as f:",
    "      data = f.read()",
    "  # extract what you need",
    "  print(summary)",
    '  "',
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
    } catch (e) {
      // Silent failure
    }
    process.exit(0);
  });
}

main();
