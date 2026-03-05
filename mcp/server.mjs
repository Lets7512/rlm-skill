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

var MAX_OUTPUT = 15000;
var TIMEOUT = 30000;

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

// Initialize
var store = new ContentStore();
var server = new McpServer({
  name: "rlm",
  version: "0.4.0",
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
      count = store.indexFile(args.filePath, args.source);
    } else if (args.content) {
      count = store.index(args.source, args.content);
    } else {
      return { content: [{ type: "text", text: "Error: provide either 'filePath' or 'content'" }] };
    }
    var s = store.stats();
    return {
      content: [{
        type: "text",
        text: 'Indexed ' + count + ' chunks as "' + args.source + '". KB has ' + s.chunks + ' chunks from ' + s.sources + ' sources (' + s.dbSize + ').',
      }],
    };
  }
);

// Tool: rlm_search
server.tool(
  "rlm_search",
  "Search the RLM knowledge base. Returns matching chunks ranked by BM25 relevance with 3-layer fallback (porter stemming, trigram, fuzzy).",
  {
    queries: z.array(z.string()).describe("Search queries (BM25 OR semantics, batch all in one call)"),
    source: z.string().optional().describe("Optional source filter (partial match)"),
  },
  function (args) {
    logEvent("rlm_search", { queries: args.queries, source: args.source });
    var results = store.search(args.queries, args.source);
    if (results.length === 0) {
      return { content: [{ type: "text", text: "No results found." }] };
    }
    var text = results
      .map(function (r, i) { return "[" + (i + 1) + "] (source: " + r.source + ")\n" + r.text; })
      .join("\n\n---\n\n");
    return { content: [{ type: "text", text: text }] };
  }
);

// Tool: rlm_stats
server.tool(
  "rlm_stats",
  "Show RLM knowledge base statistics.",
  {},
  function () {
    var s = store.stats();
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
