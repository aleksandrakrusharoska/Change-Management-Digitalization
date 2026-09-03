/**
 * Delete Jira issues from the command line — bypasses the UI permission problem.
 *
 * Usage:
 *   node --env-file=.env delete-issues.mjs SAC-20 SAC-21     # delete specific keys
 *   node --env-file=.env delete-issues.mjs --all             # delete ALL issues in the project
 *   node --env-file=.env delete-issues.mjs --all --dry-run   # list what would be deleted, delete nothing
 */

const BASE = process.env.JIRA_BASE_URL;
const PROJECT = process.env.JIRA_PROJECT_KEY;
const auth =
  "Basic " +
  Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString("base64");

const headers = { Authorization: auth, "Content-Type": "application/json", Accept: "application/json" };

async function listAll() {
  const res = await fetch(`${BASE}/rest/api/3/search/jql`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jql: `project = "${PROJECT}" ORDER BY created ASC`,
      maxResults: 200,
      fields: ["key", "summary"],
    }),
  });
  if (!res.ok) throw new Error(`search -> ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.issues ?? [];
}

async function del(key) {
  const res = await fetch(`${BASE}/rest/api/3/issue/${key}?deleteSubtasks=true`, {
    method: "DELETE",
    headers,
  });
  if (!res.ok && res.status !== 204) throw new Error(`delete ${key} -> ${res.status}: ${await res.text()}`);
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const all = args.includes("--all");
const keys = args.filter((a) => !a.startsWith("--"));

let targets = keys;
if (all) {
  const issues = await listAll();
  targets = issues.map((i) => i.key);
  console.log(`Found ${targets.length} issues in ${PROJECT}:`);
  for (const i of issues) console.log(`  ${i.key}  ${i.fields.summary}`);
}

if (targets.length === 0) {
  console.log("Nothing to delete. Pass keys (SAC-20 ...) or --all.");
  process.exit(0);
}

if (dryRun) {
  console.log(`\n[dry-run] Would delete ${targets.length} issue(s): ${targets.join(", ")}`);
  process.exit(0);
}

console.log(`\nDeleting ${targets.length} issue(s)...`);
for (const key of targets) {
  try {
    await del(key);
    console.log(`  ✓ deleted ${key}`);
  } catch (e) {
    console.error(`  ✗ ${key}: ${e.message}`);
  }
}
console.log("Done.");
