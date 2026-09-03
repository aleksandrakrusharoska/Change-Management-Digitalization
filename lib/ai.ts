import { generateObject } from "ai";
import { z } from "zod";

/**
 * Schema for what the AI must return. Note `updates[].mentions` is an ARRAY —
 * one update line can tag several people. This is the thing that was painful in
 * Power Automate and is trivial here.
 */
export const UpdateSchema = z.object({
  date: z.string().describe("DD/MM/YYYY"),
  note: z.string().describe("short paraphrase, plain text, no HTML"),
  mentions: z
    .array(z.string())
    .describe("clean names of every person tagged with @ on this line, e.g. ['Igor Joncheski','Nikola Markoski']; empty array if none"),
});

export const TicketSchema = z.object({
  stableKey: z
    .string()
    .describe("short lowercase kebab-case id derived only from the topic, stable across days"),
  summary: z.string(),
  issueType: z.enum(["Bug", "Task"]),
  priority: z.enum(["Highest", "High", "Medium", "Low"]),
  status: z.enum(["To Do", "In Progress", "Blocked", "Done"]),
  assignee: z.string().describe("the main owner name/handle, cleaned (no @)"),
  labels: z.array(z.string()),
  dueDate: z.string().nullable().describe("ISO YYYY-MM-DD or null"),
  description: z.string(),
  updates: z.array(UpdateSchema),
});

export const ResultSchema = z.object({ tickets: z.array(TicketSchema) });

export type Ticket = z.infer<typeof TicketSchema>;
export type Update = z.infer<typeof UpdateSchema>;

const SYSTEM = `You convert manufacturing production-standup notes into Jira issues. The input is raw HTML from an email. Read the visible text and also interpret HTML formatting tags for status and priority. Ignore all Gmail/Outlook wrapper markup, classes, and styles not listed below.

FORMATTING RULES:
- Text wrapped in <strike>, <s>, <del>, or style "text-decoration:line-through" means the task is FINISHED -> status = "Done".
- Text that is BOTH bold AND red at the same time (<b>/<strong> together with color:#ff0000 / color:red) -> priority = "Highest". This overrides other priority logic.
- Text that is only red (no bold) is just normal styling -> ignore the color.

CONTENT RULES:
- Each NUMBERED top item becomes exactly one ticket.
- stableKey: short kebab-case id from the topic only (e.g. "solder-wave-overflow", "ict-dsp-sub-release"). MUST be identical for the same topic on any day.
- assignee: the main owner named on the item's title line (a person or role code). Clean it (strip @). If none on the title, use the first tagged person.
- issueType: "Bug" for defects/failures/overflow/unflashed parts/wrong SW; "Task" for reviews, releases, capacity planning.
- status: apply the strike rule first; else "Done" if latest text says completed/released/resolved; "Blocked" if waiting on external repair/feedback with no path; else "In Progress".
- priority: apply the bold-red rule first; else "Highest" if it stops all production; "High" if it blocks a major process; "Medium" otherwise.
- dueDate: clearest committed date as ISO YYYY-MM-DD, else null. Assume year 2026 if only day/month given.
- labels: 3-4 short kebab-case labels including "production-readiness".
- description: 1-2 concise plain-text sentences.
- updates: one entry per dated line. For each line, extract EVERY @-tagged person into "mentions" as a clean array. A handle like "@Joncheski, Igor" becomes "Igor Joncheski"; "@Markoski, Nikola" becomes "Nikola Markoski". Lines with no @ get an empty mentions array.`;

export async function extractTickets(emailHtml: string) {
  const { object } = await generateObject({
    // With Vercel AI Gateway a plain "provider/model" string is routed automatically.
    model: process.env.AI_MODEL ?? "anthropic/claude-sonnet-4.5",
    schema: ResultSchema,
    system: SYSTEM,
    prompt: `Convert these standup notes (raw email HTML) into Jira issues:\n\n${emailHtml}`,
  });
  return object.tickets;
}
