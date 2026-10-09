"""Tests for the ccache parts of ci_metrics.py:

    uv run --with pytest pytest CIMetrics
"""
from ci_metrics import ccache_job_label, ccache_rows, parse_ccache_stats, uses_ccache

# hendrikmuhs/ccache-action's post step with Ubuntu's ccache 4.5.1 (StaflLib sil-integration, Sep 18).
CCACHE_4_5 = """\
2026-09-18T17:41:07.7407139Z ##[group]ccache stats
2026-09-18T17:41:07.7411291Z [command]/usr/bin/ccache -s
2026-09-18T17:41:07.7466344Z Summary:
2026-09-18T17:41:07.7466540Z   Hits:             880 / 1074 (81.94 %)
2026-09-18T17:41:07.7466726Z     Direct:         815 / 1074 (75.88 %)
2026-09-18T17:41:07.7466901Z     Preprocessed:    65 /  259 (25.10 %)
2026-09-18T17:41:07.7467066Z   Misses:           194
2026-09-18T17:41:07.7467207Z     Direct:         259
2026-09-18T17:41:07.7467434Z     Preprocessed:   194
2026-09-18T17:41:07.7467571Z Primary storage:
2026-09-18T17:41:07.7467710Z   Hits:            1862 / 2247 (82.87 %)
2026-09-18T17:41:07.7467863Z   Misses:           385
2026-09-18T17:41:07.7468005Z   Cache size (GB): 0.44 / 0.50 (88.73 %)
2026-09-18T17:41:07.7468163Z   Cleanups:          12
2026-09-18T17:41:07.7468256Z
2026-09-18T17:41:07.7468340Z Use the -v/--verbose option for more details.
"""

# The IAR-capable ccache fork (4.12) in StaflLib's arm-cm7-iar-RelWithDebInfo build, Sep 18.
CCACHE_4_12 = """\
2026-09-18T17:38:08.6945759Z ##[group]ccache stats
2026-09-18T17:38:08.7001667Z [command]/__w/StaflLib/StaflLib/ccache/ccache -s
2026-09-18T17:38:08.7044552Z Cacheable calls:   1066 / 1066 (100.0%)
2026-09-18T17:38:08.7045437Z   Hits:            1044 / 1066 (97.94%)
2026-09-18T17:38:08.7046058Z     Direct:        1044 / 1044 (100.0%)
2026-09-18T17:38:08.7046655Z     Preprocessed:     0 / 1044 ( 0.00%)
2026-09-18T17:38:08.7047223Z   Misses:            22 / 1066 ( 2.06%)
2026-09-18T17:38:08.7047762Z Local storage:
2026-09-18T17:38:08.7048747Z   Cache size (GB):  0.1 /  0.5 (10.41%)
2026-09-18T17:38:08.7049324Z   Hits:            1044 / 1066 (97.94%)
2026-09-18T17:38:08.7049707Z   Misses:            22 / 1066 ( 2.06%)
2026-09-18T17:38:08.7054962Z [command]/__w/StaflLib/StaflLib/ccache/ccache --version
"""

# The same layout with remote storage, as ccache prints it when errors and timeouts are nonzero.
CCACHE_REMOTE = """\
2026-10-09T12:00:00.0000000Z Cacheable calls:    593 /  593 (100.0%)
2026-10-09T12:00:00.0000000Z   Hits:             590 /  593 (99.49%)
2026-10-09T12:00:00.0000000Z     Direct:         590 /  590 (100.0%)
2026-10-09T12:00:00.0000000Z     Preprocessed:     0 /  590 ( 0.00%)
2026-10-09T12:00:00.0000000Z   Misses:             3 /  593 ( 0.51%)
2026-10-09T12:00:00.0000000Z Local storage:
2026-10-09T12:00:00.0000000Z   Cache size (GB):  0.0 /  5.0 ( 0.00%)
2026-10-09T12:00:00.0000000Z Remote storage:
2026-10-09T12:00:00.0000000Z   Hits:             590 /  593 (99.49%)
2026-10-09T12:00:00.0000000Z   Misses:             3 /  593 ( 0.51%)
2026-10-09T12:00:00.0000000Z   Errors:             2
2026-10-09T12:00:00.0000000Z   Timeouts:           1
"""


def test_ccache_4_5_uses_summary_hits_not_storage_lookups():
    assert parse_ccache_stats(CCACHE_4_5) == {"hits": 880, "cacheable": 1074}


def test_ccache_4_12():
    assert parse_ccache_stats(CCACHE_4_12) == {"hits": 1044, "cacheable": 1066}


def test_remote_storage_counts():
    assert parse_ccache_stats(CCACHE_REMOTE) == {
        "hits": 590, "cacheable": 593,
        "remote_hits": 590, "remote_misses": 3, "remote_errors": 2, "remote_timeouts": 1}


def test_ccache_4_5_secondary_storage_counts_as_remote():
    cleanups = "  Cleanups:          12\n"
    assert cleanups in CCACHE_4_5
    log = CCACHE_4_5.replace(
        cleanups,
        cleanups +
        "2026-09-18T17:41:07.7468200Z Secondary storage:\n"
        "2026-09-18T17:41:07.7468200Z   Hits:             870 / 1074 (81.01 %)\n"
        "2026-09-18T17:41:07.7468200Z   Misses:           204\n"
        "2026-09-18T17:41:07.7468200Z   Errors:             4\n")
    assert parse_ccache_stats(log) == {
        "hits": 880, "cacheable": 1074, "remote_hits": 870, "remote_misses": 204, "remote_errors": 4}


def test_last_stats_block_wins():
    # Stats are cumulative within a job, so the last block is the job's total.
    assert parse_ccache_stats(CCACHE_4_12 + CCACHE_REMOTE)["hits"] == 590


def test_ansi_codes_are_stripped():
    assert parse_ccache_stats(CCACHE_4_12.replace("Cacheable", "\x1b[36mCacheable"))["cacheable"] == 1066


def test_log_without_stats():
    assert parse_ccache_stats("2026-09-18T17:38:08.0000000Z ##[error]Process completed with exit code 1.\n") is None


def test_uses_ccache():
    assert uses_ccache({"steps": [{"name": "Set up job"}, {"name": "setup ccache"}]})
    assert not uses_ccache({"steps": [{"name": "Set up job"}, {"name": "Run clang-format"}]})
    assert not uses_ccache({"steps": None})


def test_job_label_keeps_the_build_preset():
    assert ccache_job_label(
        "cpp / cpp_build / build-embedded (arm-cm7-iar, arm-cm7-iar-Debug, ubuntu-iar, ghcr.io/x:2.0.0-0)"
    ) == "cpp / cpp_build / build-embedded (arm-cm7-iar-Debug)"
    # As the API returns it: cut at 100 characters, no closing parenthesis.
    assert ccache_job_label(
        "cpp / cpp_build / build-embedded (arm-cm4f-gcc, arm-cm4f-gcc-Release, ubuntu-latest, ghcr.io/staflsystems/st"
    ) == "cpp / cpp_build / build-embedded (arm-cm4f-gcc-Release)"
    assert ccache_job_label("cpp / cpp_test / test (host, host-Debug, host-Debug, true, true)") \
        == "cpp / cpp_test / test (host-Debug)"
    assert ccache_job_label("build / build-embedded (target-Release)") == "build / build-embedded (target-Release)"
    assert ccache_job_label("cpp / sil_integration_test / sil-integration") \
        == "cpp / sil_integration_test / sil-integration"


def test_rows_count_cold_jobs_and_weight_hit_rate_by_calls():
    measured = [
        {"job": "a", "ccache_hits": 0, "ccache_cacheable": 100},
        {"job": "a", "ccache_hits": 900, "ccache_cacheable": 900},
        {"job": "b", "ccache_hits": 50, "ccache_cacheable": 100},
    ]
    assert ccache_rows(lambda r: r["job"], measured) == [
        ["a", 2, 1, "50%", "90%"],
        ["b", 1, 0, "0%", "50%"],
    ]
