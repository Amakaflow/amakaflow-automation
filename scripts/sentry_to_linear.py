#!/usr/bin/env python3
"""Sentry -> Linear Issue Sync

Polls Sentry for new and regressed issues, applies intelligent filtering,
and creates Linear tickets automatically. Runs on a schedule via GitHub Actions.

No human intervention required. The script tracks processed issues in a state
file so duplicates are never created.

Required environment variables:
  SENTRY_AUTH_TOKEN   Sentry auth token (scopes: org:read, project:read, event:read)
  LINEAR_API_KEY      Linear API key (no Bearer prefix)

Optional:
  SENTRY_ORG          Sentry org slug (default: me-6o)
  SENTRY_PROJECTS     Comma-separated Sentry project slugs to filter (default: all)
  LINEAR_TEAM_ID      Linear team ID (default: AmakaFlow team)
  STATE_FILE          Path to state JSON file (default: /tmp/sentry_sync_state.json)
  LOOKBACK_HOURS      How many hours back to look for new issues (default: 6)
  MIN_USERS_HANG      Min users affected for hang/ANR tickets (default: 3)
  MIN_USERS_NEW_ERROR Min users affected for new error tickets (default: 2)
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional


# ── Config ────────────────────────────────────────────────────────────────────

SENTRY_AUTH_TOKEN = os.environ["SENTRY_AUTH_TOKEN"]
LINEAR_API_KEY = os.environ["LINEAR_API_KEY"]

SENTRY_ORG = os.environ.get("SENTRY_ORG", "me-6o")
SENTRY_PROJECTS = [p.strip() for p in os.environ.get("SENTRY_PROJECTS", "").split(",") if p.strip()]
LINEAR_TEAM_ID = os.environ.get("LINEAR_TEAM_ID", "6c2d1065-85ae-4402-b8ac-64b8530dd663")
STATE_FILE = Path(os.environ.get("STATE_FILE", "/tmp/sentry_sync_state.json"))
LOOKBACK_HOURS = int(os.environ.get("LOOKBACK_HOURS", "6"))
MIN_USERS_HANG = int(os.environ.get("MIN_USERS_HANG", "3"))
MIN_USERS_NEW_ERROR = int(os.environ.get("MIN_USERS_NEW_ERROR", "2"))


# ── State ─────────────────────────────────────────────────────────────────────

def load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except Exception:
            pass
    return {"processed": {}}


def save_state(state: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2))


# ── Sentry API ────────────────────────────────────────────────────────────────

def sentry_get(path: str, params: dict = None) -> list | dict:
    url = f"https://sentry.io/api/0{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params, doseq=True)
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {SENTRY_AUTH_TOKEN}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"[sentry] HTTP {e.code} for {path}: {e.read().decode()[:200]}", file=sys.stderr)
        return []


def sentry_post(path: str, body: dict) -> None:
    url = f"https://sentry.io/api/0{path}"
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Authorization": f"Bearer {SENTRY_AUTH_TOKEN}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15):
            pass
    except urllib.error.HTTPError as e:
        print(f"[sentry] POST {path} failed: {e.code} {e.read().decode()[:200]}", file=sys.stderr)


def fetch_sentry_issues(since: datetime) -> list[dict]:
    """Fetch new + regressed issues from Sentry, deduplicated."""
    since_str = since.strftime("%Y-%m-%dT%H:%M:%S")
    queries = [
        f"is:unresolved firstSeen:>{since_str}",
        "is:regressed",
    ]

    seen_ids: set[str] = set()
    all_issues: list[dict] = []

    base_params: dict = {"limit": 100, "sort": "date"}
    if SENTRY_PROJECTS:
        base_params["project"] = SENTRY_PROJECTS

    for query in queries:
        params = {**base_params, "query": query}
        results = sentry_get(f"/organizations/{SENTRY_ORG}/issues/", params)
        if not isinstance(results, list):
            continue
        for issue in results:
            if issue["id"] not in seen_ids:
                seen_ids.add(issue["id"])
                all_issues.append(issue)

    return all_issues


def add_sentry_note(issue_id: str, linear_url: str) -> None:
    """Add a note to the Sentry issue linking back to the Linear ticket."""
    sentry_post(
        f"/organizations/{SENTRY_ORG}/issues/{issue_id}/notes/",
        {"text": f"Linear ticket auto-created: {linear_url}"},
    )


# ── Filter logic ──────────────────────────────────────────────────────────────

def should_create_ticket(issue: dict, state: dict) -> tuple[bool, str]:
    """Return (create, skip_reason). skip_reason is empty string when creating."""
    issue_id = issue["id"]

    if issue_id in state["processed"]:
        return False, "already processed"

    level = issue.get("level", "error")
    status = issue.get("status", "")
    user_count = issue.get("userCount", 0)
    title = (issue.get("title") or "").lower()

    # Crashes: always create
    if level == "fatal":
        return True, ""

    # Regressions: always create
    if status == "regressed":
        return True, ""

    # App Hangs / ANRs: only if enough real users affected
    is_hang = any(kw in title for kw in ("app hang", "anr", "application not responding", "app hanging"))
    if is_hang:
        if user_count < MIN_USERS_HANG:
            return False, f"hang only {user_count} users (min {MIN_USERS_HANG})"
        return True, ""

    # New errors: must affect at least MIN_USERS_NEW_ERROR real users
    if user_count < MIN_USERS_NEW_ERROR:
        return False, f"only {user_count} user(s) affected (min {MIN_USERS_NEW_ERROR})"

    return True, ""


# ── Linear ticket construction ────────────────────────────────────────────────

def _priority(issue: dict) -> int:
    level = issue.get("level", "error")
    status = issue.get("status", "")
    title = (issue.get("title") or "").lower()
    if level == "fatal":
        return 1  # Urgent
    if status == "regressed" or "crash" in title:
        return 2  # High
    if any(kw in title for kw in ("hang", "anr", "freeze", "deadlock")):
        return 2  # High
    return 3  # Medium


def build_title(issue: dict) -> str:
    level = issue.get("level", "error").upper()
    status = issue.get("status", "")
    project_slug = (issue.get("project") or {}).get("slug", "")
    title = (issue.get("title") or "Unknown error")[:70]
    user_count = issue.get("userCount", 0)

    tag = f"[{project_slug}] " if project_slug else ""
    status_tag = " [REGRESSION]" if status == "regressed" else ""

    return f"[Sentry] {tag}{level}{status_tag}: {title} ({user_count} users)"


def build_description(issue: dict) -> str:
    issue_id = issue["id"]
    level = issue.get("level", "error")
    status = issue.get("status", "")
    user_count = issue.get("userCount", 0)
    event_count = issue.get("count", 0)
    first_seen = issue.get("firstSeen", "")
    last_seen = issue.get("lastSeen", "")
    culprit = issue.get("culprit", "")
    project_name = (issue.get("project") or {}).get("name", "")
    metadata = issue.get("metadata") or {}
    error_value = metadata.get("value", "")
    sentry_url = f"https://sentry.io/organizations/{SENTRY_ORG}/issues/{issue_id}/"

    lines = [
        "## Sentry Issue (auto-created by sentry-linear-sync)",
        "",
        f"| Field | Value |",
        f"|---|---|",
        f"| **Project** | {project_name} |",
        f"| **Level** | {level} |",
        f"| **Status** | {status} |",
        f"| **Users affected** | {user_count} |",
        f"| **Total events** | {event_count} |",
        f"| **First seen** | {first_seen} |",
        f"| **Last seen** | {last_seen} |",
    ]
    if culprit:
        lines.append(f"| **Culprit** | `{culprit}` |")
    lines += [
        "",
        f"**Sentry issue:** {sentry_url}",
    ]
    if error_value:
        lines += ["", f"**Error message:**", f"```", error_value, "```"]
    lines += [
        "",
        "---",
        "*Auto-created by Sentry→Linear sync (AMA-1066). To suppress a class of issue, update the filter in `scripts/sentry_to_linear.py`.*",
    ]
    return "\n".join(lines)


# ── Linear API ────────────────────────────────────────────────────────────────

def linear_request(query: str, variables: dict) -> dict:
    body = json.dumps({"query": query, "variables": variables}).encode()
    req = urllib.request.Request(
        "https://api.linear.app/graphql",
        data=body,
        headers={"Authorization": LINEAR_API_KEY, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"[linear] HTTP {e.code}: {e.read().decode()[:200]}", file=sys.stderr)
        return {}


def create_linear_ticket(issue: dict) -> Optional[str]:
    """Create a Linear issue. Returns the URL or None on failure."""
    data = linear_request(
        "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { id url } } }",
        {
            "input": {
                "teamId": LINEAR_TEAM_ID,
                "title": build_title(issue),
                "description": build_description(issue),
                "priority": _priority(issue),
            }
        },
    )
    return data.get("data", {}).get("issueCreate", {}).get("issue", {}).get("url")


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    state = load_state()
    since = datetime.now(timezone.utc) - timedelta(hours=LOOKBACK_HOURS)

    print(f"[sync] Looking back {LOOKBACK_HOURS}h (since {since.strftime('%Y-%m-%d %H:%M UTC')})")
    print(f"[sync] Org: {SENTRY_ORG}  Projects: {SENTRY_PROJECTS or 'all'}")

    issues = fetch_sentry_issues(since)
    print(f"[sync] Fetched {len(issues)} candidate issue(s) from Sentry")

    created = 0
    skipped = 0

    for issue in issues:
        issue_id = issue["id"]
        short_title = (issue.get("title") or "")[:60]

        ok, reason = should_create_ticket(issue, state)

        if not ok:
            print(f"  [skip] {issue_id}: {short_title!r} — {reason}")
            # Mark as seen so we don't re-check on next run
            if issue_id not in state["processed"]:
                state["processed"][issue_id] = None
            skipped += 1
            continue

        print(f"  [create] {issue_id}: {short_title!r}")
        linear_url = create_linear_ticket(issue)

        if linear_url:
            state["processed"][issue_id] = linear_url
            add_sentry_note(issue_id, linear_url)
            created += 1
            print(f"    -> {linear_url}")
        else:
            print(f"    -> ERROR: Linear creation failed", file=sys.stderr)

        # Save state after each issue so progress isn't lost on crash
        save_state(state)

    print(f"\n[sync] Done — created: {created}, skipped: {skipped}")


if __name__ == "__main__":
    main()
