# /// script
# requires-python = ">=3.11"
# ///
"""Weekly job-level CI minutes report for the CI spend RFC.

Fetches every workflow run created in a date range, every job of those runs, and the draft/ready
history of their PRs, then bills each job the way GitHub does (its duration rounded up to the
minute) and splits the minutes by runner and by PR state at the time the run was created.

    uv run CIMetrics/ci_metrics.py StaflLib coit-tower-bms2000 --since 2026-09-17 --until 2026-09-23

Needs an authenticated `gh`. Raw API responses are cached under --out, so a rerun only fetches
what is missing.
"""
import argparse
import collections
import concurrent.futures
import datetime as dt
import json
import math
import os
import re
import subprocess
import sys

OWNER = "StaflSystems"
# Per-minute prices the billing API reports for Sep 2026. Only the 8-core runner is paid today;
# the rest is covered by the included minutes.
PRICE = {"ubuntu-medium (8-core)": 0.022, "linux-2core": 0.006, "windows": 0.010, "macos": 0.062}
PR_FIELDS = """number isDraft createdAt closedAt headRefName baseRefName
  timelineItems(itemTypes: [READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT], first: 100) {
    nodes { __typename ... on ReadyForReviewEvent { createdAt } ... on ConvertToDraftEvent { createdAt } }
  }"""


def gh(*args):
    out = subprocess.run(["gh", *args], capture_output=True, text=True)
    if out.returncode:
        raise RuntimeError(f"gh {' '.join(args)}: {out.stderr.strip()}")
    return out.stdout


def gh_lines(path, jq):
    return [json.loads(l) for l in gh("api", path, "--paginate", "--jq", jq).splitlines() if l.strip()]


def cached(path, fetch):
    if os.path.exists(path):
        return json.load(open(path))
    data = fetch()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".tmp", "w") as f:
        json.dump(data, f)
    os.replace(path + ".tmp", path)
    return data


def days(since, until):
    d = since
    while d <= until:
        yield d.isoformat()
        d += dt.timedelta(days=1)


def fetch_runs(repo, since, until, out):
    # The runs API returns at most 1,000 runs per query, so query one UTC day at a time.
    runs = []
    for day in days(since, until):
        runs += cached(f"{out}/{repo}/runs/{day}.json",
                       lambda: gh_lines(f"repos/{OWNER}/{repo}/actions/runs?created={day}&per_page=100",
                                        ".workflow_runs[]"))
    return runs


def fetch_jobs(repo, runs, out):
    def one(run):
        return run["id"], cached(f"{out}/{repo}/jobs/{run['id']}.json",
                                 lambda: gh_lines(f"repos/{OWNER}/{repo}/actions/runs/{run['id']}/jobs"
                                                  "?per_page=100&filter=all", ".jobs[]"))
    with concurrent.futures.ThreadPoolExecutor(8) as pool:
        return dict(pool.map(one, runs))


def graphql_batch(repo, selections):
    """selections: {alias: graphql field}; returns {alias: result}."""
    body = "\n".join(f"{a}: {s}" for a, s in selections.items())
    q = f'query {{ repository(owner: "{OWNER}", name: "{repo}") {{ {body} }} }}'
    return json.loads(gh("api", "graphql", "-f", f"query={q}"))["data"]["repository"]


def fetch_prs(repo, runs, since, until, out):
    """PRs behind the pull_request runs, with their draft/ready transitions."""
    def load():
        numbers = {p["number"] for r in runs if r["event"] == "pull_request" for p in r["pull_requests"]}
        branches = {r["head_branch"] for r in runs if r["event"] == "pull_request" and not r["pull_requests"]}
        sel = {f"n{n}": f"pullRequest(number: {n}) {{ {PR_FIELDS} }}" for n in sorted(numbers)}
        sel |= {f"b{i}": f'pullRequests(headRefName: {json.dumps(b)}, first: 10) {{ nodes {{ {PR_FIELDS} }} }}'
                for i, b in enumerate(sorted(branches))}
        prs = {}
        items = list(sel.items())
        for i in range(0, len(items), 25):
            for v in graphql_batch(repo, dict(items[i:i + 25])).values():
                for p in (v["nodes"] if v and "nodes" in v else [v] if v else []):
                    prs[p["number"]] = p
        return list(prs.values())
    return cached(f"{out}/{repo}/prs_{since}_{until}.json", load)


TIMESTAMP = re.compile(r"^\d{4}-\d\d-\d\dT[\d:.]+Z ")
ANSI = re.compile(r"\x1b\[[0-9;]*m")
RATIO = r"\s+(\d+)\s*/\s*(\d+)"


def parse_ccache_stats(log):
    """Hits and cacheable calls from the last `ccache -s` in a job log, or None if it has none.

    Handles ccache 4.5's "Summary:" layout and the "Cacheable calls:" layout of 4.6 and later.
    The first Hits line of the block counts each cacheable call once; the per-storage Hits lines
    below it count lookups. Remote errors and timeouts appear only when nonzero. ccache 4.5 calls
    remote storage "Secondary storage".
    """
    lines = [TIMESTAMP.sub("", ANSI.sub("", l)) for l in log.splitlines()]
    starts = [i for i, l in enumerate(lines) if l.startswith(("Summary:", "Cacheable calls:"))]
    if not starts:
        return None
    stats, section = {}, None
    for line in lines[starts[-1]:]:
        if line.startswith(("[command]", "##[", "Use the -v")) or not line.strip():
            break
        if not line.startswith(" "):
            section = line.strip().rstrip(":")
        elif (m := re.match(r"\s+Hits:" + RATIO, line)) and "hits" not in stats:
            stats["hits"], stats["cacheable"] = int(m.group(1)), int(m.group(2))
        elif section in ("Remote storage", "Secondary storage") and (m := re.match(r"\s+(Hits|Misses|Errors|Timeouts):\s+(\d+)", line)):
            stats[f"remote_{m.group(1).lower()}"] = int(m.group(2))
    return stats if "hits" in stats else None


def uses_ccache(job):
    return any("ccache" in (s.get("name") or "").lower() for s in job.get("steps") or [])


def fetch_ccache(repo, jobs, out):
    """ccache stats for every completed job with a ccache step.

    Returns ({job id: stats, or None if the log has no stats}, number of logs that couldn't be
    fetched). Only the parsed stats are cached; a log that can't be fetched (expired, or an API
    error) is retried on the next run.
    """
    def one(job):
        path = f"{out}/{repo}/ccache/{job['id']}.json"
        if os.path.exists(path):
            return job["id"], json.load(open(path))
        try:
            # Build logs carry color codes; gh refuses to print them without this flag.
            log = gh("api", "--allow-escape-sequences", f"repos/{OWNER}/{repo}/actions/jobs/{job['id']}/logs")
        except RuntimeError as e:
            print(f"{repo}: no log for job {job['id']}: {e}", file=sys.stderr)
            return job["id"], "unavailable"
        stats = parse_ccache_stats(log)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path + ".tmp", "w") as f:
            json.dump(stats, f)
        os.replace(path + ".tmp", path)
        return job["id"], stats

    todo = [j for js in jobs.values() for j in js
            if uses_ccache(j) and j.get("conclusion") in ("success", "failure")]
    with concurrent.futures.ThreadPoolExecutor(8) as pool:
        results = dict(pool.map(one, todo))
    unavailable = [k for k, v in results.items() if v == "unavailable"]
    for k in unavailable:
        del results[k]
    return results, len(unavailable)


def ccache_job_label(name):
    """Job name with its matrix values cut down to the build preset, e.g.
    "cpp / cpp_build / build-embedded (arm-cm7-iar-Debug)". GitHub cuts job names at 100 characters,
    so the closing parenthesis may be missing."""
    m = re.match(r"(.*?)\s*\((.*?)\)?\s*$", name)
    if not m:
        return name
    items = [i.strip() for i in m.group(2).split(",")]
    preset = next((i for i in items if re.search(r"-(Debug|Release|RelWithDebInfo|MinSizeRel)$", i)), items[0])
    return f"{m.group(1)} ({preset})"


def runner_type(job):
    labels = [l.lower() for l in job.get("labels") or []]
    group = job.get("runner_group_name") or ""
    if any(l.startswith("ubuntu-iar") for l in labels) or "self-hosted" in labels \
            or (group and group not in ("GitHub Actions", "largerrunners")):
        return "self-hosted"
    if "ubuntu-medium" in labels or group == "largerrunners":
        return "ubuntu-medium (8-core)"
    if any(l.startswith("windows") for l in labels):
        return "windows"
    if any(l.startswith("macos") for l in labels):
        return "macos"
    if any(l.startswith("ubuntu") for l in labels):
        return "linux-2core"
    return "no runner"


def billed_minutes(job):
    """Duration rounded up to the minute; 0 if skipped, never started, or never given a runner."""
    if job.get("conclusion") == "skipped" or not job.get("started_at") or not job.get("completed_at") \
            or not job.get("runner_name"):
        return 0
    secs = (ts(job["completed_at"]) - ts(job["started_at"])).total_seconds()
    return math.ceil(secs / 60) if secs > 0 else 0


def ts(s):
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))


def was_draft(pr, at):
    """Draft state at time `at`, rebuilt from ReadyForReview / ConvertToDraft events."""
    events = sorted((e["createdAt"], e["__typename"]) for e in pr["timelineItems"]["nodes"])
    if not events:
        return pr["isDraft"]
    draft = events[0][1] == "ReadyForReviewEvent"  # the first transition gives the starting state
    for when, kind in events:
        if when <= at:
            draft = kind == "ConvertToDraftEvent"
    return draft


def pr_state(run, pr_for):
    if run["event"] != "pull_request":
        return "push to main/dev" if run["event"] == "push" else run["event"]
    if run["head_branch"].startswith("gtmq_"):
        return "merge queue"
    pr = pr_for(run)
    if not pr:
        return "PR not found"
    return "draft PR" if was_draft(pr, run["created_at"]) else "ready PR"


def md_table(headers, rows):
    lines = ["| " + " | ".join(headers) + " |", "|" + "---|" * len(headers)]
    lines += ["| " + " | ".join(str(c) for c in r) + " |" for r in rows]
    return "\n".join(lines)


def base_kind(run, pr_for):
    """Whether a PR run's PR targets main/dev or another PR's branch. Uses the PR's base branch now,
    not at run time: Graphite retargets a PR to main once the PR below it merges."""
    if run["event"] != "pull_request" or run["head_branch"].startswith("gtmq_"):
        return ""
    base = (pr_for(run) or {}).get("baseRefName")
    if not base:
        return "base unknown"
    return "on main/dev" if base == "main" or base.startswith("dev") else "stacked"


def ccache_rows(key, measured):
    """[key, jobs, jobs with no hits, share with no hits, hit rate] per group, biggest group first."""
    groups = collections.defaultdict(list)
    for r in measured:
        groups[key(r)].append(r)
    rows = []
    for k, rs in sorted(groups.items(), key=lambda x: -len(x[1])):
        cold = sum(1 for r in rs if r["ccache_hits"] == 0)
        cacheable = sum(r["ccache_cacheable"] for r in rs)
        rate = f"{100 * sum(r['ccache_hits'] for r in rs) / cacheable:.0f}%" if cacheable else "—"
        rows.append([k, len(rs), cold, f"{100 * cold / len(rs):.0f}%", rate])
    return rows


def ccache_section(flat, ccache, unavailable):
    measured = [r for r in flat if isinstance(r["ccache_cacheable"], int) and r["ccache_cacheable"] > 0]
    no_stats = sum(1 for v in ccache.values() if v is None)
    out = ["", "### ccache", "",
           f"{len(measured):,} jobs with ccache stats. {no_stats:,} logs had none (usually a job that failed "
           f"before the stats step) and {unavailable:,} logs couldn't be fetched. A job with no hits started "
           "with an empty cache. Hit rate is hits over cacheable calls, summed over the jobs."]
    if not measured:
        return out
    headers = ["Jobs", "No hits", "Share with no hits", "Hit rate"]
    out += ["", md_table(["Job"] + headers, ccache_rows(lambda r: ccache_job_label(r["job"]), measured))]
    by_state = ccache_rows(lambda r: f"{r['state']}, {r['base']}" if r["base"] else r["state"], measured)
    out += ["", "By PR state at run time and the PR's current base:", "", md_table(["State"] + headers, by_state)]
    errors = sum(ccache[r["job_id"]].get("remote_errors", 0) for r in measured)
    timeouts = sum(ccache[r["job_id"]].get("remote_timeouts", 0) for r in measured)
    remote = sum(1 for r in measured if "remote_hits" in ccache[r["job_id"]])
    if remote:
        out += ["", f"{remote:,} jobs used remote storage, with {errors:,} errors and {timeouts:,} timeouts."]
    return out


def report(repo, runs, jobs, prs, ccache=None, unavailable=0):
    by_number = {p["number"]: p for p in prs}
    by_branch = collections.defaultdict(list)
    for p in prs:
        by_branch[p["headRefName"]].append(p)

    def pr_for(run):
        for p in run["pull_requests"]:
            if p["number"] in by_number:
                return by_number[p["number"]]
        live = [p for p in by_branch[run["head_branch"]]
                if p["createdAt"] <= run["created_at"] and (not p["closedAt"] or p["closedAt"] >= run["created_at"])]
        return max(live, key=lambda p: p["createdAt"]) if live else None

    flat = []
    for run in runs:
        state, base = pr_state(run, pr_for), base_kind(run, pr_for)
        for j in jobs[run["id"]]:
            stats = (ccache or {}).get(j["id"]) or {}
            flat.append(dict(run_id=run["id"], job_id=j["id"], workflow=run["name"], event=run["event"],
                             state=state, base=base, job=j["name"], norm=re.sub(r"\s*\(.*\)\s*$", "", j["name"]),
                             runner=runner_type(j), conclusion=j.get("conclusion"), billed=billed_minutes(j),
                             ccache_hits=stats.get("hits", ""), ccache_cacheable=stats.get("cacheable", "")))

    by_runner = collections.Counter()
    for r in flat:
        by_runner[r["runner"]] += r["billed"]
    rows = [[k, f"{v:,}", f"${v * PRICE[k]:,.2f}" if k in PRICE else "—"]
            for k, v in by_runner.most_common() if v]
    out = [f"## {repo}", "", f"{len(runs):,} runs, {len(flat):,} jobs.", "",
           "### Billed minutes by runner", "", md_table(["Runner", "Billed min", "At list price"], rows)]

    paid = "ubuntu-medium (8-core)"
    by_state = collections.Counter()
    for r in flat:
        if r["runner"] == paid:
            by_state[r["state"]] += r["billed"]
    total = sum(by_state.values()) or 1
    rows = [[k, f"{v:,}", f"{100 * v / total:.0f}%", f"${v * PRICE[paid]:,.2f}"] for k, v in by_state.most_common()]
    out += ["", "### 8-core minutes by PR state at run time", "",
            md_table(["State", "8-core min", "Share", "Cost"], rows)]

    by_job = collections.defaultdict(lambda: [0, set()])
    for r in flat:
        by_job[r["norm"]][0] += r["billed"]
        by_job[r["norm"]][1].add(r["runner"])
    repo_total = sum(v[0] for v in by_job.values()) or 1
    rows = [[k.replace("|", "/"), f"{b:,}", f"{100 * b / repo_total:.0f}%", ", ".join(sorted(s))]
            for k, (b, s) in sorted(by_job.items(), key=lambda x: -x[1][0])[:15]]
    out += ["", "### Biggest jobs", "", md_table(["Job", "Billed min", "Share of repo", "Runner"], rows)]
    if ccache is not None:
        out += ccache_section(flat, ccache, unavailable)
    return "\n".join(out), flat


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("repos", nargs="+", help="repository names in the StaflSystems org")
    ap.add_argument("--since", required=True, type=dt.date.fromisoformat, help="first day, UTC (YYYY-MM-DD)")
    ap.add_argument("--until", required=True, type=dt.date.fromisoformat, help="last day, UTC, inclusive")
    ap.add_argument("--out", default="ci-metrics-data", help="cache and output directory")
    ap.add_argument("--ccache", action="store_true",
                    help="also report ccache hit rates, read from the log of every job with a ccache step")
    args = ap.parse_args()

    sections = [f"# CI minutes, {args.since} to {args.until} (UTC)", ""]
    for repo in args.repos:
        print(f"{repo}: fetching runs", file=sys.stderr)
        runs = fetch_runs(repo, args.since, args.until, args.out)
        print(f"{repo}: fetching jobs for {len(runs)} runs", file=sys.stderr)
        jobs = fetch_jobs(repo, runs, args.out)
        prs = fetch_prs(repo, runs, args.since, args.until, args.out)
        ccache, unavailable = None, 0
        if args.ccache:
            print(f"{repo}: fetching logs of jobs with a ccache step", file=sys.stderr)
            ccache, unavailable = fetch_ccache(repo, jobs, args.out)
        text, flat = report(repo, runs, jobs, prs, ccache, unavailable)
        sections += [text, ""]
        with open(f"{args.out}/{repo}/jobs.tsv", "w") as f:
            f.write("\t".join(flat[0]) + "\n")
            f.writelines("\t".join(str(v) for v in r.values()) + "\n" for r in flat)
    path = f"{args.out}/report_{args.since}_{args.until}.md"
    open(path, "w").write("\n".join(sections))
    print("\n".join(sections))
    print(f"wrote {path}", file=sys.stderr)


if __name__ == "__main__":
    main()
