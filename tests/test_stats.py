#!/usr/bin/env python3
"""Tests for stats.py — event logging and dashboard."""
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import stats


def setup_temp_stats(tmp_path):
    """Override stats file to use temp directory."""
    stats.STATS_DIR = tmp_path
    stats.STATS_FILE = tmp_path / "events.jsonl"


def test_log_event_new_types(tmp_path):
    """New event types (rlm_metadata, rlm_peek, etc.) are logged correctly."""
    setup_temp_stats(tmp_path)

    stats.log_event("rlm_metadata", "big.log", 600000, 1)
    stats.log_event("rlm_peek", "big.log", 600000, 1)
    stats.log_event("rlm_search", "big.log", 600000, 2)
    stats.log_event("rlm_analyze", "big.log", 600000, 2)
    stats.log_event("rlm_analyze", "big.log", 600000, 2)
    stats.log_event("rlm_submit", "big.log", 600000, 2)

    events = stats.read_events()
    assert len(events) == 6
    assert events[0]["event"] == "rlm_metadata"
    assert events[3]["event"] == "rlm_analyze"
    assert events[5]["event"] == "rlm_submit"


def test_compute_stats_protocol_breakdown(tmp_path):
    """compute_stats includes protocol step breakdown."""
    setup_temp_stats(tmp_path)

    stats.log_event("rlm_metadata", "a.log", 500000, 1)
    stats.log_event("rlm_peek", "a.log", 500000, 1)
    stats.log_event("rlm_search", "a.log", 500000, 2)
    stats.log_event("rlm_analyze", "a.log", 500000, 2)
    stats.log_event("rlm_analyze", "a.log", 500000, 2)
    stats.log_event("rlm_analyze", "a.log", 500000, 2)
    stats.log_event("rlm_submit", "a.log", 500000, 2)

    events = stats.read_events()
    result = stats.compute_stats(events)

    assert result["total_events"] == 7
    assert result["by_protocol"]["rlm_metadata"] == 1
    assert result["by_protocol"]["rlm_peek"] == 1
    assert result["by_protocol"]["rlm_search"] == 1
    assert result["by_protocol"]["rlm_analyze"] == 3
    assert result["by_protocol"]["rlm_submit"] == 1


def test_compute_stats_backward_compat(tmp_path):
    """Old-style events (large_file_detected) still work."""
    setup_temp_stats(tmp_path)

    stats.log_event("large_file_detected", "old.log", 1000000, 1)

    events = stats.read_events()
    result = stats.compute_stats(events)

    assert result["total_events"] == 1
    assert result["by_pattern"][1] == 1


if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as td:
        tp = Path(td)
        test_log_event_new_types(tp)
        print("PASS: test_log_event_new_types")

    with tempfile.TemporaryDirectory() as td:
        test_compute_stats_protocol_breakdown(Path(td))
        print("PASS: test_compute_stats_protocol_breakdown")

    with tempfile.TemporaryDirectory() as td:
        test_compute_stats_backward_compat(Path(td))
        print("PASS: test_compute_stats_backward_compat")
