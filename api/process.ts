import type { VercelRequest, VercelResponse } from "@vercel/node";
import { extractTickets, type Ticket } from "../lib/ai.js";
import {
  findIssueBySummary,
  createIssue,
  assignIssue,
  addComment,
  findAccountIdByEmail,
  getIssueSnapshot,
  transitionIssueTo,
} from "../lib/jira.js";
import { resolveEmail } from "../lib/people.js";
import { buildCommentAdf } from "../lib/adf.js";
import { sendConflictEmail } from "../lib/sendgrid.js";

interface TicketResult {
  summary: string;
  key: string;
  action: "created" | "updated";
  assignee: string | null;
  comments: number;
  notified: string[];
  conflicts: string[];
}

/**
 * Resolve a name/handle from the notes to a Jira accountId:
 *   name -> email (people.json) -> accountId (live Jira lookup, cached).
 * Returns null if the person isn't mapped or has no Jira user.
 */
async function nameToAccountId(name: string | null | undefined): Promise<string | null> {
  const email = resolveEmail(name);
  if (!email) return null;
  return findAccountIdByEmail(email);
}

/**
 * POST /api/process
 * Body: { html: string }              // raw email body
 * Header: x-webhook-secret: <secret>
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  if (process.env.WEBHOOK_SECRET && req.headers["x-webhook-secret"] !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const html: string = req.body?.html ?? req.body?.Body ?? "";
  if (!html) return res.status(400).json({ error: "Missing 'html' in body" });

  try {
    const tickets = await extractTickets(html);
    const results: TicketResult[] = [];
    for (const t of tickets) results.push(await processTicket(t));

    // Aggregate conflicts by issue key so the caller can produce a single
    // summary message instead of per-ticket messages.
    const aggregated: Record<string, string[]> = {};
    for (const r of results) {
      if (r.conflicts && r.conflicts.length) {
        const k = r.key || r.summary;
        aggregated[k] = (aggregated[k] || []).concat(r.conflicts);
      }
    }

    const grouped = Object.entries(aggregated).map(([key, msgs]) => ({
      key,
      messages: Array.from(new Set(msgs)), // dedupe
    }));

    // Build a plain-text aggregated summary suitable for a single message:
    // Each entry becomes:
    // <key>:
    //  - message1
    //  - message2
    const summaryText = grouped.length
      ? grouped
          .map(
            (g) => `${g.key}:\n${g.messages.map((m) => ` - ${m}`).join("\n")}`
          )
          .join("\n\n")
      : "";

    // Post an Adaptive Card to Microsoft Teams via incoming webhook if configured.
    const teamsWebhook = process.env.TEAMS_WEBHOOK_URL;
    if (teamsWebhook && grouped.length) {
      try {
        const card = {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            { type: "TextBlock", text: `Jira sync conflicts — ${grouped.length} issue(s)`, weight: "Bolder", size: "Medium" },
            ...grouped.flatMap((g) => [
              { type: "TextBlock", text: g.key, weight: "Bolder", wrap: true },
              { type: "TextBlock", text: g.messages.map((m) => `• ${m}`).join("\n"), wrap: true }
            ])
          ],
          actions: grouped.map((g) => ({
            type: "Action.OpenUrl",
            title: `Open ${g.key}`,
            url: `${process.env.JIRA_BASE_URL?.replace(/\/$/, "")}/browse/${g.key}`,
          })),
        };

        const payload = {
          type: "message",
          attachments: [
            {
              contentType: "application/vnd.microsoft.card.adaptive",
              content: card,
            },
          ],
        };

        await fetch(teamsWebhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } catch (err) {
        console.warn("Failed posting aggregated conflicts to Teams webhook:", err);
      }
    }

    // If Power Automate (Flow) endpoint is configured, POST the aggregated
    // payload so a flow can render an Adaptive Card into Teams when webhooks
    // are blocked by tenant policies. The flow URL and an optional secret
    // header are set via POWER_AUTOMATE_URL and POWER_AUTOMATE_SECRET.
    const flowUrl = process.env.POWER_AUTOMATE_URL;
    if (flowUrl && grouped.length) {
      try {
        const flowPayload = { summaryText, aggregated: grouped };
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (process.env.POWER_AUTOMATE_SECRET) headers["x-flow-secret"] = process.env.POWER_AUTOMATE_SECRET;
        await fetch(flowUrl, { method: "POST", headers, body: JSON.stringify(flowPayload) });
      } catch (err) {
        console.warn("Failed posting aggregated conflicts to Power Automate endpoint:", err);
      }
    }

    // Send email via SendGrid if configured and conflicts exist.
    if (grouped.length) {
      const recipientEmails = process.env.SENDGRID_RECIPIENT_EMAILS?.split(",").map((e) => e.trim()) ?? [];
      if (recipientEmails.length > 0) {
        try {
          await sendConflictEmail(grouped, recipientEmails);
        } catch (err) {
          console.warn("Failed sending conflict email via SendGrid:", err);
        }
      }
    }

    // If caller asks for aggregate-only, return grouped conflicts and the
    // plain-text summary so the flow can post a single combined message.
    if (String(req.query?.aggregate) === "true") {
      return res.status(200).json({ ok: true, count: results.length, aggregated: grouped, summaryText });
    }

    return res.status(200).json({ ok: true, count: results.length, results, aggregated: grouped, summaryText });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}

async function processTicket(t: Ticket): Promise<TicketResult> {
  const assigneeId = await nameToAccountId(t.assignee);
  const notified = new Set<string>();
  const conflicts: string[] = [];

  // 1) De-duplicate: does this topic already exist?
  const existingKey = await findIssueBySummary(t.summary);

  let key: string;
  let action: "created" | "updated";

  if (existingKey) {
    key = existingKey;
    action = "updated";

    // Read Jira's ground truth once, before touching anything.
    const snapshot = await getIssueSnapshot(key).catch(
      () => ({ status: null, assigneeAccountId: null })
    );

    // Assignee: if Jira already shows a different person than the email,
    // don't silently reassign over a manual change — flag it instead.
    if (assigneeId && snapshot.assigneeAccountId && snapshot.assigneeAccountId !== assigneeId) {
      const msg = `${key}: Jira assignee differs from the email's "${t.assignee}" — left untouched to avoid overriding a manual reassignment.`;
      conflicts.push(msg);
      console.warn(`[CONFLICT] ${msg}`);
    } else if (assigneeId) {
      await assignIssue(key, assigneeId).catch(() => {});
    }

    // Status: a manual "Done" in Jira must never be reopened by a later email.
    // Any other mismatch is applied (email drives status day to day) but still logged.
    if (snapshot.status && snapshot.status.toLowerCase() !== t.status.toLowerCase()) {
      if (snapshot.status.toLowerCase() === "done") {
        const msg = `${key}: Jira status is manually "Done" but the email implies "${t.status}" — left untouched.`;
        conflicts.push(msg);
        console.warn(`[CONFLICT] ${msg}`);
      } else {
        const applied = await transitionIssueTo(key, t.status).catch(() => false);
        const msg = applied
          ? `${key}: Jira status was "${snapshot.status}", email says "${t.status}" — updated to match the email.`
          : `${key}: Jira status was "${snapshot.status}", email says "${t.status}" — no workflow transition to that status was available, left as-is.`;
        conflicts.push(msg);
        console.warn(`[CONFLICT] ${msg}`);
      }
    }
  } else {
    key = await createIssue({
      summary: t.summary,
      description: t.description,
      issueType: t.issueType,
      assigneeAccountId: assigneeId,
      dueDate: t.dueDate,
    });
    action = "created";
  }

  // 2) Every update -> a comment. Mentions become real, notifying @mentions.
  //    Multiple mentions per line are handled naturally.
  let comments = 0;
  for (const u of t.updates) {
    const mentionIds: string[] = [];
    for (const name of u.mentions) {
      const id = await nameToAccountId(name);
      if (id) {
        mentionIds.push(id);
        notified.add(name);
      }
    }
    const lead = `${u.date}: ${u.note}`;
    await addComment(key, buildCommentAdf(lead, mentionIds));
    comments++;
  }

  return {
    summary: t.summary,
    key,
    action,
    assignee: t.assignee ?? null,
    comments,
    notified: [...notified],
    conflicts,
  };
}