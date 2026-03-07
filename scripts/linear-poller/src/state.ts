/**
 * Simple JSON file state management.
 * Tracks current job, history, and retry counts.
 * Survives poller restarts.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";

export interface JobRecord {
  issueId: string;
  identifier: string;       // e.g. "AMA-611"
  title: string;
  status: "running" | "succeeded" | "failed" | "timed_out";
  antfarmRunId?: string;
  startedAt: string;         // ISO timestamp
  finishedAt?: string;
  errorMessage?: string;
  retryCount: number;
}

export interface Metrics {
  totalAttempts: number;
  firstPassSuccesses: number;   // succeeded with no prior failure comment
  selfHealSuccesses: number;    // succeeded after a retry with failure context
  humanInterventions: number;   // escalated to Backlog (max retries exceeded)
  failureCategories: Record<string, number>; // e.g. {"build": 3, "test": 2, "lint": 1}
}

export interface PollerState {
  currentJob: JobRecord | null;
  history: JobRecord[];
  retryTracker: Record<string, number>;  // issueId -> retry count
  lastPollAt: string | null;
  metrics: Metrics;
}

const EMPTY_METRICS: Metrics = {
  totalAttempts: 0,
  firstPassSuccesses: 0,
  selfHealSuccesses: 0,
  humanInterventions: 0,
  failureCategories: {},
};

const EMPTY_STATE: PollerState = {
  currentJob: null,
  history: [],
  retryTracker: {},
  lastPollAt: null,
  metrics: { ...EMPTY_METRICS, failureCategories: {} },
};

export class StateManager {
  private state: PollerState;

  constructor(private filePath: string) {
    this.state = this.load();
  }

  private load(): PollerState {
    if (!existsSync(this.filePath)) return { ...EMPTY_STATE, history: [], retryTracker: {}, metrics: { ...EMPTY_METRICS, failureCategories: {} } };
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as PollerState;
      // Backfill metrics if loading an older state file that lacks them
      if (!parsed.metrics) {
        parsed.metrics = { ...EMPTY_METRICS, failureCategories: {} };
      }
      return parsed;
    } catch {
      console.warn(`[state] Corrupt state file, starting fresh`);
      return { ...EMPTY_STATE, history: [], retryTracker: {}, metrics: { ...EMPTY_METRICS, failureCategories: {} } };
    }
  }

  private save(): void {
    writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  get currentJob(): JobRecord | null {
    return this.state.currentJob;
  }

  get lastPollAt(): string | null {
    return this.state.lastPollAt;
  }

  recordPoll(): void {
    this.state.lastPollAt = new Date().toISOString();
    this.save();
  }

  /**
   * Check if a job was already running when poller restarted.
   * This is the "crash recovery" scenario.
   */
  hasOrphanedJob(): boolean {
    return this.state.currentJob !== null && this.state.currentJob.status === "running";
  }

  getRetryCount(issueId: string): number {
    return this.state.retryTracker[issueId] || 0;
  }

  startJob(issueId: string, identifier: string, title: string): void {
    const job: JobRecord = {
      issueId,
      identifier,
      title,
      status: "running",
      startedAt: new Date().toISOString(),
      retryCount: this.getRetryCount(issueId),
    };
    this.state.currentJob = job;
    this.save();
  }

  finishJob(status: "succeeded" | "failed" | "timed_out", errorMessage?: string, antfarmRunId?: string): void {
    if (!this.state.currentJob) return;

    this.state.currentJob.status = status;
    this.state.currentJob.finishedAt = new Date().toISOString();
    if (errorMessage) this.state.currentJob.errorMessage = errorMessage;
    if (antfarmRunId) this.state.currentJob.antfarmRunId = antfarmRunId;

    // Update retry tracker on failure
    if (status === "failed" || status === "timed_out") {
      const id = this.state.currentJob.issueId;
      this.state.retryTracker[id] = (this.state.retryTracker[id] || 0) + 1;
    } else {
      // Clear retry count on success
      delete this.state.retryTracker[this.state.currentJob.issueId];
    }

    // Move to history
    this.state.history.push({ ...this.state.currentJob });
    this.state.currentJob = null;

    // Keep last 100 entries
    if (this.state.history.length > 100) {
      this.state.history = this.state.history.slice(-100);
    }

    this.save();
  }

  clearOrphanedJob(): void {
    if (this.state.currentJob) {
      this.state.currentJob.status = "failed";
      this.state.currentJob.finishedAt = new Date().toISOString();
      this.state.currentJob.errorMessage = "Poller restarted while job was running (orphaned)";
      this.state.history.push({ ...this.state.currentJob });
      this.state.currentJob = null;
      this.save();
    }
  }

  incrementTotalAttempts(): void {
    this.state.metrics.totalAttempts++;
    this.save();
  }

  incrementFirstPassSuccesses(): void {
    this.state.metrics.firstPassSuccesses++;
    this.save();
  }

  incrementSelfHealSuccesses(): void {
    this.state.metrics.selfHealSuccesses++;
    this.save();
  }

  incrementHumanInterventions(): void {
    this.state.metrics.humanInterventions++;
    this.save();
  }

  /**
   * Increment the failure category counter for a given step name.
   * Called when a retry is picked up with a failure comment.
   */
  recordFailureCategory(failedStep: string): void {
    if (!failedStep) return;
    this.state.metrics.failureCategories[failedStep] =
      (this.state.metrics.failureCategories[failedStep] || 0) + 1;
    this.save();
  }

  getMetrics(): Metrics {
    return this.state.metrics;
  }

  getStatus(): { current: JobRecord | null; recent: JobRecord[]; retries: Record<string, number>; metrics: Metrics } {
    return {
      current: this.state.currentJob,
      recent: this.state.history.slice(-10),
      retries: this.state.retryTracker,
      metrics: this.state.metrics,
    };
  }
}
