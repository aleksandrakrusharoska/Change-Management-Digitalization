/**
 * Send emails via SendGrid API for aggregated conflict notifications.
 */

export interface ConflictGroup {
  key: string;
  messages: string[];
}

interface SendGridPayload {
  personalizations: Array<{
    to: Array<{ email: string }>;
    subject: string;
  }>;
  from: { email: string };
  content: Array<{
    type: "text/plain" | "text/html";
    value: string;
  }>;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function sendConflictEmail(
  groups: ConflictGroup[],
  recipientEmails: string[]
): Promise<void> {
  const apiKey = process.env.SENDGRID_API_KEY;
  const fromEmail = process.env.SENDGRID_FROM_EMAIL;
  const jiraBaseUrl = process.env.JIRA_BASE_URL?.replace(/\/$/, "");

  if (!apiKey || !fromEmail) {
    console.warn("SendGrid not configured (SENDGRID_API_KEY or SENDGRID_FROM_EMAIL missing)");
    return;
  }

  if (!recipientEmails || recipientEmails.length === 0) {
    console.warn("No recipient emails configured for conflict notifications");
    return;
  }

  if (!groups.length) {
    return;
  }

  const subject = "Jira sync conflicts";

  const plainText = [
    "Hi,",
    "",
    "We detected conflicts during the latest Jira sync:",
    "",
    ...groups.flatMap((group) => {
      const link = jiraBaseUrl ? `${jiraBaseUrl}/browse/${group.key}` : group.key;
      return [
        `${group.key} - ${link}`,
        ...group.messages.map((message) => `- ${message}`),
        "",
      ];
    }),
    "Please review the issues in Jira.",
  ].join("\n");

  const htmlContent = `
<html>
  <body style="font-family: Arial, sans-serif; color: #222; line-height: 1.5;">
    <p>Hi,</p>
    <p>We detected conflicts during the latest Jira sync:</p>
    ${groups
      .map((group) => {
        const issueLink = jiraBaseUrl ? `${jiraBaseUrl}/browse/${group.key}` : "#";
        return `
          <div style="margin: 0 0 18px 0; padding: 0 0 12px 0; border-bottom: 1px solid #e5e5e5;">
            <div style="font-weight: 600; margin-bottom: 6px;">
              <a href="${escapeHtml(issueLink)}" style="color: #0052cc; text-decoration: none;">${escapeHtml(group.key)}</a>
            </div>
            <div style="color: #444; margin-bottom: 6px;">
              ${group.messages.map((message) => `<div>- ${escapeHtml(message)}</div>`).join("")}
            </div>
          </div>
        `;
      })
      .join("")}
    <p>Please review the issues in Jira.</p>
  </body>
</html>
  `.trim();

  const payload: SendGridPayload = {
    personalizations: recipientEmails.map((email) => ({
      to: [{ email }],
      subject,
    })),
    from: { email: fromEmail },
    content: [
      { type: "text/plain", value: plainText },
      { type: "text/html", value: htmlContent },
    ],
  };

  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`SendGrid error (${res.status}): ${body}`);
    throw new Error(`SendGrid ${res.status}: ${body}`);
  }

  console.log(`[SENDGRID] Conflict email sent to ${recipientEmails.join(", ")}`);
}
