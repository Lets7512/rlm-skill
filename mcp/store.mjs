/**
 * FTS5 Knowledge Base — porter+trigram dual tables with 3-layer search fallback.
 * Shared between MCP server and hook.
 *
 * SQLite backend priority:
 *   1. node:sqlite (Node 22+, built-in, no install needed)
 *   2. better-sqlite3 (fallback, requires native compilation)
 */

import fs from "fs";
import path from "path";
import os from "os";

var DB_PATH = path.join(os.homedir(), ".rlm", "kb", "store.db");

// Resolve SQLite backend
var DatabaseClass = null;
var backendName = "none";

try {
  // Node 22+ built-in sqlite (no install required)
  var nodeSqlite = await import("node:sqlite");
  DatabaseClass = nodeSqlite.DatabaseSync;
  backendName = "node:sqlite";
} catch (e) {
  try {
    var betterSqlite = await import("better-sqlite3");
    DatabaseClass = betterSqlite.default;
    backendName = "better-sqlite3";
  } catch (e2) {
    // Will throw when ContentStore is instantiated
  }
}

export class ContentStore {
  constructor() {
    if (!DatabaseClass) {
      throw new Error("No SQLite backend available. Need Node 22+ (node:sqlite) or better-sqlite3.");
    }
    var dir = path.dirname(DB_PATH);
    fs.mkdirSync(dir, { recursive: true });
    this.db = new DatabaseClass(DB_PATH);
    this._backend = backendName;
    this.db.exec("PRAGMA journal_mode = WAL");
    this._init();
  }

  _init() {
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
    `);

    var hasTrigger = this.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='chunks_ai'"
    ).get();

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
      `);
    }
  }

  index(source, content) {
    var chunks = this._chunk(content);
    var insert = this.db.prepare(
      "INSERT INTO chunks (source, chunk_text, chunk_index) VALUES (?, ?, ?)"
    );

    // node:sqlite doesn't have .transaction(), use manual BEGIN/COMMIT
    if (this._backend === "better-sqlite3") {
      var tx = this.db.transaction(function (items) {
        for (var i = 0; i < items.length; i++) {
          insert.run(source, items[i], i);
        }
        return items.length;
      });
      return tx(chunks);
    } else {
      this.db.exec("BEGIN");
      try {
        for (var i = 0; i < chunks.length; i++) {
          insert.run(source, chunks[i], i);
        }
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
      return chunks.length;
    }
  }

  indexFile(filePath, source) {
    var resolved = path.resolve(filePath);
    var content = fs.readFileSync(resolved, "utf-8");
    return this.index(source || path.basename(resolved), content);
  }

  search(queries, source, limit) {
    limit = limit || 5;
    var results = [];

    for (var q = 0; q < queries.length; q++) {
      var query = queries[q];
      var rows = this._porterSearch(query, source, limit);

      if (rows.length < 2) {
        var trigramRows = this._trigramSearch(query, source, limit);
        rows = this._mergeResults(rows, trigramRows, limit);
      }

      if (rows.length < 2) {
        var fuzzyRows = this._fuzzySearch(query, source, 3);
        rows = this._mergeResults(rows, fuzzyRows, limit);
      }

      for (var i = 0; i < rows.length; i++) results.push(rows[i]);
    }

    // Deduplicate
    var seen = new Set();
    return results.filter(function (r) {
      if (seen.has(r.text)) return false;
      seen.add(r.text);
      return true;
    });
  }

  clear(source) {
    if (source) {
      this.db.prepare("DELETE FROM chunks WHERE source LIKE ?").run("%" + source + "%");
    } else {
      this.db.exec("DELETE FROM chunks");
    }
  }

  stats() {
    var sources = this.db.prepare("SELECT COUNT(DISTINCT source) as c FROM chunks").get().c;
    var chunks = this.db.prepare("SELECT COUNT(*) as c FROM chunks").get().c;
    var dbSize = "0B";
    try {
      var s = fs.statSync(DB_PATH).size;
      dbSize = s >= 1024 * 1024
        ? (s / 1024 / 1024).toFixed(1) + "MB"
        : (s / 1024).toFixed(1) + "KB";
    } catch (e) {}
    return { sources: sources, chunks: chunks, dbSize: dbSize, backend: this._backend };
  }

  /**
   * Smart snippet extraction — returns windows around matching query terms
   * instead of full chunks. Finds where terms appear and extracts context.
   */
  smartSnippet(text, query, windowSize) {
    windowSize = windowSize || 200;
    var words = query.toLowerCase().split(/\s+/).filter(function (w) { return w.length > 2; });
    if (words.length === 0) return text.slice(0, windowSize);

    var lower = text.toLowerCase();
    var positions = [];
    for (var i = 0; i < words.length; i++) {
      var idx = lower.indexOf(words[i]);
      if (idx !== -1) positions.push(idx);
    }
    if (positions.length === 0) return text.slice(0, windowSize);

    // Sort positions, merge overlapping windows
    positions.sort(function (a, b) { return a - b; });
    var snippets = [];
    var half = Math.floor(windowSize / 2);
    for (var j = 0; j < positions.length; j++) {
      var start = Math.max(0, positions[j] - half);
      var end = Math.min(text.length, positions[j] + half);
      // Merge with previous if overlapping
      if (snippets.length > 0 && start <= snippets[snippets.length - 1].end) {
        snippets[snippets.length - 1].end = end;
      } else {
        snippets.push({ start: start, end: end });
      }
    }

    return snippets.map(function (s) {
      var prefix = s.start > 0 ? "..." : "";
      var suffix = s.end < text.length ? "..." : "";
      return prefix + text.slice(s.start, s.end).trim() + suffix;
    }).join("\n\n");
  }

  /**
   * Search with smart snippets — returns snippet-extracted results.
   */
  searchWithSnippets(queries, source, limit) {
    var self = this;
    var results = this.search(queries, source, limit);
    var queryStr = queries.join(" ");
    return results.map(function (r) {
      return {
        source: r.source,
        text: self.smartSnippet(r.text, queryStr),
        score: r.score,
      };
    });
  }

  close() {
    this.db.close();
  }

  _porterSearch(query, source, limit) {
    var ftsQuery = query.replace(/[^\w\s]/g, " ").trim();
    if (!ftsQuery) return [];
    try {
      if (source) {
        return this.db.prepare(
          "SELECT c.source, c.chunk_text as text, rank as score FROM chunks_fts f JOIN chunks c ON c.id = f.rowid WHERE chunks_fts MATCH ? AND c.source LIKE ? ORDER BY rank LIMIT ?"
        ).all(ftsQuery, "%" + source + "%", limit);
      }
      return this.db.prepare(
        "SELECT c.source, c.chunk_text as text, rank as score FROM chunks_fts f JOIN chunks c ON c.id = f.rowid WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?"
      ).all(ftsQuery, limit);
    } catch (e) { return []; }
  }

  _trigramSearch(query, source, limit) {
    if (query.length < 3) return [];
    try {
      var escaped = '"' + query.replace(/"/g, '""') + '"';
      if (source) {
        return this.db.prepare(
          "SELECT c.source, c.chunk_text as text, rank as score FROM chunks_trigram f JOIN chunks c ON c.id = f.rowid WHERE chunks_trigram MATCH ? AND c.source LIKE ? ORDER BY rank LIMIT ?"
        ).all(escaped, "%" + source + "%", limit);
      }
      return this.db.prepare(
        "SELECT c.source, c.chunk_text as text, rank as score FROM chunks_trigram f JOIN chunks c ON c.id = f.rowid WHERE chunks_trigram MATCH ? ORDER BY rank LIMIT ?"
      ).all(escaped, limit);
    } catch (e) { return []; }
  }

  _fuzzySearch(query, source, limit) {
    var words = query.toLowerCase().split(/\s+/).filter(function (w) { return w.length > 2; });
    if (words.length === 0) return [];

    var rows = source
      ? this.db.prepare("SELECT source, chunk_text as text FROM chunks WHERE source LIKE ? LIMIT 500").all("%" + source + "%")
      : this.db.prepare("SELECT source, chunk_text as text FROM chunks LIMIT 500").all();

    return rows
      .map(function (r) {
        return {
          source: r.source,
          text: r.text,
          score: words.filter(function (w) { return r.text.toLowerCase().includes(w); }).length,
        };
      })
      .filter(function (r) { return r.score > 0; })
      .sort(function (a, b) { return b.score - a.score; })
      .slice(0, limit);
  }

  _mergeResults(a, b, limit) {
    var seen = new Set(a.map(function (r) { return r.text; }));
    for (var i = 0; i < b.length; i++) {
      if (!seen.has(b[i].text)) {
        a.push(b[i]);
        seen.add(b[i].text);
      }
      if (a.length >= limit) break;
    }
    return a;
  }

  _chunk(content) {
    // Markdown heading split
    var sections = content.split(/^(?=## )/m);
    if (sections.length > 1 && sections.every(function (s) { return s.length < 2000; })) {
      return sections.map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });
    }

    // Fixed-size chunks with overlap
    var CHUNK_SIZE = 500;
    var OVERLAP = 50;
    var chunks = [];
    for (var i = 0; i < content.length; i += CHUNK_SIZE - OVERLAP) {
      chunks.push(content.slice(i, i + CHUNK_SIZE));
    }
    return chunks.length > 0 ? chunks : [content];
  }
}
