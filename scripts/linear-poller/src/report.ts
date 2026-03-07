#!/usr/bin/env tsx
/**
 * Daily failure report generator.
 * Reads poller-state.json and generates a summary of recent activity.
 *
 * Usage:
 *   npx tsx src/report.ts              # Print to stdout
 *   npx tsx src/report.ts --write      # Write to ~/.openclaw/reports/linear-poller-<date>.md
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { PollerState, JobRecord, Metrics } from "./state.js";

const stateFile = process.env.STATE_FILE || "./poller-state.json";
const reportDir = join(process.env.HOME || "~", ".openclaw", "reports");

function loadState(): PollerState | null {
  if (!existsSync(stateFile)) return null;
  try {
    return JSON.parse(readFileSync(stateFile, "utf-8"));
  } catch {
    return null;
  }
}

function formatMetrics(metrics: Metrics): string[] {
  const lines: string[] = [
    "## Self-Healing Metrics",
    "",
    `| Metric | Count |`,
    `|--------|-------|`,
    `| Total attempts | ${metrics.totalAttempts} |`,
    `| First-pass successes | ${metrics.firstPassSuccesses} |`,
    `| Self-heal successes | ${metrics.selfHealSuccesses} |`,
    `| Human interventions | ${metrics.humanInterventions} |`,
    "",
  ];

  const categories = Object.entries(metrics.failureCategories);
  if (categories.length > 0) {
    lines.push("### Failure Categories", "");
    lines.push(`| Step | Count |`);
    lines.push(`|------|-------|`);
    for (const [step, count] of categories.sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${step} | ${count} |`);
    }
    lines.push("");
  }

  return lines;
}

function generateReport(state: PollerState): string {
  const now = new Date();
  const todayStr = now.toISOString().split("T")[0];
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // Filter to last 24 hours
  const recent = state.history.filter(
    (j) => new Date(j.startedAt) >= oneDayAgo
  );

  const succeeded = recent.filter((j) => j.status === "succeeded");
  const failed = recent.filter((j) => j.status === "failed");
  const timedOut = recent.filter((j) => j.status === "timed_out");

  const lines: string[] = [
    `# Linear Poller Report — ${todayStr}`,
    "",
    `**Period:** Last 24 hours (since ${oneDayAgo.toISOString()})`,
    `**Last poll:** ${state.lastPollAt || "never"}`,
    "",
    "## Summary",
    "",
    `| Metric | Count |`,
    `|--------|-------|`,
    `| Total dispatched | ${recent.length} |`,
    `| Succeeded | ${succeeded.length} |`,
    `| Failed | ${failed.length} |`,
    `| Timed out | ${timedOut.length} |`,
    "",
  ];

  if (state.currentJob) {
    lines.push(
      "## Currently Running",
      "",
      `- **${state.currentJob.identifier}**: ${state.currentJob.title}`,
      `  - Started: ${state.currentJob.startedAt}`,
      `  - Run ID: ${state.currentJob.antfarmRunId || "unknown"}`,
      ""
    );
  }

  if (failed.length > 0 || timedOut.length > 0) {
    lines.push("## Failures (Action Required)", "");
    for (const job of [...failed, ...timedOut]) {
      const duration = job.finishedAt
        ? `${Math.round((new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime()) / 1000)}s`
        : "unknown";
      lines.push(
        `### ${job.identifier} — ${job.title}`,
        "",
        `- **Status:** ${job.status}`,
        `- **Duration:** ${duration}`,
        `- **Run ID:** ${job.antfarmRunId || "unknown"}`,
        `- **Retry count:** ${job.retryCount}`,
        job.errorMessage ? `- **Error:** ${job.errorMessage}` : "",
        ""
      );
    }
  }

  if (succeeded.length > 0) {
    lines.push("## Completed", "");
    for (const job of succeeded) {
      const duration = job.finishedAt
        ? `${Math.round((new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime()) / 1000)}s`
        : "unknown";
      lines.push(`- **${job.identifier}**: ${job.title} (${duration})`);
    }
    lines.push("");
  }

  // Self-healing metrics
  const metricsToReport = state.metrics ?? {
    totalAttempts: 0,
    firstPassSuccesses: 0,
    selfHealSuccesses: 0,
    humanInterventions: 0,
    failureCategories: {},
  };
  lines.push(...formatMetrics(metricsToReport));

  // Retry tracker
  const retriesEntries = Object.entries(state.retryTracker);
  if (retriesEntries.length > 0) {
    lines.push("## Tickets Needing Attention (Retry Tracker)", "");
    for (const [id, count] of retriesEntries) {
      lines.push(`- ${id}: ${count} retries`);
    }
    lines.push("");
  }

  return lines.filter((l) => l !== undefined).join("\n");
}

// --- Main ---
const state = loadState();
if (!state) {
  console.log("No state file found. Poller has not run yet.");
  process.exit(0);
}

const report = generateReport(state);

if (process.argv.includes("--write")) {
  const todayStr = new Date().toISOString().split("T")[0];
  const outPath = join(reportDir, `linear-poller-${todayStr}.md`);
  writeFileSync(outPath, report);
  console.log(`Report written to ${outPath}`);
} else {
  console.log(report);
}
