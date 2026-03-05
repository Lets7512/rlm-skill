#!/usr/bin/env python3
"""
rlm-stats — Track and display token savings from using RLM patterns.

Reads hook events from a JSON log and computes estimated token savings
compared to naively stuffing data into the context window.
"""

import json
import os
import sys
from datetime import datetime
from pathlib import Path

# Ensure UTF-8 output on Windows
if sys.stdout.encoding != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

STATS_DIR = Path.home() / ".rlm" / "stats"
STATS_FILE = STATS_DIR / "events.jsonl"


def ensure_stats_dir():
    STATS_DIR.mkdir(parents=True, exist_ok=True)


def log_event(event_type, file_path="", size_bytes=0, pattern=0):
    """Append an RLM event to the stats log."""
    ensure_stats_dir()
    entry = {
        "ts": datetime.now().isoformat(),
        "event": event_type,
        "file": file_path,
        "size_bytes": size_bytes,
        "pattern": pattern,
    }
    with open(STATS_FILE, "a") as f:
        f.write(json.dumps(entry) + "\n")


def read_events():
    """Read all logged events."""
    if not STATS_FILE.exists():
        return []
    events = []
    for line in STATS_FILE.read_text().splitlines():
        line = line.strip()
        if line:
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return events


def format_size(n):
    if n >= 1024 * 1024:
        return f"{n / (1024 * 1024):.1f}MB"
    if n >= 1024:
        return f"{n / 1024:.1f}KB"
    return f"{n}B"


def compute_stats(events):
    """Compute token savings statistics."""
    total_raw_bytes = 0
    total_events = len(events)
    by_pattern = {1: 0, 2: 0, 3: 0}
    by_protocol = {
        "rlm_metadata": 0,
        "rlm_peek": 0,
        "rlm_search": 0,
        "rlm_analyze": 0,
        "rlm_submit": 0,
        "rlm_cli": 0,
    }

    for e in events:
        size = e.get("size_bytes", 0)
        total_raw_bytes += size
        p = e.get("pattern", 0)
        if p in by_pattern:
            by_pattern[p] += 1
        evt = e.get("event", "")
        if evt in by_protocol:
            by_protocol[evt] += 1

    # Estimate: 1 token ~ 4 bytes. RLM typically reduces output to ~2% of input.
    raw_tokens = total_raw_bytes // 4
    # Conservative estimate: RLM extracts ~2-5% of data as useful summary
    estimated_context_tokens = int(raw_tokens * 0.03)
    saved_tokens = raw_tokens - estimated_context_tokens

    return {
        "total_events": total_events,
        "total_raw_bytes": total_raw_bytes,
        "raw_tokens": raw_tokens,
        "estimated_context_tokens": estimated_context_tokens,
        "saved_tokens": saved_tokens,
        "savings_pct": (saved_tokens / raw_tokens * 100) if raw_tokens > 0 else 0,
        "by_pattern": by_pattern,
        "by_protocol": by_protocol,
    }


def format_tokens(n):
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}K"
    return str(n)


def savings_bar(pct, width=30):
    filled = int(pct / 100 * width)
    return f"[{'█' * filled}{'░' * (width - filled)}] {pct:.1f}%"


def print_dashboard(stats):
    """Print a formatted dashboard of token savings."""
    print()
    print("╔══════════════════════════════════════════════════╗")
    print("║          RLM Token Savings Dashboard             ║")
    print("╠══════════════════════════════════════════════════╣")

    if stats["total_events"] == 0:
        print("║                                                  ║")
        print("║  No events logged yet.                           ║")
        print("║  The PreToolUse hook will start tracking when     ║")
        print("║  it detects large file operations (>500KB).       ║")
        print("║                                                  ║")
        print("╚══════════════════════════════════════════════════╝")
        return

    print("║                                                  ║")
    print(f"║  Interceptions:    {stats['total_events']:<30}║")
    print(f"║  Raw data:         {format_size(stats['total_raw_bytes']):<30}║")
    print("║                                                  ║")
    print("╠──────────────────────────────────────────────────╣")
    print("║  Token Analysis                                  ║")
    print("║                                                  ║")
    print(f"║  Without RLM:      {format_tokens(stats['raw_tokens']):>8} tokens               ║")
    print(f"║  With RLM:         {format_tokens(stats['estimated_context_tokens']):>8} tokens               ║")
    print(f"║  Saved:            {format_tokens(stats['saved_tokens']):>8} tokens               ║")
    print("║                                                  ║")
    print(f"║  {savings_bar(stats['savings_pct'])}              ║")
    print("║                                                  ║")
    print("╠──────────────────────────────────────────────────╣")
    print("║  Pattern Breakdown                               ║")
    print("║                                                  ║")

    labels = {1: "Single-Pass", 2: "Recursive Decomposition", 3: "RLM CLI"}
    for p, count in stats["by_pattern"].items():
        if count > 0:
            print(f"║  P{p} {labels[p]:<28} {count:>4}x       ║")

    if all(c == 0 for c in stats["by_pattern"].values()):
        print("║  (no pattern-specific data)                      ║")

    print("║                                                  ║")

    if any(v > 0 for v in stats.get("by_protocol", {}).values()):
        print("╠──────────────────────────────────────────────────╣")
        print("║  Protocol Steps                                  ║")
        print("║                                                  ║")
        step_labels = {
            "rlm_metadata": "METADATA",
            "rlm_peek": "PEEK",
            "rlm_search": "SEARCH",
            "rlm_analyze": "ANALYZE (sub-queries)",
            "rlm_submit": "SUBMIT",
            "rlm_cli": "CLI (rlm-cli)",
        }
        for key, label in step_labels.items():
            count = stats["by_protocol"].get(key, 0)
            if count > 0:
                print(f"║  {label:<30} {count:>4}x       ║")
        print("║                                                  ║")

    print("╚══════════════════════════════════════════════════╝")
    print()

    # Summary line for easy copy
    ratio = stats['raw_tokens'] / max(stats['estimated_context_tokens'], 1)
    print(f"RLM saved {format_tokens(stats['saved_tokens'])} tokens ({stats['savings_pct']:.0f}% reduction, {ratio:.1f}x context efficiency)")


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "reset":
        if STATS_FILE.exists():
            STATS_FILE.unlink()
            print("Stats reset.")
        else:
            print("No stats to reset.")
        return

    events = read_events()
    stats = compute_stats(events)
    print_dashboard(stats)


if __name__ == "__main__":
    main()
