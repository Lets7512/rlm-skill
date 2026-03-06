#!/usr/bin/env node
/**
 * RLM MCP Server — provides rlm_execute, rlm_search, rlm_index tools for Claude Code.
 * Communicates via stdio using the Model Context Protocol.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { ContentStore } from "./store.mjs";
import http from "http";
import https from "https";

var MAX_OUTPUT = 15000;
var TIMEOUT = 30000;
var INTENT_THRESHOLD = 5 * 1024; // 5KB — auto-index + search by intent

function logEvent(event, details) {
  try {
    var statsDir = path.join(os.homedir(), ".rlm", "stats");
    fs.mkdirSync(statsDir, { recursive: true });
    var entry = JSON.stringify(Object.assign({ ts: new Date().toISOString(), event: event }, details));
    fs.appendFileSync(path.join(statsDir, "events.jsonl"), entry + "\n");
  } catch (e) {}
}

function executeCode(language, code, timeout) {
  timeout = timeout || TIMEOUT;
  var tmpDir = path.join(os.tmpdir(), "rlm-exec");
  fs.mkdirSync(tmpDir, { recursive: true });

  var cmd;
  var tmpFile = null;

  switch (language.toLowerCase()) {
    case "python":
    case "python3":
      tmpFile = path.join(tmpDir, "exec_" + Date.now() + ".py");
      fs.writeFileSync(tmpFile, code);
      cmd = 'python "' + tmpFile + '"';
      break;
    case "javascript":
    case "js":
    case "node":
      tmpFile = path.join(tmpDir, "exec_" + Date.now() + ".js");
      fs.writeFileSync(tmpFile, code);
      cmd = 'node "' + tmpFile + '"';
      break;
    case "shell":
    case "bash":
    case "sh":
      cmd = "bash -c " + JSON.stringify(code);
      break;
    default:
      return { stdout: "", stderr: "Unsupported language: " + language, exitCode: 1 };
  }

  try {
    var stdout = execSync(cmd, {
      timeout: timeout,
      maxBuffer: 10 * 1024 * 1024,
      encoding: "utf-8",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    var truncated = stdout.length > MAX_OUTPUT;
    return {
      stdout: truncated ? stdout.slice(0, MAX_OUTPUT) + "\n...[truncated]" : stdout,
      stderr: "",
      exitCode: 0,
    };
  } catch (e) {
    var out = (e.stdout || "").toString();
    var err = (e.stderr || "").toString();
    return {
      stdout: out.length > MAX_OUTPUT ? out.slice(0, MAX_OUTPUT) + "\n...[truncated]" : out,
      stderr: err.slice(0, 2000),
      exitCode: e.status || 1,
    };
  } finally {
    if (tmpFile) try { fs.unlinkSync(tmpFile); } catch (e) {}
  }
}

function fetchUrl(url) {
  return new Promise(function (resolve, reject) {
    var mod = url.startsWith("https") ? https : http;
    mod.get(url, { headers: { "User-Agent": "RLM-Skill/0.4" } }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve, reject);
      }
      var chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        resolve({
          body: Buffer.concat(chunks).toString("utf-8"),
          contentType: res.headers["content-type"] || "",
          statusCode: res.statusCode,
        });
      });
      res.on("error", reject);
    }).on("error", reject);
  });
}

function htmlToText(html) {
  // Strip scripts and styles
  var text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  // Convert common elements
  text = text.replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, "\n## $1\n");
  text = text.replace(/<li[^>]*>(.*?)<\/li>/gi, "- $1\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<p[^>]*>(.*?)<\/p>/gi, "\n$1\n");
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "\n```\n$1\n```\n");
  text = text.replace(/<code[^>]*>(.*?)<\/code>/gi, "`$1`");
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "[$2]($1)");
  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, "");
  // Decode entities
  text = text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
  // Clean whitespace
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  return text;
}

// Initialize — store may be null if no SQLite backend available
var store = null;
try {
  store = new ContentStore();
} catch (e) {
  process.stderr.write("RLM MCP: Knowledge base unavailable (" + e.message + "). Execute tools still work.\n");
}

function requireStore() {
  if (!store) throw new Error("Knowledge base unavailable. Need Node 22+ (built-in sqlite) or better-sqlite3. Execute tools still work.");
  return store;
}

var server = new McpServer({
  name: "rlm",
  version: "0.4.4",
});

// Tool: rlm_execute
server.tool(
  "rlm_execute",
  "Execute code in a sandboxed subprocess. Only stdout enters context. Use for processing large files, APIs, data analysis.",
  {
    language: z.enum(["python", "javascript", "shell"]).describe("Language runtime"),
    code: z.string().describe("Code to execute"),
  },
  function (args) {
    logEvent("rlm_execute", { language: args.language, code_length: args.code.length });
    var result = executeCode(args.language, args.code);
    var output = result.stdout;
    if (result.stderr) output += "\n[stderr] " + result.stderr;
    if (result.exitCode !== 0) output += "\n[exit code: " + result.exitCode + "]";
    return { content: [{ type: "text", text: output || "(no output)" }] };
  }
);

// Tool: rlm_execute_file
server.tool(
  "rlm_execute_file",
  "Execute code against a file. The file content is loaded into FILE_CONTENT variable (python/js) or FILE_CONTENT_PATH (shell). Only stdout enters context.",
  {
    path: z.string().describe("File path to process"),
    language: z.enum(["python", "javascript", "shell"]).describe("Language runtime"),
    code: z.string().describe("Code to execute (FILE_CONTENT is pre-loaded)"),
  },
  function (args) {
    logEvent("rlm_execute", { language: args.language, code_length: args.code.length, file: args.path });
    var resolved = path.resolve(args.path);
    var content;
    try {
      content = fs.readFileSync(resolved, "utf-8");
    } catch (e) {
      return { content: [{ type: "text", text: "Error: cannot read file: " + e.message }] };
    }

    var wrappedCode;
    switch (args.language.toLowerCase()) {
      case "python":
      case "python3":
        wrappedCode = "import json as _json\nFILE_CONTENT = _json.loads(" + JSON.stringify(JSON.stringify(content)) + ")\n" + args.code;
        break;
      case "javascript":
      case "js":
      case "node":
        wrappedCode = "const FILE_CONTENT = " + JSON.stringify(content) + ";\n" + args.code;
        break;
      default:
        wrappedCode = "export FILE_CONTENT_PATH=\"" + resolved + "\"\n" + args.code;
    }

    var result = executeCode(args.language, wrappedCode);
    var output = result.stdout;
    if (result.stderr) output += "\n[stderr] " + result.stderr;
    if (result.exitCode !== 0) output += "\n[exit code: " + result.exitCode + "]";
    return { content: [{ type: "text", text: output || "(no output)" }] };
  }
);

// Tool: rlm_index
server.tool(
  "rlm_index",
  "Index content into the RLM knowledge base for later search via rlm_search. Use 'filePath' for files (reads server-side, no context cost). Use 'content' only for small inline text.",
  {
    source: z.string().describe("Label for this content (used in search filtering)"),
    filePath: z.string().optional().describe("File path to index (reads server-side)"),
    content: z.string().optional().describe("Inline text to index (prefer filePath for files)"),
  },
  function (args) {
    logEvent("rlm_index", { source: args.source, path: args.filePath });
    var count;
    if (args.filePath) {
      count = requireStore().indexFile(args.filePath, args.source);
    } else if (args.content) {
      count = requireStore().index(args.source, args.content);
    } else {
      return { content: [{ type: "text", text: "Error: provide either 'filePath' or 'content'" }] };
    }
    var s = requireStore().stats();
    return {
      content: [{
        type: "text",
        text: 'Indexed ' + count + ' chunks as "' + args.source + '". KB has ' + s.chunks + ' chunks from ' + s.sources + ' sources (' + s.dbSize + ').',
      }],
    };
  }
);

// Tool: rlm_search (with smart snippets)
server.tool(
  "rlm_search",
  "Search the RLM knowledge base. Returns smart snippets (windows around matching terms) ranked by BM25 with 3-layer fallback (porter/trigram/fuzzy). Batch all queries in one call.",
  {
    queries: z.array(z.string()).describe("Search queries (BM25 OR semantics, batch all in one call)"),
    source: z.string().optional().describe("Optional source filter (partial match)"),
  },
  function (args) {
    logEvent("rlm_search", { queries: args.queries, source: args.source });
    var results = requireStore().searchWithSnippets(args.queries, args.source);
    if (results.length === 0) {
      return { content: [{ type: "text", text: "No results found." }] };
    }
    var text = results
      .map(function (r, i) { return "[" + (i + 1) + "] (source: " + r.source + ")\n" + r.text; })
      .join("\n\n---\n\n");
    return { content: [{ type: "text", text: text }] };
  }
);

// Tool: rlm_batch_execute
server.tool(
  "rlm_batch_execute",
  "Run multiple commands AND search multiple queries in ONE call. Each command runs in a sandbox (stdout-only). Search queries run against the knowledge base. Saves tool-call overhead.",
  {
    commands: z.array(z.object({
      language: z.enum(["python", "javascript", "shell"]).describe("Language runtime"),
      code: z.string().describe("Code to execute"),
    })).optional().describe("Commands to execute in sandbox"),
    queries: z.array(z.string()).optional().describe("Search queries for knowledge base"),
    source: z.string().optional().describe("Source filter for search queries"),
  },
  function (args) {
    var parts = [];

    // Execute commands
    if (args.commands && args.commands.length > 0) {
      logEvent("rlm_batch_execute", { commands: args.commands.length, queries: (args.queries || []).length });
      for (var i = 0; i < args.commands.length; i++) {
        var cmd = args.commands[i];
        var result = executeCode(cmd.language, cmd.code);
        var output = result.stdout;
        if (result.stderr) output += "\n[stderr] " + result.stderr;
        if (result.exitCode !== 0) output += "\n[exit code: " + result.exitCode + "]";
        parts.push("=== Command " + (i + 1) + " (" + cmd.language + ") ===\n" + (output || "(no output)"));
      }
    }

    // Run search queries
    if (args.queries && args.queries.length > 0) {
      var results = requireStore().searchWithSnippets(args.queries, args.source);
      if (results.length === 0) {
        parts.push("=== Search ===\nNo results found.");
      } else {
        var text = results
          .map(function (r, idx) { return "[" + (idx + 1) + "] (source: " + r.source + ")\n" + r.text; })
          .join("\n\n");
        parts.push("=== Search ===\n" + text);
      }
    }

    return { content: [{ type: "text", text: parts.join("\n\n") || "(nothing to execute)" }] };
  }
);

// Tool: rlm_fetch_and_index
server.tool(
  "rlm_fetch_and_index",
  "Fetch a URL, convert HTML to text, chunk and index into the knowledge base. The raw page never enters context. Use rlm_search afterwards to query the indexed content.",
  {
    url: z.string().describe("URL to fetch"),
    source: z.string().describe("Label for indexed content (used in search filtering)"),
  },
  async function (args) {
    logEvent("rlm_fetch_and_index", { url: args.url, source: args.source });
    try {
      var resp = await fetchUrl(args.url);
      if (resp.statusCode >= 400) {
        return { content: [{ type: "text", text: "HTTP " + resp.statusCode + " fetching " + args.url }] };
      }

      var content = resp.body;
      var isHtml = resp.contentType.includes("html") || content.trim().startsWith("<");
      if (isHtml) {
        content = htmlToText(content);
      }

      var count = requireStore().index(args.source, content);
      var s = requireStore().stats();
      var sizeStr = content.length >= 1024 ? (content.length / 1024).toFixed(1) + "KB" : content.length + "B";

      return {
        content: [{
          type: "text",
          text: "Fetched " + args.url + " (" + sizeStr + (isHtml ? ", HTML->text" : "") + ")\n" +
            "Indexed " + count + " chunks as \"" + args.source + "\". KB has " + s.chunks + " chunks from " + s.sources + " sources (" + s.dbSize + ").\n" +
            "Use rlm_search to query this content.",
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: "Fetch error: " + e.message }] };
    }
  }
);

// Tool: rlm_stats
server.tool(
  "rlm_stats",
  "Show RLM knowledge base statistics.",
  {},
  function () {
    var s = requireStore().stats();
    return {
      content: [{
        type: "text",
        text: "KB Stats: " + s.chunks + " chunks from " + s.sources + " sources (" + s.dbSize + ")",
      }],
    };
  }
);

// Start server
async function main() {
  var transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(function (e) {
  process.stderr.write("RLM MCP server error: " + e.message + "\n");
  process.exit(1);
});
