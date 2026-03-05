# OpenCode Plugin v2: Interceptor Fix + Custom Tools + FTS5 Knowledge Base

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the OpenCode interceptor to use output.args rewriting (not throwing errors), add rlm_execute/rlm_search/rlm_index custom tools, and build an FTS5 knowledge base — all within the existing OpenCode plugin.

**Architecture:** The plugin has three modules: (1) rlm-store.ts — FTS5 SQLite knowledge base with porter+trigram dual tables and 3-layer search fallback, (2) rlm-executor.ts — sandbox subprocess executor that captures only stdout, (3) rlm-interceptor.ts — rewritten to modify output.args instead of throwing, plus registers custom tools via OpenCode's plugin API.

**Tech Stack:** TypeScript, better-sqlite3 (FTS5), child_process (sandbox), @opencode-ai/plugin

---

### Task 1: Add better-sqlite3 dependency

**Files:**
- Modify: `.opencode/package.json`

**Step 1: Add better-sqlite3 to dependencies**

```json
{
  "dependencies": {
    "@opencode-ai/plugin": "1.2.15",
    "better-sqlite3": "^11.0.0"
  }
}
```

**Step 2: Install**

Run: `cd .opencode && npm install`
Expected: better-sqlite3 installs with native bindings

**Step 3: Verify**

Run: `cd .opencode && node -e "const db = require('better-sqlite3')(':memory:'); console.log('sqlite ok', db.pragma('compile_options').map(r => r.compile_option).filter(o => o.includes('FTS')))"`
Expected: Shows FTS5 in compile options

**Step 4: Commit**

```bash
git add .opencode/package.json .opencode/bun.lock
git commit -m "feat: add better-sqlite3 for FTS5 knowledge base"
```

---

### Task 2: Build FTS5 Knowledge Base (rlm-store.ts)

**Files:**
- Create: `.opencode/plugins/rlm-store.ts`

**Step 1: Create the ContentStore class**

```typescript
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"

const DB_PATH = path.join(os.homedir(), ".rlm", "kb", "store.db")

export class ContentStore {
  private db: Database.Database

  constructor() {
    const dir = path.dirname(DB_PATH)
    fs.mkdirSync(dir, { recursive: true })
    this.db = new Database(DB_PATH)
    this.db.pragma("journal_mode = WAL")
    this.init()
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        chunk_text TEXT NOT NULL,
        chunk_index INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        chunk_text, source,
        content=chunks,
        content_rowid=id,
        tokenize='porter unicode61'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_trigram USING fts5(
        chunk_text, source,
        content=chunks,
        content_rowid=id,
        tokenize='trigram'
      );
      CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, chunk_text, source) VALUES (new.id, new.chunk_text, new.source);
        INSERT INTO chunks_trigram(rowid, chunk_text, source) VALUES (new.id, new.chunk_text, new.source);
      END;
      CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, chunk_text, source) VALUES('delete', old.id, old.chunk_text, old.source);
        INSERT INTO chunks_trigram(chunks_trigram, rowid, chunk_text, source) VALUES('delete', old.id, old.chunk_text, old.source);
      END;
    `)
  }

  index(source: string, content: string): number {
    const chunks = this.chunk(content)
    const insert = this.db.prepare("INSERT INTO chunks (source, chunk_text, chunk_index) VALUES (?, ?, ?)")
    const tx = this.db.transaction((chunks: string[]) => {
      for (let i = 0; i < chunks.length; i++) {
        insert.run(source, chunks[i], i)
      }
      return chunks.length
    })
    return tx(chunks)
  }

  indexFile(filePath: string, source?: string): number {
    const resolved = path.resolve(filePath)
    const content = fs.readFileSync(resolved, "utf-8")
    return this.index(source || path.basename(resolved), content)
  }

  search(queries: string[], source?: string, limit: number = 5): Array<{ source: string; text: string; score: number }> {
    const results: Array<{ source: string; text: string; score: number }> = []

    for (const query of queries) {
      // Layer 1: Porter stemmed search
      let rows = this.porterSearch(query, source, limit)

      // Layer 2: Trigram search if < 2 results
      if (rows.length < 2) {
        const trigramRows = this.trigramSearch(query, source, limit)
        rows = this.mergeResults(rows, trigramRows, limit)
      }

      // Layer 3: Fuzzy scan if still < 2 results
      if (rows.length < 2) {
        const fuzzyRows = this.fuzzySearch(query, source, 3)
        rows = this.mergeResults(rows, fuzzyRows, limit)
      }

      results.push(...rows)
    }

    // Deduplicate by text
    const seen = new Set<string>()
    return results.filter(r => {
      if (seen.has(r.text)) return false
      seen.add(r.text)
      return true
    })
  }

  private porterSearch(query: string, source: string | undefined, limit: number) {
    const ftsQuery = query.replace(/[^\w\s]/g, " ").trim()
    if (!ftsQuery) return []
    try {
      const sql = source
        ? `SELECT c.source, c.chunk_text as text, rank as score FROM chunks_fts f JOIN chunks c ON c.id = f.rowid WHERE chunks_fts MATCH ? AND c.source LIKE ? ORDER BY rank LIMIT ?`
        : `SELECT c.source, c.chunk_text as text, rank as score FROM chunks_fts f JOIN chunks c ON c.id = f.rowid WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?`
      return source
        ? (this.db.prepare(sql).all(ftsQuery, `%${source}%`, limit) as any[])
        : (this.db.prepare(sql).all(ftsQuery, limit) as any[])
    } catch { return [] }
  }

  private trigramSearch(query: string, source: string | undefined, limit: number) {
    if (query.length < 3) return []
    try {
      const sql = source
        ? `SELECT c.source, c.chunk_text as text, rank as score FROM chunks_trigram f JOIN chunks c ON c.id = f.rowid WHERE chunks_trigram MATCH ? AND c.source LIKE ? ORDER BY rank LIMIT ?`
        : `SELECT c.source, c.chunk_text as text, rank as score FROM chunks_trigram f JOIN chunks c ON c.id = f.rowid WHERE chunks_trigram MATCH ? ORDER BY rank LIMIT ?`
      const escaped = '"' + query.replace(/"/g, '""') + '"'
      return source
        ? (this.db.prepare(sql).all(escaped, `%${source}%`, limit) as any[])
        : (this.db.prepare(sql).all(escaped, limit) as any[])
    } catch { return [] }
  }

  private fuzzySearch(query: string, source: string | undefined, limit: number) {
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2)
    if (words.length === 0) return []
    const sql = source
      ? `SELECT source, chunk_text as text, 0 as score FROM chunks WHERE source LIKE ? LIMIT 500`
      : `SELECT source, chunk_text as text, 0 as score FROM chunks LIMIT 500`
    const rows = source
      ? (this.db.prepare(sql).all(`%${source}%`) as any[])
      : (this.db.prepare(sql).all() as any[])
    return rows
      .map(r => ({ ...r, score: words.filter(w => r.text.toLowerCase().includes(w)).length }))
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  private mergeResults(a: any[], b: any[], limit: number) {
    const seen = new Set(a.map(r => r.text))
    for (const r of b) {
      if (!seen.has(r.text)) {
        a.push(r)
        seen.add(r.text)
      }
      if (a.length >= limit) break
    }
    return a
  }

  private chunk(content: string): string[] {
    // Try markdown heading split first
    const sections = content.split(/^(?=## )/m)
    if (sections.length > 1 && sections.every(s => s.length < 2000)) {
      return sections.map(s => s.trim()).filter(s => s.length > 0)
    }

    // Fixed-size chunks with overlap
    const CHUNK_SIZE = 500
    const OVERLAP = 50
    const chunks: string[] = []
    for (let i = 0; i < content.length; i += CHUNK_SIZE - OVERLAP) {
      chunks.push(content.slice(i, i + CHUNK_SIZE))
    }
    return chunks.length > 0 ? chunks : [content]
  }

  clear(source?: string) {
    if (source) {
      this.db.prepare("DELETE FROM chunks WHERE source LIKE ?").run(`%${source}%`)
    } else {
      this.db.exec("DELETE FROM chunks")
    }
  }

  stats(): { sources: number; chunks: number; dbSize: string } {
    const sources = (this.db.prepare("SELECT COUNT(DISTINCT source) as c FROM chunks").get() as any).c
    const chunks = (this.db.prepare("SELECT COUNT(*) as c FROM chunks").get() as any).c
    let dbSize = "0B"
    try {
      const s = fs.statSync(DB_PATH).size
      dbSize = s >= 1024 * 1024 ? (s / 1024 / 1024).toFixed(1) + "MB" : (s / 1024).toFixed(1) + "KB"
    } catch {}
    return { sources, chunks, dbSize }
  }

  close() {
    this.db.close()
  }
}
```

**Step 2: Commit**

```bash
git add .opencode/plugins/rlm-store.ts
git commit -m "feat: add FTS5 knowledge base with porter+trigram dual tables"
```

---

### Task 3: Build Sandbox Executor (rlm-executor.ts)

**Files:**
- Create: `.opencode/plugins/rlm-executor.ts`

**Step 1: Create the PolyglotExecutor class**

```typescript
import { execSync } from "child_process"
import fs from "fs"
import path from "path"
import os from "os"

const MAX_OUTPUT = 15000  // 15K chars max
const TIMEOUT = 30000     // 30s default

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
  truncated: boolean
}

export function execute(language: string, code: string, timeout: number = TIMEOUT): ExecResult {
  const tmpDir = path.join(os.tmpdir(), "rlm-exec")
  fs.mkdirSync(tmpDir, { recursive: true })

  let cmd: string
  let tmpFile: string | null = null

  switch (language.toLowerCase()) {
    case "python":
    case "python3":
      tmpFile = path.join(tmpDir, `exec_${Date.now()}.py`)
      fs.writeFileSync(tmpFile, code)
      cmd = `python "${tmpFile}"`
      break
    case "javascript":
    case "js":
    case "node":
      tmpFile = path.join(tmpDir, `exec_${Date.now()}.js`)
      fs.writeFileSync(tmpFile, code)
      cmd = `node "${tmpFile}"`
      break
    case "shell":
    case "bash":
    case "sh":
      cmd = process.platform === "win32"
        ? `bash -c ${JSON.stringify(code)}`
        : `bash -c ${JSON.stringify(code)}`
      break
    default:
      return { stdout: "", stderr: `Unsupported language: ${language}`, exitCode: 1, truncated: false }
  }

  try {
    const stdout = execSync(cmd, {
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      encoding: "utf-8",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    })

    const truncated = stdout.length > MAX_OUTPUT
    return {
      stdout: truncated ? stdout.slice(0, MAX_OUTPUT) + "\n...[truncated]" : stdout,
      stderr: "",
      exitCode: 0,
      truncated,
    }
  } catch (e: any) {
    const stdout = (e.stdout || "").toString()
    const stderr = (e.stderr || "").toString()
    const truncated = stdout.length > MAX_OUTPUT
    return {
      stdout: truncated ? stdout.slice(0, MAX_OUTPUT) + "\n...[truncated]" : stdout,
      stderr: stderr.slice(0, 2000),
      exitCode: e.status ?? 1,
      truncated,
    }
  } finally {
    if (tmpFile) try { fs.unlinkSync(tmpFile) } catch {}
  }
}

export function executeFile(filePath: string, language: string, code: string, timeout: number = TIMEOUT): ExecResult {
  const resolved = path.resolve(filePath)
  const content = fs.readFileSync(resolved, "utf-8")

  // Inject FILE_CONTENT variable
  let wrappedCode: string
  switch (language.toLowerCase()) {
    case "python":
    case "python3":
      wrappedCode = `FILE_CONTENT = ${JSON.stringify(content)}\n${code}`
      break
    case "javascript":
    case "js":
    case "node":
      wrappedCode = `const FILE_CONTENT = ${JSON.stringify(content)};\n${code}`
      break
    case "shell":
    case "bash":
    case "sh":
      wrappedCode = `export FILE_CONTENT=${JSON.stringify(content)}\n${code}`
      break
    default:
      return { stdout: "", stderr: `Unsupported language: ${language}`, exitCode: 1, truncated: false }
  }

  return execute(language, wrappedCode, timeout)
}
```

**Step 2: Commit**

```bash
git add .opencode/plugins/rlm-executor.ts
git commit -m "feat: add sandbox executor with python/js/shell support"
```

---

### Task 4: Rewrite Interceptor with output.args Modification

**Files:**
- Modify: `.opencode/plugins/rlm-interceptor.ts`

**Step 1: Rewrite the interceptor**

Key changes:
- Remove all `throw new Error(...)` patterns
- For `Read` of large files: modify `output.args` to set `command` with a python summary script, and change `input.tool` to `"bash"`
- For large-output Bash commands: wrap `output.args.command` in a python summarizer
- For WebFetch: rewrite to python urllib download + summary
- Keep debug logging and stats event logging

The interceptor should:
1. Check file size via `fs.statSync`
2. If >5KB, rewrite the tool call:
   - Set `input.tool = "bash"` (or the shell tool name)
   - Set `output.args = { command: "python -c \"...\"", description: "RLM: analyze file metadata" }`
3. The python script prints file metadata, size, head/tail preview, and RLM protocol instructions
4. Log the interception event to stats

For bash commands targeting large files:
1. Extract the target file from the command
2. Wrap the command in a python script that processes and summarizes
3. Replace `output.args.command` with the wrapped version

**Step 2: Commit**

```bash
git add .opencode/plugins/rlm-interceptor.ts
git commit -m "fix: rewrite interceptor to use output.args modification instead of throwing"
```

---

### Task 5: Register Custom Tools (rlm_execute, rlm_search, rlm_index)

**Files:**
- Modify: `.opencode/plugins/rlm-interceptor.ts`

**Step 1: Add tool registration to the plugin export**

Using OpenCode's plugin `tool` helper, register three tools in the plugin's return object alongside the existing `tool.execute.before` hook:

```typescript
return {
  "tool.execute.before": async (input, output) => { /* existing interceptor */ },

  tools: [
    {
      name: "rlm_execute",
      description: "Execute code in a sandboxed subprocess. Only stdout enters context. Supports python, javascript, shell.",
      parameters: {
        language: { type: "string", description: "python | javascript | shell" },
        code: { type: "string", description: "Code to execute" },
      },
      execute: async (args) => { /* call execute() from rlm-executor */ },
    },
    {
      name: "rlm_search",
      description: "Search the RLM knowledge base. Returns matching chunks ranked by relevance.",
      parameters: {
        queries: { type: "array", items: { type: "string" }, description: "Search queries" },
        source: { type: "string", description: "Optional source filter (partial match)" },
      },
      execute: async (args) => { /* call store.search() */ },
    },
    {
      name: "rlm_index",
      description: "Index content into the RLM knowledge base for later search.",
      parameters: {
        path: { type: "string", description: "File path to index (reads server-side)" },
        content: { type: "string", description: "Inline text to index (use path for files)" },
        source: { type: "string", description: "Label for this content" },
      },
      execute: async (args) => { /* call store.index() or store.indexFile() */ },
    },
  ],
}
```

**Step 2: Commit**

```bash
git add .opencode/plugins/rlm-interceptor.ts
git commit -m "feat: register rlm_execute, rlm_search, rlm_index custom tools"
```

---

### Task 6: Update Stats Integration

**Files:**
- Modify: `src/stats.py`

**Step 1: Add new event types to stats dashboard**

Add these event types to `by_protocol`:
- `rlm_intercept_rewrite` — when a read/bash is silently rewritten
- `rlm_execute` — sandbox execution
- `rlm_index` — content indexed
- `rlm_search` — KB searched

Update the dashboard to show these in a "Plugin Activity" section.

**Step 2: Commit**

```bash
git add src/stats.py
git commit -m "feat: add plugin activity events to stats dashboard"
```

---

### Task 7: Benchmark Test + Cleanup

**Files:**
- Modify: `tests/test_plugin_structure.py` (add tests for new files)
- Clean up: `tests/benchmark_data.json`, `tests/benchmark_large.json`

**Step 1: Update plugin structure tests**

Add assertions for:
- `.opencode/plugins/rlm-store.ts` exists
- `.opencode/plugins/rlm-executor.ts` exists
- `.opencode/plugins/rlm-interceptor.ts` has no `throw new Error("[RLM]` patterns
- `package.json` includes `better-sqlite3`

**Step 2: Run tests**

Run: `python -m pytest tests/ -v`
Expected: All pass

**Step 3: Run OpenCode benchmark**

Run: `cd D:/OpenSource/rlm-skill && opencode run "Read tests/benchmark_large.json and give me average score by department" --format json`
Expected: Interceptor rewrites read (no error thrown), model gets metadata, uses rlm_execute or python -c

**Step 4: Clean up benchmark files**

```bash
rm tests/benchmark_data.json tests/benchmark_large.json
```

**Step 5: Commit**

```bash
git add tests/test_plugin_structure.py
git commit -m "test: add plugin structure tests for v2 modules"
```
