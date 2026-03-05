#!/usr/bin/env python3
"""
rlm-fetch — Download a URL to a temp file without polluting context.

Only metadata (status, content-type, size, output path) is printed to stdout.
The raw response body stays in the file for external processing.

Usage:
  python fetch.py <url> [-o /tmp/output.json] [--headers "Accept:application/json"]
"""

import argparse
import hashlib
import json
import os
import sys
import tempfile
from datetime import datetime


def md5_short(s):
    return hashlib.md5(s.encode()).hexdigest()[:10]


def guess_extension(content_type, url):
    """Guess file extension from content-type or URL."""
    ct = (content_type or "").split(";")[0].strip().lower()
    ext_map = {
        "application/json": ".json",
        "text/html": ".html",
        "text/plain": ".txt",
        "text/csv": ".csv",
        "application/xml": ".xml",
        "text/xml": ".xml",
        "application/pdf": ".pdf",
    }
    if ct in ext_map:
        return ext_map[ct]
    # Try URL path
    path = url.split("?")[0].split("#")[0]
    if "." in path.split("/")[-1]:
        ext = "." + path.split("/")[-1].rsplit(".", 1)[-1]
        if len(ext) <= 6:
            return ext
    return ".bin"


def fetch_with_requests(url, headers, timeout):
    """Fetch using requests library."""
    import requests
    resp = requests.get(url, headers=headers, timeout=timeout, stream=True)
    return resp.status_code, dict(resp.headers), resp.iter_content(chunk_size=8192)


def fetch_with_urllib(url, headers, timeout):
    """Fetch using stdlib urllib (fallback)."""
    from urllib.request import Request, urlopen
    req = Request(url)
    for k, v in headers.items():
        req.add_header(k, v)
    resp = urlopen(req, timeout=timeout)
    status = resp.getcode()
    resp_headers = dict(resp.headers)

    def chunks():
        while True:
            chunk = resp.read(8192)
            if not chunk:
                break
            yield chunk
    return status, resp_headers, chunks()


def fetch(url, output_path=None, headers=None, timeout=30):
    """Fetch URL to file. Returns metadata dict."""
    headers = headers or {}
    if "User-Agent" not in headers:
        headers["User-Agent"] = "rlm-fetch/0.2.1"

    # Try requests first, fall back to urllib
    try:
        status, resp_headers, chunks = fetch_with_requests(url, headers, timeout)
    except ImportError:
        status, resp_headers, chunks = fetch_with_urllib(url, headers, timeout)

    content_type = resp_headers.get("Content-Type", resp_headers.get("content-type", ""))

    # Determine output path
    if not output_path:
        ext = guess_extension(content_type, url)
        fname = "rlm_fetch_" + md5_short(url) + ext
        output_path = os.path.join(tempfile.gettempdir(), fname)

    # Stream to file
    total = 0
    with open(output_path, "wb") as f:
        for chunk in chunks:
            f.write(chunk)
            total += len(chunk)

    return {
        "url": url,
        "status": status,
        "content_type": content_type.split(";")[0].strip(),
        "size_bytes": total,
        "output_path": output_path,
    }


def log_stats(url, size_bytes):
    """Log fetch event to RLM stats for the dashboard."""
    try:
        stats_dir = os.path.join(os.path.expanduser("~"), ".rlm", "stats")
        if not os.path.isdir(stats_dir):
            os.makedirs(stats_dir)
        entry = {
            "ts": datetime.now().isoformat(),
            "event": "rlm_fetch",
            "file": url,
            "size_bytes": size_bytes,
            "pattern": 1,
        }
        stats_file = os.path.join(stats_dir, "events.jsonl")
        with open(stats_file, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass  # Stats logging is best-effort


def format_size(n):
    if n >= 1024 * 1024:
        return "%.1fMB" % (n / (1024.0 * 1024.0))
    if n >= 1024:
        return "%.1fKB" % (n / 1024.0)
    return "%dB" % n


def main():
    parser = argparse.ArgumentParser(description="RLM Fetch — download URL to temp file")
    parser.add_argument("url", help="URL to fetch")
    parser.add_argument("-o", "--output", help="Output file path (default: auto temp file)")
    parser.add_argument("--headers", nargs="*", default=[], help="Headers as key:value pairs")
    parser.add_argument("--timeout", type=int, default=30, help="Request timeout in seconds")
    args = parser.parse_args()

    headers = {}
    for h in args.headers:
        if ":" in h:
            k, v = h.split(":", 1)
            headers[k.strip()] = v.strip()

    try:
        meta = fetch(args.url, output_path=args.output, headers=headers, timeout=args.timeout)
    except Exception as e:
        print("FETCH FAILED: %s" % str(e), file=sys.stderr)
        sys.exit(1)

    # Log to RLM stats dashboard
    log_stats(meta["url"], meta["size_bytes"])

    # Only this metadata enters context
    print("Fetched: %s" % meta["url"])
    print("Status:  %d" % meta["status"])
    print("Type:    %s" % meta["content_type"])
    print("Size:    %s" % format_size(meta["size_bytes"]))
    print("Saved:   %s" % meta["output_path"])
    print()
    print("Process with:")
    print('  python3 -c "')
    print("  with open('%s') as f:" % meta["output_path"])
    print("      data = f.read()")
    print("  # extract what you need, print only the summary")
    print('  "')


if __name__ == "__main__":
    main()
