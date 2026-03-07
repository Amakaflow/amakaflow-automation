/**
 * Linear GraphQL client.
 * Handles: fetching todo tickets, checking blockers, updating status, adding comments.
 */

import type { Config } from "./config.js";

interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  number: number;
  url: string;
  state: { id: string; name: string; type: string };
  assignee: { id: string; displayName: string } | null;
  parent: { id: string; identifier: string } | null;
  children: { nodes: Array<{ id: string; identifier: string; state: { name: string } }> };
  relations: {
    nodes: Array<{
      type: string;
      relatedIssue: { id: string; identifier: string; state: { name: string; type: string } };
    }>;
  };
}

export interface ReadyIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  number: number;
  url: string;
  blockedByUnresolved: string[];  // identifiers of unresolved blockers
}

export class LinearClient {
  private apiUrl = "https://api.linear.app/graphql";

  constructor(private config: Config) {}

  private async query<T>(gql: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(this.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.config.linearApiKey,
      },
      body: JSON.stringify({ query: gql, variables }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Linear API ${res.status}: ${text}`);
    }

    const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (json.errors?.length) {
      throw new Error(`Linear GraphQL: ${json.errors.map((e) => e.message).join(", ")}`);
    }
    return json.data as T;
  }

  /**
   * Fetch all issues assigned to the agent in "Todo" status.
   * Includes blocker relations so we can filter.
   */
  async fetchTodoIssues(): Promise<ReadyIssue[]> {
    const data = await this.query<{
      issues: {
        nodes: LinearIssue[];
      };
    }>(
      `query($assigneeId: ID!, $teamId: ID!, $statusName: String!) {
        issues(
          filter: {
            assignee: { id: { eq: $assigneeId } }
            team: { id: { eq: $teamId } }
            state: { name: { eq: $statusName } }
          }
          first: 50
          orderBy: createdAt
        ) {
          nodes {
            id
            identifier
            title
            description
            number
            url
            state { id name type }
            assignee { id displayName }
            parent { id identifier }
            children {
              nodes { id identifier state { name } }
            }
            relations {
              nodes {
                type
                relatedIssue {
                  id identifier
                  state { name type }
                }
              }
            }
          }
        }
      }`,
      {
        assigneeId: this.config.linearAssigneeId,
        teamId: this.config.linearTeamId,
        statusName: this.config.linearPickupStatus,
      }
    );

    return data.issues.nodes
      // Filter out epics (tickets with unresolved children are organizational, not actionable)
      .filter((issue) => {
        const unresolvedChildren = issue.children.nodes.filter(
          (c) => c.state.name !== "Done" && c.state.name !== "Canceled"
        );
        if (unresolvedChildren.length > 0) {
          console.log(
            `[linear] Skipping ${issue.identifier} (epic with ${unresolvedChildren.length} unresolved children: ${unresolvedChildren.map((c) => c.identifier).join(", ")})`
          );
          return false;
        }
        return true;
      })
      .map((issue) => {
        // Check "blocks" relations where this issue is blocked BY another
        const blockedByUnresolved = issue.relations.nodes
          .filter((r) => {
            // Linear relation types: "blocks" means relatedIssue blocks this issue
            // We want to find issues that block THIS issue and aren't done/canceled
            return (
              r.type === "blocks" &&
              r.relatedIssue.state.type !== "completed" &&
              r.relatedIssue.state.type !== "canceled"
            );
          })
          .map((r) => r.relatedIssue.identifier);

        return {
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          description: issue.description || "",
          number: issue.number,
          url: issue.url,
          blockedByUnresolved,
        };
      });
  }

  /**
   * Fetch a single issue to verify its current state before acting.
   * Prevents race conditions (ticket moved/unassigned while we were deciding).
   */
  async fetchIssue(issueId: string): Promise<{
    id: string;
    identifier: string;
    state: { id: string; name: string; type: string };
    assignee: { id: string } | null;
  } | null> {
    try {
      const data = await this.query<{
        issue: {
          id: string;
          identifier: string;
          state: { id: string; name: string; type: string };
          assignee: { id: string } | null;
        };
      }>(
        `query($id: String!) {
          issue(id: $id) {
            id
            identifier
            state { id name type }
            assignee { id }
          }
        }`,
        { id: issueId }
      );
      return data.issue;
    } catch {
      return null;
    }
  }

  /**
   * Move issue to In Progress.
   */
  async moveToInProgress(issueId: string): Promise<void> {
    await this.query(
      `mutation($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) {
          success
        }
      }`,
      { id: issueId, stateId: this.config.linearInProgressStatusId }
    );
  }

  /**
   * Move issue to Done.
   */
  async moveToDone(issueId: string): Promise<void> {
    await this.query(
      `mutation($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) {
          success
        }
      }`,
      { id: issueId, stateId: this.config.linearDoneStatusId }
    );
  }

  /**
   * Move issue back to Todo (on failure, for retry).
   */
  async moveToTodo(issueId: string): Promise<void> {
    await this.query(
      `mutation($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) {
          success
        }
      }`,
      { id: issueId, stateId: this.config.linearTodoStatusId }
    );
  }

  /**
   * Move issue to In Review (after successful AI push, for CI validation).
   */
  async moveToInReview(issueId: string): Promise<void> {
    if (!this.config.linearInReviewStatusId) {
      console.log("[linear] LINEAR_IN_REVIEW_STATUS_ID not set — skipping move to In Review");
      return;
    }
    await this.query(
      `mutation($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) {
          success
        }
      }`,
      { id: issueId, stateId: this.config.linearInReviewStatusId }
    );
  }

  /**
   * Add a comment to an issue.
   */
  async addComment(issueId: string, body: string): Promise<void> {
    await this.query(
      `mutation($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
        }
      }`,
      { issueId, body }
    );
  }

  /**
   * Fetch the most recent comment on a ticket containing a structured failure block.
   * Returns parsed failure context, or null if no such comment is found.
   */
  async getLatestFailureComment(ticketId: string): Promise<{
    failedStep: string;
    branchName: string;
    runUrl: string;
    retryCount: number;
    fullCommentBody: string;
  } | null> {
    let data: {
      issue: {
        comments: {
          nodes: Array<{ body: string; createdAt: string }>;
        };
      };
    };

    try {
      data = await this.query<{
        issue: {
          comments: {
            nodes: Array<{ body: string; createdAt: string }>;
          };
        };
      }>(
        `query($id: String!) {
          issue(id: $id) {
            comments(
              first: 10
              orderBy: createdAt
            ) {
              nodes {
                body
                createdAt
              }
            }
          }
        }`,
        { id: ticketId }
      );
    } catch {
      return null;
    }

    // Comments come back oldest-first from Linear; reverse to get newest first
    const comments = [...data.issue.comments.nodes].reverse();

    for (const comment of comments) {
      if (!comment.body.includes("FAILURE_CONTEXT_START")) continue;

      // Extract content between markers
      const match = comment.body.match(
        /FAILURE_CONTEXT_START\n([\s\S]*?)\nFAILURE_CONTEXT_END/
      );
      if (!match) continue;

      const block = match[1];
      const parsed: Record<string, string> = {};
      for (const line of block.split("\n")) {
        const colonIdx = line.indexOf(":");
        if (colonIdx === -1) continue;
        const key = line.slice(0, colonIdx).trim();
        const value = line.slice(colonIdx + 1).trim();
        parsed[key] = value;
      }

      const failedStep = parsed["failed_step"] ?? "";
      const branchName = parsed["branch_name"] ?? "";
      const runUrl = parsed["run_url"] ?? "";
      const retryCount = parseInt(parsed["retry_count"] ?? "0", 10);

      return {
        failedStep,
        branchName,
        runUrl,
        retryCount: isNaN(retryCount) ? 0 : retryCount,
        fullCommentBody: comment.body,
      };
    }

    return null;
  }
}
