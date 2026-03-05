import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import fs from "fs"
import path from "path"
import os from "os"
import { ContentStore } from "./rlm-store"
import { execute, executeFile } from "./rlm-executor"
import http from "http"
import https from "https"

const SIZE_THRESHOLDS = {
  SINGLE_PASS: 5 * 1024,         // 5 KB — steps 1-3
  FULL_PROTOCOL: 500 * 1024,     // 500 KB — full 6-step protocol
  RLM_CLI: 50 * 1024 * 1024,     // 50 MB — rlm-cli
}

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

function logEvent(event: string, details: Record<string, any>): void {
  try {
    const statsDir = path.join(os.homedir(), ".rlm", "stats")
    fs.mkdirSync(statsDir, { recursive: true })
    const entry = JSON.stringify({ ts: new Date().toISOString(), event, ...details })
    fs.appendFileSync(path.join(statsDir, "events.jsonl"), entry + "\n")
  } catch {}
}

function debugLog(msg: string): void {
  try {
    const debugDir = path.join(os.homedir(), ".rlm", "debug")
    fs.mkdirSync(debugDir, { recursive: true })
    fs.appendFileSync(path.join(debugDir, "interceptor.log"), `${new Date().toISOString()} ${msg}\n`)
  } catch {}
}

function buildMetadataScript(filePath: string, sizeStr: string, pattern: number): string {
  const escaped = filePath.replace(/\\/g, "\\\\").replace(/'/g, "\\'")
  const protocolHint = pattern >= 2
    ? "Use FULL RLM Protocol (6 steps): METADATA->PEEK->SEARCH->ANALYZE->SYNTHESIZE->SUBMIT"
    : "Use RLM Protocol steps 1-3: METADATA->PEEK->SEARCH"

  return `python -c "
import os, json
f = '${escaped}'
size = os.path.getsize(f)
with open(f, 'rb') as fh:
    head = fh.read(500).decode('utf-8', errors='replace')
    fh.seek(max(0, size - 500))
    tail = fh.read(500).decode('utf-8', errors='replace')
lines = sum(1 for _ in open(f, 'rb'))
ext = os.path.splitext(f)[1]
print(f'[RLM METADATA] File: {os.path.basename(f)}')
print(f'Size: {size:,} bytes (${sizeStr}) | Lines: {lines:,} | Type: {ext}')
print(f'--- HEAD (first 500 chars) ---')
print(head)
print(f'--- TAIL (last 500 chars) ---')
print(tail)
print()
print('${protocolHint}')
print('Use rlm_execute tool to run analysis code, rlm_index to index content, rlm_search to query indexed content.')
print('Or write python -c scripts via Bash. Do NOT read the full file into context.')
"`
}

let store: ContentStore | null = null

function getStore(): ContentStore {
  if (!store) store = new ContentStore()
  return store
}

function fetchUrl(url: string): Promise<{ body: string; contentType: string; statusCode: number }> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http
    mod.get(url, { headers: { "User-Agent": "RLM-Skill/0.4" } }, (res: any) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve, reject)
      }
      const chunks: Buffer[] = []
      res.on("data", (c: Buffer) => chunks.push(c))
      res.on("end", () => {
        resolve({
          body: Buffer.concat(chunks).toString("utf-8"),
          contentType: res.headers["content-type"] || "",
          statusCode: res.statusCode,
        })
      })
      res.on("error", reject)
    }).on("error", reject)
  })
}

function htmlToText(html: string): string {
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
  text = text.replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, "\n## $1\n")
  text = text.replace(/<li[^>]*>(.*?)<\/li>/gi, "- $1\n")
  text = text.replace(/<br\s*\/?>/gi, "\n")
  text = text.replace(/<p[^>]*>(.*?)<\/p>/gi, "\n$1\n")
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "\n```\n$1\n```\n")
  text = text.replace(/<code[^>]*>(.*?)<\/code>/gi, "`$1`")
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "[$2]($1)")
  text = text.replace(/<[^>]+>/g, "")
  text = text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
  text = text.replace(/\n{3,}/g, "\n\n").trim()
  return text
}

export const RLMInterceptor: Plugin = async (ctx) => {
  debugLog("PLUGIN LOADED v2")

  return {
    "tool.execute.before": async (input: any, output: any) => {
      debugLog(`TOOL: ${input.tool} ARGS: ${JSON.stringify(output.args).slice(0, 200)}`)

      const toolLower = (input.tool || "").toLowerCase()

      // Intercept read tool — rewrite to bash metadata script
      if (toolLower === "read" || toolLower === "file_read" || toolLower === "readfile") {
        const filePath = output.args.filePath || output.args.file_path
        if (!filePath) return

        try {
          const resolved = path.resolve(filePath)
          const stat = fs.statSync(resolved)
          const pattern = suggestPattern(stat.size)
          if (pattern === 0) return

          logEvent("rlm_intercept_rewrite", {
            file: filePath,
            size_bytes: stat.size,
            pattern,
            original_tool: "read",
          })

          // Rewrite: change tool to bash and replace args with metadata script
          input.tool = "bash"
          output.args = {
            command: buildMetadataScript(resolved, formatSize(stat.size), pattern),
            description: `RLM: analyze ${path.basename(filePath)} metadata (${formatSize(stat.size)})`,
          }
          debugLog(`REWRITE read -> bash for ${filePath} (${formatSize(stat.size)})`)
        } catch (e: any) {
          // File doesn't exist or can't stat — let it through
        }
      }

      // Intercept bash tool — wrap large-output commands
      if (toolLower === "bash" || toolLower === "shell" || toolLower === "execute") {
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
                    logEvent("large_file_detected", {
                      file: pathMatch[1],
                      size_bytes: stat.size,
                      pattern,
                    })
                  }
                } catch {}
              }
            }
          }
        }

        // Check for large-output commands targeting specific files
        const isLargeOutputCmd = LARGE_OUTPUT_COMMANDS.some((re) => re.test(command))
        if (!isLargeOutputCmd) return

        const fileMatch = command.match(
          /(?:cat|head|tail|type|Get-Content)\s+(?:-[^\s]+\s+)*["']?([^"'\s|>]+)/i
        )
        if (fileMatch) {
          try {
            const resolved = path.resolve(fileMatch[1])
            const stat = fs.statSync(resolved)
            const pattern = suggestPattern(stat.size)
            if (pattern > 0) {
              logEvent("rlm_intercept_rewrite", {
                file: fileMatch[1],
                size_bytes: stat.size,
                pattern,
                original_tool: "bash",
                original_command: command.slice(0, 100),
              })

              // Rewrite command to metadata script
              output.args.command = buildMetadataScript(resolved, formatSize(stat.size), pattern)
              output.args.description = `RLM: analyze ${path.basename(fileMatch[1])} metadata (${formatSize(stat.size)})`
              debugLog(`REWRITE bash cmd for ${fileMatch[1]} (${formatSize(stat.size)})`)
              return
            }
          } catch {}
        }

        // Wrap generic large-output commands with a summary wrapper
        if (
          /\b(find|grep\s+-r|rg\s+|curl|wget|Get-ChildItem|Select-String|Invoke-WebRequest|Invoke-RestMethod|iwr)\b/i.test(
            command
          )
        ) {
          const escaped = command.replace(/'/g, "'\"'\"'")
          output.args.command = `bash -c '${escaped}' 2>&1 | head -50; echo ""; echo "[RLM] Output truncated to 50 lines. Use rlm_execute or python -c to process full output and print only a summary."`
          output.args.description = "RLM: truncated large-output command to 50 lines"
          debugLog(`REWRITE bash large-output cmd: ${command.slice(0, 80)}`)
        }
      }

      // Block webfetch tool — rewrite to python urllib download
      if (toolLower === "webfetch" || toolLower === "web_fetch" || toolLower === "fetch") {
        const url = output.args.url || output.args.URL || ""
        logEvent("rlm_intercept_rewrite", { original_tool: "webfetch", url: url.slice(0, 200) })

        input.tool = "bash"
        const escapedUrl = url.replace(/'/g, "'\"'\"'")
        output.args = {
          command: `python -c "
import urllib.request, os, hashlib, tempfile
url = '${escapedUrl}'
h = hashlib.md5(url.encode()).hexdigest()[:10]
out = os.path.join(tempfile.gettempdir(), f'rlm_fetch_{h}.html')
urllib.request.urlretrieve(url, out)
size = os.path.getsize(out)
with open(out) as f:
    preview = f.read(500)
print(f'[RLM] Downloaded to {out}')
print(f'Size: {size:,} bytes')
print(f'Preview (first 500 chars):')
print(preview)
print()
print('Use rlm_execute or python -c to process the downloaded file.')
print('Use rlm_index to index it for search.')
"`,
          description: `RLM: download ${url.slice(0, 60)} to temp file`,
        }
        debugLog(`REWRITE webfetch -> python urllib: ${url.slice(0, 80)}`)
      }
    },

    tool: {
      rlm_execute: tool({
        description:
          "Execute code in a sandboxed subprocess. Only stdout enters context. Use for processing large files, APIs, data analysis. Supports python, javascript, shell.",
        args: {
          language: tool.schema
            .enum(["python", "javascript", "shell"])
            .describe("Language runtime"),
          code: tool.schema.string().describe("Code to execute"),
        },
        async execute(args) {
          debugLog(`rlm_execute: ${args.language} (${args.code.length} chars)`)
          logEvent("rlm_execute", { language: args.language, code_length: args.code.length })

          const result = execute(args.language, args.code)
          let output = result.stdout
          if (result.stderr) output += "\n[stderr] " + result.stderr
          if (result.exitCode !== 0) output += `\n[exit code: ${result.exitCode}]`
          if (result.truncated) output += "\n[output truncated to 15K chars]"
          return output || "(no output)"
        },
      }),

      rlm_search: tool({
        description:
          "Search the RLM knowledge base. Returns smart snippets (windows around matching terms) ranked by BM25 with 3-layer fallback (porter/trigram/fuzzy). Batch all queries in one call.",
        args: {
          queries: tool.schema
            .array(tool.schema.string())
            .describe("Search queries (BM25 OR semantics, batch all in one call)"),
          source: tool.schema
            .string()
            .optional()
            .describe("Optional source filter (partial match)"),
        },
        async execute(args) {
          debugLog(`rlm_search: ${args.queries.join(", ")}`)
          logEvent("rlm_search", { queries: args.queries, source: args.source })

          const s = getStore()
          const results = s.searchWithSnippets(args.queries, args.source)
          if (results.length === 0) return "No results found."

          return results
            .map((r, i) => `[${i + 1}] (source: ${r.source})\n${r.text}`)
            .join("\n\n---\n\n")
        },
      }),

      rlm_index: tool({
        description:
          "Index content into the RLM knowledge base for later search via rlm_search. Use 'path' for files (reads server-side, no context cost). Use 'content' only for small inline text.",
        args: {
          source: tool.schema.string().describe("Label for this content (used in search filtering)"),
          path: tool.schema
            .string()
            .optional()
            .describe("File path to index (reads server-side)"),
          content: tool.schema
            .string()
            .optional()
            .describe("Inline text to index (prefer path for files)"),
        },
        async execute(args) {
          debugLog(`rlm_index: source=${args.source} path=${args.path || "inline"}`)
          logEvent("rlm_index", { source: args.source, path: args.path })

          const s = getStore()
          let count: number

          if (args.path) {
            count = s.indexFile(args.path, args.source)
          } else if (args.content) {
            count = s.index(args.source, args.content)
          } else {
            return "Error: provide either 'path' or 'content'"
          }

          const stats = s.stats()
          return `Indexed ${count} chunks as "${args.source}". KB now has ${stats.chunks} chunks from ${stats.sources} sources (${stats.dbSize}).`
        },
      }),

      rlm_batch_execute: tool({
        description:
          "Run multiple commands AND search multiple queries in ONE call. Each command runs in a sandbox (stdout-only). Search queries run against the knowledge base. Saves tool-call overhead.",
        args: {
          commands: tool.schema
            .array(
              tool.schema.object({
                language: tool.schema.enum(["python", "javascript", "shell"]),
                code: tool.schema.string(),
              })
            )
            .optional()
            .describe("Commands to execute in sandbox"),
          queries: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe("Search queries for knowledge base"),
          source: tool.schema
            .string()
            .optional()
            .describe("Source filter for search queries"),
        },
        async execute(args) {
          logEvent("rlm_batch_execute", {
            commands: (args.commands || []).length,
            queries: (args.queries || []).length,
          })

          const parts: string[] = []

          if (args.commands && args.commands.length > 0) {
            for (let i = 0; i < args.commands.length; i++) {
              const cmd = args.commands[i]
              const result = execute(cmd.language, cmd.code)
              let output = result.stdout
              if (result.stderr) output += "\n[stderr] " + result.stderr
              if (result.exitCode !== 0) output += `\n[exit code: ${result.exitCode}]`
              parts.push(`=== Command ${i + 1} (${cmd.language}) ===\n${output || "(no output)"}`)
            }
          }

          if (args.queries && args.queries.length > 0) {
            const s = getStore()
            const results = s.searchWithSnippets(args.queries, args.source)
            if (results.length === 0) {
              parts.push("=== Search ===\nNo results found.")
            } else {
              const text = results
                .map((r, idx) => `[${idx + 1}] (source: ${r.source})\n${r.text}`)
                .join("\n\n")
              parts.push("=== Search ===\n" + text)
            }
          }

          return parts.join("\n\n") || "(nothing to execute)"
        },
      }),

      rlm_fetch_and_index: tool({
        description:
          "Fetch a URL, convert HTML to text, chunk and index into the knowledge base. The raw page never enters context. Use rlm_search afterwards to query the indexed content.",
        args: {
          url: tool.schema.string().describe("URL to fetch"),
          source: tool.schema.string().describe("Label for indexed content (used in search filtering)"),
        },
        async execute(args) {
          logEvent("rlm_fetch_and_index", { url: args.url, source: args.source })

          try {
            const resp = await fetchUrl(args.url)
            if (resp.statusCode >= 400) {
              return `HTTP ${resp.statusCode} fetching ${args.url}`
            }

            let content = resp.body
            const isHtml = resp.contentType.includes("html") || content.trim().startsWith("<")
            if (isHtml) {
              content = htmlToText(content)
            }

            const s = getStore()
            const count = s.index(args.source, content)
            const stats = s.stats()
            const sizeStr = content.length >= 1024
              ? (content.length / 1024).toFixed(1) + "KB"
              : content.length + "B"

            return `Fetched ${args.url} (${sizeStr}${isHtml ? ", HTML->text" : ""})\nIndexed ${count} chunks as "${args.source}". KB has ${stats.chunks} chunks from ${stats.sources} sources (${stats.dbSize}).\nUse rlm_search to query this content.`
          } catch (e: any) {
            return "Fetch error: " + e.message
          }
        },
      }),
    },
  }
}
