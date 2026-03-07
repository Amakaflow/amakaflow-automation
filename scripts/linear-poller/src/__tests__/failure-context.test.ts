/**
 * Tests for getLatestFailureComment parsing and buildTaskPrompt with failure context.
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";

// ---------------------------------------------------------------------------
// Helpers — inline the parsing logic to test it independently
// ---------------------------------------------------------------------------

function parseFailureBlock(commentBody: string): {
  failedStep: string;
  branchName: string;
  runUrl: string;
  retryCount: number;
  fullCommentBody: string;
} | null {
  if (!commentBody.includes("FAILURE_CONTEXT_START")) return null;

  const match = commentBody.match(
    /FAILURE_CONTEXT_START\n([\s\S]*?)\nFAILURE_CONTEXT_END/
  );
  if (!match) return null;

  const block = match[1];
  const parsed: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    parsed[key] = value;
  }

  const retryCount = parseInt(parsed["retry_count"] ?? "0", 10);
  return {
    failedStep: parsed["failed_step"] ?? "",
    branchName: parsed["branch_name"] ?? "",
    runUrl: parsed["run_url"] ?? "",
    retryCount: isNaN(retryCount) ? 0 : retryCount,
    fullCommentBody: commentBody,
  };
}

/**
 * Mirrors the logic inside LinearClient.getLatestFailureComment
 * but operates on an in-memory array of comment bodies (oldest-first).
 */
function findLatestFailureComment(
  commentBodies: string[]
): ReturnType<typeof parseFailureBlock> {
  const reversed = [...commentBodies].reverse();
  for (const body of reversed) {
    const result = parseFailureBlock(body);
    if (result) return result;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_FAILURE_COMMENT = `**CI failed** on \`amakaflow-backend\` — step: \`test\`
[retry:2/3]

[View run](https://github.com/Amakaflow/amakaflow-backend/actions/runs/12345)

\`\`\`
FAILED tests/test_mapper.py::test_map_exercise - AssertionError
\`\`\`

<!-- FAILURE_CONTEXT_START
failed_step: test
branch_name: feat/ama-626-self-healing
run_url: https://github.com/Amakaflow/amakaflow-backend/actions/runs/12345
retry_count: 2
FAILURE_CONTEXT_END -->`;

const PLAIN_COMMENT = `✅ **Antfarm completed** this ticket and pushed to branch.

- Branch: \`agent/AMA-626-foo\`
- Duration: 42s`;

// ---------------------------------------------------------------------------
// Tests: getLatestFailureComment (parsing logic)
// ---------------------------------------------------------------------------

describe("getLatestFailureComment", () => {
  it("returns null when no comments contain FAILURE_CONTEXT_START", () => {
    const result = findLatestFailureComment([PLAIN_COMMENT, PLAIN_COMMENT]);
    expect(result).toBeNull();
  });

  it("parses structured block correctly from a mock comment", () => {
    const result = findLatestFailureComment([SAMPLE_FAILURE_COMMENT]);
    expect(result).not.toBeNull();
    expect(result!.failedStep).toBe("test");
    expect(result!.branchName).toBe("feat/ama-626-self-healing");
    expect(result!.runUrl).toBe(
      "https://github.com/Amakaflow/amakaflow-backend/actions/runs/12345"
    );
    expect(result!.retryCount).toBe(2);
    expect(result!.fullCommentBody).toBe(SAMPLE_FAILURE_COMMENT);
  });

  it("returns null when comments array is empty", () => {
    const result = findLatestFailureComment([]);
    expect(result).toBeNull();
  });

  it("picks the most recent failure comment when multiple exist", () => {
    const olderComment = `<!-- FAILURE_CONTEXT_START
failed_step: build
branch_name: feat/ama-626-old-branch
run_url: https://github.com/Amakaflow/amakaflow-backend/actions/runs/11111
retry_count: 1
FAILURE_CONTEXT_END -->`;

    const newerComment = `<!-- FAILURE_CONTEXT_START
failed_step: lint
branch_name: feat/ama-626-new-branch
run_url: https://github.com/Amakaflow/amakaflow-backend/actions/runs/22222
retry_count: 2
FAILURE_CONTEXT_END -->`;

    // Oldest first (as Linear returns them)
    const result = findLatestFailureComment([olderComment, newerComment]);
    expect(result).not.toBeNull();
    expect(result!.failedStep).toBe("lint");
    expect(result!.retryCount).toBe(2);
  });

  it("handles a comment with only the marker block and no human-readable prefix", () => {
    const minimal = `<!-- FAILURE_CONTEXT_START
failed_step: build
branch_name: agent/AMA-100-test
run_url: https://github.com/org/repo/actions/runs/99
retry_count: 1
FAILURE_CONTEXT_END -->`;

    const result = parseFailureBlock(minimal);
    expect(result).not.toBeNull();
    expect(result!.failedStep).toBe("build");
    expect(result!.retryCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: buildTaskPrompt with failure context
// ---------------------------------------------------------------------------

/**
 * Inline version of the prompt-building logic from poller.ts for unit testing.
 */
function buildBasePrompt(issue: {
  identifier: string;
  title: string;
  description: string;
  url: string;
}): string {
  const maxDescLen = 8000;
  const desc =
    issue.description.length > maxDescLen
      ? issue.description.slice(0, maxDescLen) + "\n\n[description truncated]"
      : issue.description;

  const slug = issue.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);

  return [
    `Linear ticket: ${issue.identifier} — ${issue.title}`,
    `URL: ${issue.url}`,
    "",
    "## Description",
    desc,
    "",
    "## Instructions",
    "- Follow the ticket description exactly",
    `- Create a branch named \`agent/${issue.identifier}-${slug}\``,
    `- Push your changes to this branch (use \`git push -u origin agent/${issue.identifier}-${slug}\`)`,
    "- Commit your work with a message referencing the ticket ID",
    "- If the ticket references specific files, only modify those files",
    "- Run any relevant tests before finishing",
    "- When done, output the branch name in format: `Branch: agent/<ticket>-<slug>` so it can be tracked",
  ].join("\n");
}

function appendFailureContext(
  baseTask: string,
  failureComment: NonNullable<ReturnType<typeof parseFailureBlock>>
): string {
  const logsMatch = failureComment.fullCommentBody.match(/```\n([\s\S]*?)\n```/);
  const failureLogs = logsMatch ? logsMatch[1].slice(-2000) : "";
  return [
    baseTask,
    "",
    "---",
    `PREVIOUS ATTEMPT FAILED (attempt ${failureComment.retryCount}):`,
    `Step that failed: ${failureComment.failedStep}`,
    `Existing branch: ${failureComment.branchName} — IMPORTANT: Check out this existing branch and make targeted fixes. Do not create a new branch.`,
    `CI run: ${failureComment.runUrl}`,
    "",
    "What went wrong:",
    failureLogs,
    "---",
    "Please fix the specific issues above. Make targeted changes only — do not rewrite working code.",
  ].join("\n");
}

const SAMPLE_ISSUE = {
  identifier: "AMA-626",
  title: "Self-healing retries",
  description: "Implement self-healing retry logic with failure context.",
  url: "https://linear.app/amakaflow/issue/AMA-626",
};

describe("buildTaskPrompt with failure context", () => {
  it("returns plain ticket description on first attempt (no failure comment)", () => {
    const prompt = buildBasePrompt(SAMPLE_ISSUE);
    expect(prompt).toContain("Linear ticket: AMA-626");
    expect(prompt).toContain("## Description");
    expect(prompt).not.toContain("PREVIOUS ATTEMPT FAILED");
    expect(prompt).not.toContain("IMPORTANT: Check out this existing branch");
  });

  it("appends failure context block on retry", () => {
    const failureComment = parseFailureBlock(SAMPLE_FAILURE_COMMENT)!;
    const base = buildBasePrompt(SAMPLE_ISSUE);
    const prompt = appendFailureContext(base, failureComment);

    expect(prompt).toContain("Linear ticket: AMA-626");
    expect(prompt).toContain("PREVIOUS ATTEMPT FAILED (attempt 2)");
    expect(prompt).toContain("Step that failed: test");
    expect(prompt).toContain(
      "Please fix the specific issues above. Make targeted changes only — do not rewrite working code."
    );
  });

  it("includes branch reuse instruction in retry prompt", () => {
    const failureComment = parseFailureBlock(SAMPLE_FAILURE_COMMENT)!;
    const base = buildBasePrompt(SAMPLE_ISSUE);
    const prompt = appendFailureContext(base, failureComment);

    expect(prompt).toContain(
      "Existing branch: feat/ama-626-self-healing — IMPORTANT: Check out this existing branch and make targeted fixes. Do not create a new branch."
    );
  });

  it("includes the CI run URL in retry prompt", () => {
    const failureComment = parseFailureBlock(SAMPLE_FAILURE_COMMENT)!;
    const base = buildBasePrompt(SAMPLE_ISSUE);
    const prompt = appendFailureContext(base, failureComment);

    expect(prompt).toContain(
      "CI run: https://github.com/Amakaflow/amakaflow-backend/actions/runs/12345"
    );
  });

  it("extracts failure log snippet from the comment body", () => {
    const failureComment = parseFailureBlock(SAMPLE_FAILURE_COMMENT)!;
    const base = buildBasePrompt(SAMPLE_ISSUE);
    const prompt = appendFailureContext(base, failureComment);

    expect(prompt).toContain("FAILED tests/test_mapper.py::test_map_exercise");
  });

  it("produces empty failure logs when comment has no code fence", () => {
    const noLogComment = `<!-- FAILURE_CONTEXT_START
failed_step: build
branch_name: feat/ama-626-test
run_url: https://github.com/org/repo/actions/runs/1
retry_count: 1
FAILURE_CONTEXT_END -->`;

    const failureComment = parseFailureBlock(noLogComment)!;
    const base = buildBasePrompt(SAMPLE_ISSUE);
    const prompt = appendFailureContext(base, failureComment);

    // Should still have the structure, just empty logs section
    expect(prompt).toContain("What went wrong:");
    expect(prompt).toContain("---");
  });
});
