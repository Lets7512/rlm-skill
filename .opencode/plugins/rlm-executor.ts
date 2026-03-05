import { execSync } from "child_process"
import fs from "fs"
import path from "path"
import os from "os"

const MAX_OUTPUT = 15000
const TIMEOUT = 30000

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
  truncated: boolean
}

export function execute(
  language: string,
  code: string,
  timeout: number = TIMEOUT
): ExecResult {
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
      cmd = `bash -c ${JSON.stringify(code)}`
      break
    default:
      return {
        stdout: "",
        stderr: `Unsupported language: ${language}. Use python, javascript, or shell.`,
        exitCode: 1,
        truncated: false,
      }
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
      stdout: truncated
        ? stdout.slice(0, MAX_OUTPUT) + "\n...[truncated]"
        : stdout,
      stderr: "",
      exitCode: 0,
      truncated,
    }
  } catch (e: any) {
    const stdout = (e.stdout || "").toString()
    const stderr = (e.stderr || "").toString()
    const truncated = stdout.length > MAX_OUTPUT
    return {
      stdout: truncated
        ? stdout.slice(0, MAX_OUTPUT) + "\n...[truncated]"
        : stdout,
      stderr: stderr.slice(0, 2000),
      exitCode: e.status ?? 1,
      truncated,
    }
  } finally {
    if (tmpFile) {
      try {
        fs.unlinkSync(tmpFile)
      } catch {}
    }
  }
}

export function executeFile(
  filePath: string,
  language: string,
  code: string,
  timeout: number = TIMEOUT
): ExecResult {
  const resolved = path.resolve(filePath)
  const content = fs.readFileSync(resolved, "utf-8")

  let wrappedCode: string
  switch (language.toLowerCase()) {
    case "python":
    case "python3":
      wrappedCode = `import json as _json\nFILE_CONTENT = _json.loads(${JSON.stringify(JSON.stringify(content))})\n${code}`
      break
    case "javascript":
    case "js":
    case "node":
      wrappedCode = `const FILE_CONTENT = ${JSON.stringify(content)};\n${code}`
      break
    case "shell":
    case "bash":
    case "sh":
      // For shell, write content to a temp file and set FILE_CONTENT to the path
      wrappedCode = `export FILE_CONTENT_PATH="${resolved}"\n${code}`
      break
    default:
      return {
        stdout: "",
        stderr: `Unsupported language: ${language}`,
        exitCode: 1,
        truncated: false,
      }
  }

  return execute(language, wrappedCode, timeout)
}
