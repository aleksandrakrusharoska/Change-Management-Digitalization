import type { VercelRequest, VercelResponse } from "@vercel/node";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST" && req.method !== "GET")
    return res.status(405).json({ error: "Use GET or POST" });

  const teamsWebhook = process.env.TEAMS_WEBHOOK_URL;
  if (!teamsWebhook) return res.status(400).json({ error: "TEAMS_WEBHOOK_URL not configured" });

  const jiraBase = (process.env.JIRA_BASE_URL || "").replace(/\/$/, "");

  const sampleKey = "SAC-123";
  const card = {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      { type: "TextBlock", text: "standup-to-jira — Aggregated conflicts (test)", weight: "Bolder", size: "Medium" },
      { type: "TextBlock", text: `This is a test Adaptive Card posted to the channel via incoming webhook.`, wrap: true },
      { type: "TextBlock", text: sampleKey, weight: "Bolder", wrap: true },
      { type: "TextBlock", text: `• Example conflict: Jira status is "Done" but email suggests "In Progress"\n• Example conflict: Jira assignee differs from the email`, wrap: true }
    ],
    actions: jiraBase
      ? [
          {
            type: "Action.OpenUrl",
            title: `Open ${sampleKey}`,
            url: `${jiraBase}/browse/${sampleKey}`,
          },
        ]
      : [],
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

  try {
    const r = await fetch(teamsWebhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      return res.status(502).json({ ok: false, error: `Teams webhook returned ${r.status}`, body: text });
    }
    return res.status(200).json({ ok: true, posted: true });
  } catch (err) {
    console.error("Failed to post test card to Teams:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
