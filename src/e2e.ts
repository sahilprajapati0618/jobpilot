// End-to-end test against live job APIs: spawns the server over stdio and drives it like a real MCP client.
// Run with: npm run e2e

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

const dataDir = path.join(os.tmpdir(), "jobpilot-e2e");
await fs.rm(dataDir, { recursive: true, force: true });

const transport = new StdioClientTransport({
  command: "node",
  args: ["build/index.js"],
  env: { ...process.env, JOBPILOT_DATA_DIR: dataDir } as Record<string, string>,
});
const client = new Client({ name: "jobpilot-e2e", version: "0.2.0" });
await client.connect(transport);

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: { text: string }[];
    isError?: boolean;
  };
  const raw = result.content[0].text;
  assert.ok(!result.isError, `${name} returned an error: ${raw}`);
  return JSON.parse(raw);
}

const step = (msg: string) => console.log(`\n✔ ${msg}`);

const { tools } = await client.listTools();
const { prompts } = await client.listPrompts();
step(`${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);
step(`${prompts.length} prompts: ${prompts.map((p) => p.name).join(", ")}`);

const search = await call("search_jobs", { query: "react", limit: 5 });
step(`search_jobs("react") -> ${search.showing} of ${search.totalMatches} matches`);
for (const j of search.jobs) console.log(`    [${j.id}] ${j.title} @ ${j.company} (${j.location})`);
if (search.warnings.length) console.log("    warnings:", search.warnings);
assert.ok(search.jobs.length > 0, "expected at least one react job");

const resume =
  "Frontend Developer. 2 years building web apps with React, TypeScript, JavaScript, Next.js, Tailwind CSS, " +
  "HTML, CSS, Node.js, Express, MongoDB, Git and REST APIs. Built a real-time chat app and an e-commerce dashboard.";
await call("save_resume", { resume_text: resume });
step("save_resume");

const ranked = await call("rank_jobs", { query: "react", limit: 3 });
step(`rank_jobs("react") using saved resume -> scored ${ranked.scored} jobs, top ${ranked.topMatches.length}:`);
for (const j of ranked.topMatches) console.log(`    ${j.score}/100  ${j.title} @ ${j.company}  missing: ${j.missingSkills.join(", ") || "-"}`);

const best = ranked.topMatches[0];
const match = await call("match_resume", { job_id: best.id });
step(`match_resume(${best.id}) -> ${match.score}/100 (skills ${match.skillScore}, text ${match.textSimilarity})`);
console.log(`    ${match.verdict}`);

const details = await call("get_job_details", { job_id: best.id });
step(`get_job_details -> ${details.description.length} chars of description`);

const saved = await call("save_application", { job_id: best.id });
const dup = await call("save_application", { job_id: best.id });
assert.equal(dup.application.id, saved.id);
step(`save_application -> id ${saved.id} (duplicate correctly detected on 2nd save)`);

await call("update_application", { id: saved.id, status: "interview", notes: "Round 1 on Monday" });
const list = await call("list_applications");
assert.equal(list.applications[0].status, "interview");
step(`update + list_applications -> stats ${JSON.stringify(list.stats)}`);

const prompt = await client.getPrompt({ name: "cover_letter", arguments: { job_id: best.id } });
const promptText = (prompt.messages[0].content as { text: string }).text;
assert.match(promptText, /cover letter/);
step(`cover_letter prompt -> ${promptText.length} chars, starts: "${promptText.slice(0, 70)}..."`);

await call("delete_application", { id: saved.id });
assert.equal((await call("list_applications")).applications.length, 0);
step("delete_application");

await client.close();
await fs.rm(dataDir, { recursive: true, force: true });
console.log("\nAll end-to-end checks passed.");
