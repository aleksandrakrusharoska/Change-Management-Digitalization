import type { AdfDoc } from "./adf.js";

const BASE = process.env.JIRA_BASE_URL!;
const PROJECT = process.env.JIRA_PROJECT_KEY!;

function authHeader(): string {
  const token = Buffer.from(
    `${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`
  ).toString("base64");
  return `Basic ${token}`;
}

async function jira<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jira ${init.method ?? "GET"} ${path} -> ${res.status}: ${body}`);
  }
  // Some endpoints (add comment) return 201 with a body; some return 204.
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

// Cache email -> accountId for the lifetime of the function invocation so we
// don't hit Jira's user-search endpoint repeatedly for the same person.
const accountIdCache = new Map<string, string | null>();

/**
 * Look up a Jira accountId from an email address.
 * Returns null if no active user with that email is found.
 */
export async function findAccountIdByEmail(email: string): Promise<string | null> {
  const key = email.toLowerCase();
  if (accountIdCache.has(key)) return accountIdCache.get(key)!;

  const users = await jira<{ accountId: string; emailAddress?: string; active: boolean }[]>(
    `/rest/api/3/user/search?query=${encodeURIComponent(email)}`
  );
  // The search matches email/display name; take the first active exact-email match,
  // falling back to the first active user returned.
  const exact = users.find(
    (u) => u.active && u.emailAddress?.toLowerCase() === key
  );
  const accountId = (exact ?? users.find((u) => u.active))?.accountId ?? null;

  accountIdCache.set(key, accountId);
  return accountId;
}

/** Find an existing issue in the project by exact summary. Returns its key or null. */
export async function findIssueBySummary(summary: string): Promise<string | null> {
  const jql = `project = "${PROJECT}" AND summary ~ ${JSON.stringify(summary)} ORDER BY created DESC`;
  const data = await jira<{ issues: { key: string; fields: { summary: string } }[] }>(
    `/rest/api/3/search/jql`,
    {
      method: "POST",
      body: JSON.stringify({ jql, maxResults: 5, fields: ["summary"] }),
    }
  );
  // summary ~ is fuzzy; require an exact (case-insensitive) match to be safe.
  const exact = data.issues.find(
    (i) => i.fields.summary.trim().toLowerCase() === summary.trim().toLowerCase()
  );
  return exact?.key ?? null;
}

export interface CreateIssueInput {
  summary: string;
  description: string;
  issueType: string;
  assigneeAccountId?: string | null;
  dueDate?: string | null;
}

/** Create an issue. Returns the new key (e.g. SAC-42). */
export async function createIssue(input: CreateIssueInput): Promise<string> {
  const fields: Record<string, unknown> = {
    project: { key: PROJECT },
    summary: input.summary,
    issuetype: { name: input.issueType },
    description: {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: input.description }] }],
    },
  };
  if (input.assigneeAccountId) fields.assignee = { accountId: input.assigneeAccountId };
  if (input.dueDate) fields.duedate = input.dueDate;

  const data = await jira<{ key: string }>("/rest/api/3/issue", {
    method: "POST",
    body: JSON.stringify({ fields }),
  });
  return data.key;
}

export interface IssueSnapshot {
  status: string | null;
  assigneeAccountId: string | null;
}

/** Read an issue's current status name and assignee accountId in one call —
 *  the "ground truth" to check against before overwriting anything. */
export async function getIssueSnapshot(key: string): Promise<IssueSnapshot> {
  const data = await jira<{
    fields: { status: { name: string } | null; assignee: { accountId: string } | null };
  }>(`/rest/api/3/issue/${key}?fields=status,assignee`);
  return {
    status: data.fields?.status?.name ?? null,
    assigneeAccountId: data.fields?.assignee?.accountId ?? null,
  };
}

interface Transition {
  id: string;
  name: string;
  to: { name: string };
}

/** Move an issue to the given status by name, using its available workflow
 *  transitions. Returns true if a matching transition existed and was applied,
 *  false if no transition to that status is available from the current state. */
export async function transitionIssueTo(key: string, statusName: string): Promise<boolean> {
  const data = await jira<{ transitions: Transition[] }>(`/rest/api/3/issue/${key}/transitions`);
  const match = data.transitions.find((t) => t.to.name.toLowerCase() === statusName.toLowerCase());
  if (!match) return false;

  await jira(`/rest/api/3/issue/${key}/transitions`, {
    method: "POST",
    body: JSON.stringify({ transition: { id: match.id } }),
  });
  return true;
}

/** Assign an existing issue (used when a task already exists but owner changed). */
export async function assignIssue(key: string, accountId: string): Promise<void> {
  await jira(`/rest/api/3/issue/${key}/assignee`, {
    method: "PUT",
    body: JSON.stringify({ accountId }),
  });
}

/** Add a comment (ADF) — with real mentions this notifies the tagged people. */
export async function addComment(key: string, body: AdfDoc): Promise<void> {
  await jira(`/rest/api/3/issue/${key}/comment`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

/** Delete an issue by key. */
export async function deleteIssue(key: string): Promise<void> {
  await jira(`/rest/api/3/issue/${key}?deleteSubtasks=true`, { method: "DELETE" });
}

/** Return all issue keys in the project (for bulk cleanup). */
export async function listAllIssueKeys(): Promise<string[]> {
  const jql = `project = "${PROJECT}" ORDER BY created ASC`;
  const data = await jira<{ issues: { key: string }[] }>(`/rest/api/3/search/jql`, {
    method: "POST",
    body: JSON.stringify({ jql, maxResults: 200, fields: ["key"] }),
  });
  return (data.issues ?? []).map((i) => i.key);
}