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
        chunk_text,
        content=chunks,
        content_rowid=id,
        tokenize='porter unicode61'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_trigram USING fts5(
        chunk_text,
        content=chunks,
        content_rowid=id,
        tokenize='trigram'
      );
    `)

    // Create triggers only if they don't exist (check via sqlite_master)
    const hasTrigger = this.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='chunks_ai'"
    ).get()

    if (!hasTrigger) {
      this.db.exec(`
        CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
          INSERT INTO chunks_fts(rowid, chunk_text) VALUES (new.id, new.chunk_text);
          INSERT INTO chunks_trigram(rowid, chunk_text) VALUES (new.id, new.chunk_text);
        END;
        CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
          INSERT INTO chunks_fts(chunks_fts, rowid, chunk_text) VALUES('delete', old.id, old.chunk_text);
          INSERT INTO chunks_trigram(chunks_trigram, rowid, chunk_text) VALUES('delete', old.id, old.chunk_text);
        END;
      `)
    }
  }

  index(source: string, content: string): number {
    const chunks = this.chunk(content)
    const insert = this.db.prepare(
      "INSERT INTO chunks (source, chunk_text, chunk_index) VALUES (?, ?, ?)"
    )
    const tx = this.db.transaction((items: string[]) => {
      for (let i = 0; i < items.length; i++) {
        insert.run(source, items[i], i)
      }
      return items.length
    })
    return tx(chunks)
  }

  indexFile(filePath: string, source?: string): number {
    const resolved = path.resolve(filePath)
    const content = fs.readFileSync(resolved, "utf-8")
    return this.index(source || path.basename(resolved), content)
  }

  search(
    queries: string[],
    source?: string,
    limit: number = 5
  ): Array<{ source: string; text: string; score: number }> {
    const results: Array<{ source: string; text: string; score: number }> = []

    for (const query of queries) {
      let rows = this.porterSearch(query, source, limit)

      if (rows.length < 2) {
        const trigramRows = this.trigramSearch(query, source, limit)
        rows = this.mergeResults(rows, trigramRows, limit)
      }

      if (rows.length < 2) {
        const fuzzyRows = this.fuzzySearch(query, source, 3)
        rows = this.mergeResults(rows, fuzzyRows, limit)
      }

      results.push(...rows)
    }

    const seen = new Set<string>()
    return results.filter((r) => {
      if (seen.has(r.text)) return false
      seen.add(r.text)
      return true
    })
  }

  clear(source?: string) {
    if (source) {
      this.db.prepare("DELETE FROM chunks WHERE source LIKE ?").run(`%${source}%`)
    } else {
      this.db.exec("DELETE FROM chunks")
    }
  }

  stats(): { sources: number; chunks: number; dbSize: string } {
    const sources = (
      this.db.prepare("SELECT COUNT(DISTINCT source) as c FROM chunks").get() as any
    ).c
    const chunks = (
      this.db.prepare("SELECT COUNT(*) as c FROM chunks").get() as any
    ).c
    let dbSize = "0B"
    try {
      const s = fs.statSync(DB_PATH).size
      dbSize =
        s >= 1024 * 1024
          ? (s / 1024 / 1024).toFixed(1) + "MB"
          : (s / 1024).toFixed(1) + "KB"
    } catch {}
    return { sources, chunks, dbSize }
  }

  close() {
    this.db.close()
  }

  private porterSearch(query: string, source: string | undefined, limit: number) {
    const ftsQuery = query.replace(/[^\w\s]/g, " ").trim()
    if (!ftsQuery) return []
    try {
      if (source) {
        return this.db
          .prepare(
            `SELECT c.source, c.chunk_text as text, rank as score
             FROM chunks_fts f JOIN chunks c ON c.id = f.rowid
             WHERE chunks_fts MATCH ? AND c.source LIKE ?
             ORDER BY rank LIMIT ?`
          )
          .all(ftsQuery, `%${source}%`, limit) as any[]
      }
      return this.db
        .prepare(
          `SELECT c.source, c.chunk_text as text, rank as score
           FROM chunks_fts f JOIN chunks c ON c.id = f.rowid
           WHERE chunks_fts MATCH ?
           ORDER BY rank LIMIT ?`
        )
        .all(ftsQuery, limit) as any[]
    } catch {
      return []
    }
  }

  private trigramSearch(query: string, source: string | undefined, limit: number) {
    if (query.length < 3) return []
    try {
      const escaped = '"' + query.replace(/"/g, '""') + '"'
      if (source) {
        return this.db
          .prepare(
            `SELECT c.source, c.chunk_text as text, rank as score
             FROM chunks_trigram f JOIN chunks c ON c.id = f.rowid
             WHERE chunks_trigram MATCH ? AND c.source LIKE ?
             ORDER BY rank LIMIT ?`
          )
          .all(escaped, `%${source}%`, limit) as any[]
      }
      return this.db
        .prepare(
          `SELECT c.source, c.chunk_text as text, rank as score
           FROM chunks_trigram f JOIN chunks c ON c.id = f.rowid
           WHERE chunks_trigram MATCH ?
           ORDER BY rank LIMIT ?`
        )
        .all(escaped, limit) as any[]
    } catch {
      return []
    }
  }

  private fuzzySearch(query: string, source: string | undefined, limit: number) {
    const words = query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2)
    if (words.length === 0) return []

    const rows = source
      ? (this.db
          .prepare("SELECT source, chunk_text as text FROM chunks WHERE source LIKE ? LIMIT 500")
          .all(`%${source}%`) as any[])
      : (this.db
          .prepare("SELECT source, chunk_text as text FROM chunks LIMIT 500")
          .all() as any[])

    return rows
      .map((r) => ({
        ...r,
        score: words.filter((w) => r.text.toLowerCase().includes(w)).length,
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  private mergeResults(a: any[], b: any[], limit: number) {
    const seen = new Set(a.map((r) => r.text))
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
    if (sections.length > 1 && sections.every((s) => s.length < 2000)) {
      return sections.map((s) => s.trim()).filter((s) => s.length > 0)
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
}
