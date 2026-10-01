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
PR_FIELDS = """number isDraft createdAt closedAt headRefName
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


def fetch_prs(repo, runs, out):
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
    return cached(f"{out}/{repo}/prs.json", load)


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


def report(repo, runs, jobs, prs):
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
        state = pr_state(run, pr_for)
        for j in jobs[run["id"]]:
            flat.append(dict(run_id=run["id"], workflow=run["name"], event=run["event"], state=state,
                             job=j["name"], norm=re.sub(r"\s*\(.*\)\s*$", "", j["name"]),
                             runner=runner_type(j), conclusion=j.get("conclusion"), billed=billed_minutes(j)))

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
    return "\n".join(out), flat


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("repos", nargs="+", help="repository names in the StaflSystems org")
    ap.add_argument("--since", required=True, type=dt.date.fromisoformat, help="first day, UTC (YYYY-MM-DD)")
    ap.add_argument("--until", required=True, type=dt.date.fromisoformat, help="last day, UTC, inclusive")
    ap.add_argument("--out", default="ci-metrics-data", help="cache and output directory")
    args = ap.parse_args()

    sections = [f"# CI minutes, {args.since} to {args.until} (UTC)", ""]
    for repo in args.repos:
        print(f"{repo}: fetching runs", file=sys.stderr)
        runs = fetch_runs(repo, args.since, args.until, args.out)
        print(f"{repo}: fetching jobs for {len(runs)} runs", file=sys.stderr)
        jobs = fetch_jobs(repo, runs, args.out)
        prs = fetch_prs(repo, runs, args.out)
        text, flat = report(repo, runs, jobs, prs)
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
