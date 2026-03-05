#!/usr/bin/env node
/**
 * PreToolUse hook: detects large file/output scenarios and suggests RLM pattern.
 *
 * Fires before Read/Bash tool calls. If the target looks like a large-data
 * operation, injects context suggesting the appropriate RLM pattern instead
 * of stuffing raw data into the context window.
 */

import { appendFileSync, mkdirSync, statSync } from "fs";
import { resolve, join } from "path";
import { homedir } from "os";

const SIZE_THRESHOLDS = {
  SUGGEST_PATTERN_1: 500 * 1024,   // 500 KB  -> suggest Pattern 1 (single-pass execute)
  SUGGEST_PATTERN_2: 5 * 1024 * 1024, // 5 MB -> suggest Pattern 2 (recursive decomposition)
  SUGGEST_PATTERN_3: 50 * 1024 * 1024, // 50 MB -> suggest Pattern 3 (RLM CLI)
};

const LARGE_OUTPUT_COMMANDS = [
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
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

function suggestPattern(sizeBytes) {
  if (sizeBytes >= SIZE_THRESHOLDS.SUGGEST_PATTERN_3) return 3;
  if (sizeBytes >= SIZE_THRESHOLDS.SUGGEST_PATTERN_2) return 2;
  if (sizeBytes >= SIZE_THRESHOLDS.SUGGEST_PATTERN_1) return 1;
  return 0;
}

function logEvent(filePath, sizeBytes, pattern) {
  try {
    const statsDir = join(homedir(), ".rlm", "stats");
    mkdirSync(statsDir, { recursive: true });
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      event: "large_file_detected",
      file: filePath,
      size_bytes: sizeBytes,
      pattern,
    });
    appendFileSync(join(statsDir, "events.jsonl"), entry + "\n");
  } catch {
    // Stats logging is best-effort
  }
}

function patternAdvice(pattern, sizeStr) {
  switch (pattern) {
    case 1:
      return `File is ${sizeStr}. Use RLM Pattern 1: write code to process it in a sandbox/REPL and only print a summary. Don't read the whole file into context.`;
    case 2:
      return `File is ${sizeStr}. Use RLM Pattern 2: chain multiple code executions to survey, slice, and deep-dive. Don't read it all at once.`;
    case 3:
      return `File is ${sizeStr}. Use RLM Pattern 3: rlm-cli with sub-LLM decomposition for this massive dataset. Run: rlm-cli query "your question" --file <path>`;
    default:
      return null;
  }
}

function handleRead(input) {
  const filePath = input.tool_input?.file_path;
  if (!filePath) return null;

  try {
    const resolved = resolve(input.cwd || ".", filePath);
    const stat = statSync(resolved);
    const pattern = suggestPattern(stat.size);
    if (pattern === 0) return null;

    logEvent(filePath, stat.size, pattern);
    const advice = patternAdvice(pattern, formatSize(stat.size));
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: `[RLM] ${advice}`,
      },
    };
  } catch {
    return null;
  }
}

function handleBash(input) {
  const command = input.tool_input?.command;
  if (!command) return null;

  const isLargeOutputCmd = LARGE_OUTPUT_COMMANDS.some((re) => re.test(command));
  if (!isLargeOutputCmd) return null;

  // Check if the command targets a specific file we can stat
  const fileMatch = command.match(/(?:cat|head|tail)\s+(?:-[^\s]+\s+)*["']?([^"'\s|>]+)/);
  if (fileMatch) {
    try {
      const resolved = resolve(input.cwd || ".", fileMatch[1]);
      const stat = statSync(resolved);
      const pattern = suggestPattern(stat.size);
      if (pattern > 0) {
        logEvent(fileMatch[1], stat.size, pattern);
        const advice = patternAdvice(pattern, formatSize(stat.size));
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            additionalContext: `[RLM] ${advice}`,
          },
        };
      }
    } catch {
      // File doesn't exist or can't stat — fall through
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

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;

  const input = JSON.parse(raw);
  const toolName = input.tool_name;

  let result = null;
  if (toolName === "Read") {
    result = handleRead(input);
  } else if (toolName === "Bash") {
    result = handleBash(input);
  }

  if (result) {
    process.stdout.write(JSON.stringify(result));
  }
  process.exit(0);
}

main().catch(() => process.exit(0));
