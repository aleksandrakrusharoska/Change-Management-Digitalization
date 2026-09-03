/**
 * Atlassian Document Format (ADF) helpers.
 * A real @mention that fires a notification must be an ADF "mention" node with the
 * person's accountId — plain "@Name" text does nothing.
 */

interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
}

export interface AdfDoc {
  type: "doc";
  version: 1;
  content: AdfNode[];
}

/**
 * Build a comment paragraph like:
 *   "26/08/2026: analysis needed " @Igor @Nikola
 * where each accountId becomes a real, notifying mention.
 */
export function buildCommentAdf(leadText: string, mentionAccountIds: string[]): AdfDoc {
  const content: AdfNode[] = [];

  if (leadText) content.push({ type: "text", text: leadText });

  for (const id of mentionAccountIds) {
    content.push({ type: "text", text: " " });
    content.push({ type: "mention", attrs: { id } });
  }

  return {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: content.length ? content : [{ type: "text", text: leadText || " " }] }],
  };
}
