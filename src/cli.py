#!/usr/bin/env python3
"""
rlm-cli — CLI wrapper around MIT's RLM library.

Usage:
  # Analyze a file with RLM (uses REPL, not stuffing into context)
  rlm-cli query "Find all security issues" --file /path/to/large.log

  # Analyze a repo
  rlm-cli query "List all classes and their methods" --repo /path/to/repo

  # Quick REPL session — load file, drop into interactive mode
  rlm-cli repl --file /path/to/data.json

  # Show token usage stats
  rlm-cli query "..." --file ... --stats

Backends:
  --backend openai   --model gpt-5-nano          (default)
  --backend openai   --model MiniMax-M2.5 --base-url http://localhost:8000/v1   (local vLLM)
  --backend anthropic --model claude-sonnet-4-6
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path


def collect_repo_source(repo_path: str, extensions: list[str] | None = None) -> str:
    """Collect all source files from a repo into a single string."""
    if extensions is None:
        extensions = [".py", ".js", ".ts", ".tsx", ".rs", ".go", ".c", ".h", ".java"]
    sources = []
    repo = Path(repo_path)
    for p in sorted(repo.rglob("*")):
        if not p.is_file():
            continue
        if ".git" in p.parts or "node_modules" in p.parts or "__pycache__" in p.parts:
            continue
        if p.suffix not in extensions:
            continue
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
            rel = p.relative_to(repo)
            sources.append(f"### {rel}\n{text}")
        except Exception:
            pass
    return "\n\n".join(sources)


def run_query(args):
    """Run an RLM query against a file or repo."""
    try:
        from rlm import RLM
        from rlm.logger import RLMLogger
    except ImportError:
        print("Error: rlm not installed. Run: uv add 'rlms @ git+https://github.com/alexzhang13/rlm.git'")
        sys.exit(1)

    # Build context
    if args.repo:
        print(f"Collecting sources from {args.repo}...")
        context = collect_repo_source(args.repo)
        print(f"  Collected {len(context):,} chars (~{len(context)//4:,} tokens)")
    elif args.file:
        context = Path(args.file).read_text(encoding="utf-8", errors="replace")
        print(f"Loaded {args.file}: {len(context):,} chars (~{len(context)//4:,} tokens)")
    else:
        print("Error: --file or --repo required")
        sys.exit(1)

    # Configure backend
    backend_kwargs = {"model_name": args.model}
    if args.api_key:
        backend_kwargs["api_key"] = args.api_key
    elif args.backend == "openai":
        backend_kwargs["api_key"] = os.getenv("OPENAI_API_KEY", "")
    elif args.backend == "anthropic":
        backend_kwargs["api_key"] = os.getenv("ANTHROPIC_API_KEY", "")

    if args.base_url:
        backend_kwargs["base_url"] = args.base_url

    # Setup logger
    logger = None
    if args.log_dir:
        logger = RLMLogger(log_dir=args.log_dir)

    # Create RLM instance
    env_kwargs = {}
    if args.environment == "docker":
        env_kwargs = {"image": args.docker_image or "python:3.12-slim"}

    rlm = RLM(
        backend=args.backend,
        backend_kwargs=backend_kwargs,
        environment=args.environment,
        environment_kwargs=env_kwargs,
        max_depth=args.max_depth,
        max_iterations=args.max_iterations,
        logger=logger,
        verbose=args.verbose,
    )

    # Run completion
    print(f"\nQuery: {args.query}")
    print(f"Backend: {args.backend}/{args.model}")
    print(f"Environment: {args.environment}")
    print("-" * 60)

    t0 = time.perf_counter()
    result = rlm.completion(
        prompt={"query": args.query, "context": context},
    )
    elapsed = time.perf_counter() - t0

    # Output
    print("\n" + "=" * 60)
    print("RESULT")
    print("=" * 60)
    print(result.response if hasattr(result, "response") else str(result))

    if args.stats:
        print("\n" + "-" * 60)
        print("STATS")
        print("-" * 60)
        print(f"  Time:       {elapsed:.1f}s")
        if hasattr(result, "usage_summary") and result.usage_summary:
            us = result.usage_summary
            if hasattr(us, "model_usage_summaries"):
                for model, summary in us.model_usage_summaries.items():
                    print(f"  Model:      {model}")
                    print(f"  Input:      {summary.total_input_tokens:,} tokens")
                    print(f"  Output:     {summary.total_output_tokens:,} tokens")
                    print(f"  Calls:      {summary.total_calls}")
        if hasattr(result, "metadata") and result.metadata:
            m = result.metadata
            if hasattr(m, "iterations"):
                print(f"  Iterations: {len(m.iterations)}")
            if hasattr(m, "execution_time"):
                print(f"  Exec time:  {m.execution_time:.1f}s")

    if args.output:
        out = {
            "query": args.query,
            "response": result.response if hasattr(result, "response") else str(result),
            "elapsed_s": round(elapsed, 2),
        }
        Path(args.output).write_text(json.dumps(out, indent=2))
        print(f"\nSaved to {args.output}")


def run_repl(args):
    """Interactive REPL with file loaded as `context`."""
    try:
        from rlm import RLM
    except ImportError:
        print("Error: rlm not installed.")
        sys.exit(1)

    if args.file:
        context = Path(args.file).read_text(encoding="utf-8", errors="replace")
    elif args.repo:
        context = collect_repo_source(args.repo)
    else:
        context = ""

    print(f"RLM REPL — {len(context):,} chars loaded as `context`")
    print("Type Python code. Use `context` variable. Ctrl+C to exit.\n")

    ns = {"context": context}
    while True:
        try:
            code = input(">>> ")
            if not code.strip():
                continue
            # Multi-line input
            while code.rstrip().endswith(":") or code.rstrip().endswith("\\"):
                code = code.rstrip("\\") + "\n" + input("... ")
            exec(code, ns)
        except KeyboardInterrupt:
            print("\nBye.")
            break
        except Exception as e:
            print(f"Error: {e}")


def main():
    parser = argparse.ArgumentParser(
        description="RLM CLI — Recursive Language Model for large-context analysis",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # ── query ──
    q = sub.add_parser("query", help="Run an RLM query")
    q.add_argument("query", help="The question to answer")
    q.add_argument("--file", "-f", help="Path to file to analyze")
    q.add_argument("--repo", "-r", help="Path to repo to analyze")
    q.add_argument("--backend", "-b", default="openai", choices=["openai", "anthropic", "portkey", "litellm"])
    q.add_argument("--model", "-m", default="gpt-5-nano")
    q.add_argument("--base-url", help="Custom API base URL (e.g. http://localhost:8000/v1 for vLLM)")
    q.add_argument("--api-key", help="API key (or use env var)")
    q.add_argument("--environment", "-e", default="local", choices=["local", "docker", "modal"])
    q.add_argument("--docker-image", help="Docker image for docker environment")
    q.add_argument("--max-depth", type=int, default=1)
    q.add_argument("--max-iterations", type=int, default=10)
    q.add_argument("--log-dir", help="Directory to save trajectory logs")
    q.add_argument("--output", "-o", help="Save result to JSON file")
    q.add_argument("--stats", action="store_true", help="Show token usage stats")
    q.add_argument("--verbose", "-v", action="store_true")
    q.set_defaults(func=run_query)

    # ── repl ──
    r = sub.add_parser("repl", help="Interactive REPL with file/repo loaded")
    r.add_argument("--file", "-f", help="Path to file to load as context")
    r.add_argument("--repo", "-r", help="Path to repo to load as context")
    r.set_defaults(func=run_repl)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
