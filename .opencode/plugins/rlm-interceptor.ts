import type { Plugin } from "@opencode-ai/plugin"
import fs from "fs"
import path from "path"
import os from "os"

const SIZE_THRESHOLDS = {
  SINGLE_PASS: 5 * 1024,         // 5 KB — steps 1-3
  FULL_PROTOCOL: 500 * 1024,     // 500 KB — full 6-step protocol
  RLM_CLI: 50 * 1024 * 1024,     // 50 MB — rlm-cli
}

const LARGE_OUTPUT_COMMANDS = [
  // Unix
  /\bcat\b/,
  /\bhead\s+-n\s+\d{4,}/,
  /\btail\s+-n\s+\d{4,}/,
  /\bfind\s+/,
  /\bgrep\s+-r/,
  /\brg\s+/,
  /\bwc\s+-l/,
  /\bcurl\b/,
  /\bwget\b/,
  // PowerShell / Windows
  /\bGet-Content\b/i,
  /\btype\s+/,
  /\bSelect-String\b/i,
  /\bGet-ChildItem\b/i,
  /\bInvoke-WebRequest\b/i,
  /\bInvoke-RestMethod\b/i,
  /\biwr\b/i,
]

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + "MB"
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + "KB"
  return bytes + "B"
}

function suggestPattern(sizeBytes: number): number {
  if (sizeBytes >= SIZE_THRESHOLDS.RLM_CLI) return 3
  if (sizeBytes >= SIZE_THRESHOLDS.FULL_PROTOCOL) return 2
  if (sizeBytes >= SIZE_THRESHOLDS.SINGLE_PASS) return 1
  return 0
}

function logEvent(filePath: string, sizeBytes: number, pattern: number): void {
  try {
    const statsDir = path.join(os.homedir(), ".rlm", "stats")
    fs.mkdirSync(statsDir, { recursive: true })
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      event: "large_file_detected",
      file: filePath,
      size_bytes: sizeBytes,
      pattern: pattern,
    })
    fs.appendFileSync(path.join(statsDir, "events.jsonl"), entry + "\n")
  } catch (e) {
    // Stats logging is best-effort
  }
}

function patternAdvice(pattern: number, sizeStr: string, filePath: string): string {
  switch (pattern) {
    case 1:
      return `[RLM] File is ${sizeStr}. Use RLM Protocol steps 1-3: METADATA (assess type/size/preview) -> PEEK (sample head/tail/slices) -> SEARCH (targeted extraction). Write python -c scripts via Bash. Use glob for file discovery. WebFetch is blocked. Log each step via stats.log_event().`
    case 2:
      return `[RLM] File is ${sizeStr}. Use FULL RLM Protocol (6 steps): METADATA -> PEEK -> SEARCH -> ANALYZE (spawn up to 15 @explore sub-agents for parallel chunk analysis) -> SYNTHESIZE -> SUBMIT. Budget: 20 iterations, 15K chars/step, 15 sub-queries max. Use glob for file discovery. WebFetch is blocked. End with explicit SUBMIT block including confidence level. Log each step via stats.log_event().`
    case 3:
      return `[RLM] File is ${sizeStr}. Use FULL RLM Protocol + rlm-cli for sub-LLM decomposition: rlm-cli query "..." --file ${filePath} --stats. Also run 6-step protocol for overview. Use glob for file discovery. WebFetch is blocked. End with SUBMIT block. Log each step via stats.log_event().`
    default:
      return ""
  }
}

export const RLMInterceptor: Plugin = async (ctx) => {
  return {
    "tool.execute.before": async (input: any, output: any) => {
      // Intercept read tool — block large files
      if (input.tool === "read") {
        const filePath = output.args.filePath || output.args.file_path
        if (!filePath) return

        try {
          const resolved = path.resolve(filePath)
          const stat = fs.statSync(resolved)
          const pattern = suggestPattern(stat.size)
          if (pattern === 0) return

          logEvent(filePath, stat.size, pattern)
          const advice = patternAdvice(pattern, formatSize(stat.size), filePath)
          throw new Error(advice + "\n\nDo NOT read this file directly. Use python -c via bash to extract only what you need.")
        } catch (e: any) {
          if (e.message.startsWith("[RLM]")) throw e
          // File doesn't exist or can't stat — let it through
        }
      }

      // Intercept bash tool — warn on large-output commands, track python open()
      if (input.tool === "bash") {
        const command = output.args.command
        if (!command) return

        // Track python commands that open() large files
        if (/\bpython[23]?\b/.test(command)) {
          const openMatches = command.match(/open\s*\(\s*['"]([^'"]+)['"]/g)
          if (openMatches) {
            for (const match of openMatches) {
              const pathMatch = match.match(/open\s*\(\s*['"]([^'"]+)['"]/)
              if (pathMatch) {
                try {
                  const resolved = path.resolve(pathMatch[1])
                  const stat = fs.statSync(resolved)
                  const pattern = suggestPattern(stat.size)
                  if (pattern > 0) {
                    logEvent(pathMatch[1], stat.size, pattern)
                  }
                } catch (e) {
                  // file doesn't exist
                }
              }
            }
          }
        }

        // Check for large-output commands
        const isLargeOutputCmd = LARGE_OUTPUT_COMMANDS.some(re => re.test(command))
        if (!isLargeOutputCmd) return

        // Check if targeting a specific file
        const fileMatch = command.match(/(?:cat|head|tail|type|Get-Content)\s+(?:-[^\s]+\s+)*["']?([^"'\s|>]+)/i)
        if (fileMatch) {
          try {
            const resolved = path.resolve(fileMatch[1])
            const stat = fs.statSync(resolved)
            const pattern = suggestPattern(stat.size)
            if (pattern > 0) {
              logEvent(fileMatch[1], stat.size, pattern)
              const advice = patternAdvice(pattern, formatSize(stat.size), fileMatch[1])
              throw new Error(advice)
            }
          } catch (e: any) {
            if (e.message.startsWith("[RLM]")) throw e
          }
        }

        // Generic warning for find/grep/curl/PowerShell equivalents
        if (/\b(find|grep\s+-r|rg\s+|curl|wget|Get-ChildItem|Select-String|Invoke-WebRequest|Invoke-RestMethod|iwr)\b/i.test(command)) {
          throw new Error("[RLM] This command may produce large output. Write python -c code to process the data and only print a summary to context.")
        }
      }

      // Block webfetch tool
      if (input.tool === "webfetch" || input.tool === "web_fetch") {
        throw new Error("[RLM] WebFetch is blocked. Download via python -c using urllib/requests, save to a local file, then process through the RLM protocol.")
      }
    },
  }
}
