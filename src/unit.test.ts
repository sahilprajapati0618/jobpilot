// Offline unit tests (no network). Run with: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { extractSkills, matchResume, textSimilarity, topSkills } from "./matcher.js";
import { stripHtml, type Job, type JobSource } from "./sources.js";
import { relevance, searchJobs, searchBySkills, getCachedJob } from "./jobs.js";
import { extractResumeText } from "./resume.js";

// Builds a minimal valid one-page PDF with one line of text per entry.
function makePdf(lines: string[]): Uint8Array {
  const content = "BT /F1 12 Tf 72 720 Td 14 TL " + lines.map((l) => `(${l}) Tj T*`).join(" ") + " ET";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf +=
    `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

function fakeJob(overrides: Partial<Job>): Job {
  return {
    id: "fake-1",
    source: "fake",
    title: "Software Engineer",
    company: "Acme",
    location: "Worldwide",
    remote: true,
    jobType: "full time",
    salary: "Not disclosed",
    url: "https://example.com/1",
    postedAt: "2026-10-01T00:00:00.000Z",
    tags: [],
    description: "",
    ...overrides,
  };
}

// ---------- matcher ----------

test("extractSkills handles aliases and symbols", () => {
  const skills = extractSkills("Worked with NodeJS, C++, C#, Next.js, k8s and Postgres");
  for (const s of ["node.js", "c++", "c#", "next.js", "kubernetes", "postgresql"]) {
    assert.ok(skills.has(s), `expected ${s}`);
  }
});

test("extractSkills ignores common English words and substrings", () => {
  const skills = extractSkills("Let's go! Take a rest, it's spring. Excellent guardrails. Reactive people.");
  assert.equal(skills.size, 0, `unexpected: ${[...skills].join(", ")}`);
});

test("react native does not also count as react", () => {
  assert.deepEqual([...extractSkills("Built apps in React Native")], ["react native"]);
  assert.ok(extractSkills("React and React Native").has("react"));
});

test("matchResume weights core skills and lists missing core skills first", () => {
  const resume = "Frontend developer: JavaScript, CSS, HTML, Docker";
  const m = matchResume(resume, "We use JavaScript, CSS, HTML and Docker daily.", "React Developer");
  assert.equal(m.missingSkills[0], "react");
  assert.ok(m.coreSkills.includes("react"));
  // 4 of 6 weighted points matched (react counts double)
  assert.equal(m.skillScore, 67);
  assert.match(m.verdict, /Key requirement\(s\) missing: react/);
});

test("matchResume gives a strong score for a strong fit", () => {
  const resume = "Python developer with Django, PostgreSQL, Docker, AWS and REST API experience";
  const m = matchResume(resume, "Looking for Python + Django engineer. PostgreSQL, Docker, AWS, REST APIs.", "Python Django Engineer");
  assert.equal(m.skillScore, 100);
  assert.ok(m.score >= 80, `score was ${m.score}`);
});

test("matchResume doesn't inflate scores for jobs that mention only one skill", () => {
  const resume = "Frontend developer: React, TypeScript, Next.js, Tailwind, Node.js";
  const m = matchResume(resume, "Lead our brand strategy and storytelling. Our product is built with React.", "Head of Brand");
  assert.equal(m.skillScore, 100); // 1 of 1 skills matched...
  // ...but the overall score must stay below "Good match" (short texts like these inflate similarity a little)
  assert.ok(m.score < 50, `overall score should stay low, was ${m.score}`);
});

test("textSimilarity is 1 for identical text and 0 for unrelated text", () => {
  assert.ok(Math.abs(textSimilarity("kubernetes terraform pipelines", "kubernetes terraform pipelines") - 1) < 1e-9);
  assert.equal(textSimilarity("bananas apples oranges", "kubernetes terraform pipelines"), 0);
});

test("topSkills prefers job-defining skills over supporting ones, then by mentions", () => {
  const resume = "Git, HTML, CSS. Built APIs in Python and Django. More Python: scripts in Python. Used Docker once.";
  assert.deepEqual(topSkills(resume), ["python", "django", "docker"]);
  // With only supporting skills, still return them rather than nothing (tie order doesn't matter)
  assert.deepEqual(topSkills("Only Git and HTML here").sort(), ["git", "html"]);
  assert.deepEqual(topSkills("I like cooking"), []);
});

// ---------- resume files ----------

test("extractResumeText reads PDF text", async () => {
  const pdf = makePdf(["Jane Doe - Backend Developer", "Skills: Python, Django, PostgreSQL, Docker, AWS"]);
  const text = await extractResumeText(pdf, "resume.PDF");
  assert.match(text, /Backend Developer/);
  assert.deepEqual(topSkills(text), ["python", "django", "postgresql"]);
});

test("extractResumeText reads TXT and rejects unsupported or empty files", async () => {
  const txt = new TextEncoder().encode("Frontend developer with React, TypeScript and Next.js experience.");
  assert.match(await extractResumeText(txt, "cv.txt"), /React, TypeScript/);
  await assert.rejects(extractResumeText(txt, "cv.doc"), (e: { code: string }) => e.code === "unsupported");
  await assert.rejects(extractResumeText(new TextEncoder().encode("hi"), "cv.txt"), (e: { code: string }) => e.code === "empty");
  await assert.rejects(extractResumeText(new TextEncoder().encode("not a pdf"), "cv.pdf"), (e: { code: string }) => e.code === "unreadable");
});

// ---------- sources ----------

test("stripHtml removes tags and decodes double-encoded entities", () => {
  assert.equal(stripHtml("&amp;lt;p&amp;gt;Hello &amp;amp; welcome&amp;lt;/p&amp;gt;"), "Hello & welcome");
  assert.equal(stripHtml("<ul><li>Node&nbsp;JS</li><li>it&#39;s &#x41;</li></ul>"), "Node JS it's A");
});

// ---------- jobs ----------

test("relevance ranks title hits above description hits and rejects generic-only matches", () => {
  const inTitle = fakeJob({ title: "React Developer" });
  const inDesc = fakeJob({ description: "Some React work" });
  assert.ok(relevance(inTitle, ["react"]) > relevance(inDesc, ["react"]));
  assert.equal(relevance(fakeJob({ title: "Senior Developer" }), ["react", "developer"]), 0);
  assert.equal(relevance(fakeJob({ description: "proactive and reactive" }), ["react"]), 0);
});

test("searchJobs merges sources, dedupes, filters, ranks, and reports failures", async () => {
  const sourceA: JobSource = {
    name: "a",
    fetchJobs: async () => [
      fakeJob({ id: "a-1", title: "React Developer", company: "Acme", location: "India" }),
      fakeJob({ id: "a-2", title: "Office Manager", company: "Acme" }),
      fakeJob({ id: "a-3", title: "Frontend Engineer", description: "react", location: "USA only", remote: false }),
    ],
  };
  const sourceB: JobSource = {
    name: "b",
    fetchJobs: async () => [fakeJob({ id: "b-1", title: "React developer", company: "ACME", location: "India" })],
  };
  const broken: JobSource = { name: "broken", fetchJobs: async () => Promise.reject(new Error("boom")) };

  const all = await searchJobs({ query: "react" }, [sourceA, sourceB, broken]);
  assert.deepEqual(all.jobs.map((j) => j.id), ["a-1", "a-3"]); // b-1 deduped, a-2 irrelevant
  assert.deepEqual(all.warnings, ["broken unavailable: boom"]);
  assert.ok(getCachedJob("a-1"));

  const india = await searchJobs({ query: "react", location: "india" }, [sourceA]);
  assert.deepEqual(india.jobs.map((j) => j.id), ["a-1"]);

  const remote = await searchJobs({ query: "react", remoteOnly: true }, [sourceA]);
  assert.deepEqual(remote.jobs.map((j) => j.id), ["a-1"]);

  await assert.rejects(searchJobs({ query: "react" }, [broken]), /All job sources failed/);
});

test("searchBySkills runs one search per skill and merges without duplicates", async () => {
  const source: JobSource = {
    name: "fake",
    fetchJobs: async () => [
      fakeJob({ id: "f-1", title: "React Developer" }),
      fakeJob({ id: "f-2", title: "Python Developer" }),
      fakeJob({ id: "f-3", title: "React + Python Engineer" }),
      fakeJob({ id: "f-4", title: "Sales Manager" }),
    ],
  };
  const { jobs } = await searchBySkills(["react", "python"], {}, [source]);
  assert.deepEqual(jobs.map((j) => j.id).sort(), ["f-1", "f-2", "f-3"]);
});

// ---------- store ----------

test("store saves resume and tracks applications with stats and dedupe", async () => {
  const dir = path.join(os.tmpdir(), `jobpilot-unit-${process.pid}`);
  process.env.JOBPILOT_DATA_DIR = dir;
  const store = await import("./store.js");
  try {
    assert.equal(await store.getResume(), undefined);
    await store.saveResume("  My resume  ");
    assert.equal(await store.getResume(), "My resume");

    const first = await store.addApplication({ title: "Dev", company: "Acme", url: "https://x/1" });
    assert.equal(first.duplicate, false);
    const again = await store.addApplication({ title: "dev", company: "ACME" });
    assert.equal(again.duplicate, true);
    assert.equal(again.application.id, first.application.id);

    const second = await store.addApplication({ title: "Eng", company: "Beta" });
    await store.updateApplication(first.application.id, { status: "applied" });
    await store.updateApplication(second.application.id, { status: "interview" });

    const stats = await store.applicationStats();
    assert.equal(stats.total, 2);
    assert.equal(stats.byStatus.applied, 1);
    assert.equal(stats.responseRate, "50%");

    assert.equal(await store.deleteApplication(second.application.id), true);
    assert.equal(await store.deleteApplication("nope"), false);
    assert.equal((await store.listApplications()).length, 1);

    // Each web user gets a separate store that never sees anyone else's data.
    const alice = store.userStore("11111111-1111-4111-8111-111111111111");
    const bob = store.userStore("22222222-2222-4222-8222-222222222222");
    await alice.saveResume("Alice resume");
    await alice.addApplication({ title: "Dev", company: "Acme" });
    assert.equal(await bob.getResume(), undefined);
    assert.equal((await bob.listApplications()).length, 0);
    assert.equal(await alice.getResume(), "Alice resume");
    assert.throws(() => store.userStore("../../etc"), /Invalid user id/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------- auth ----------

test("auth: sign up, log in, sessions, and Google account linking", async () => {
  const dir = path.join(os.tmpdir(), `jobpilot-auth-${process.pid}`);
  process.env.JOBPILOT_DATA_DIR = dir;
  const auth = await import("./auth.js");
  const code = (c: string) => (e: unknown) => (e as { code: string }).code === c;
  try {
    const hash = await auth.hashPassword("secret123");
    assert.ok(hash.startsWith("scrypt$") && !hash.includes("secret123"));
    assert.equal(await auth.verifyPassword("secret123", hash), true);
    assert.equal(await auth.verifyPassword("wrong", hash), false);

    await assert.rejects(auth.signup({ name: "", email: "a@b.co", password: "12345678" }), code("name_required"));
    await assert.rejects(auth.signup({ name: "A", email: "not-an-email", password: "12345678" }), code("invalid_email"));
    await assert.rejects(auth.signup({ name: "A", email: "a@b.co", password: "short" }), code("weak_password"));

    const user = await auth.signup({ name: "Priya", email: "  Priya@Example.com ", password: "secret123" });
    assert.equal(user.email, "priya@example.com");
    await assert.rejects(auth.signup({ name: "P2", email: "priya@example.com", password: "another123" }), code("email_taken"));

    assert.equal((await auth.login("PRIYA@example.com", "secret123")).id, user.id);
    await assert.rejects(auth.login("priya@example.com", "wrongpass"), code("invalid_credentials"));
    await assert.rejects(auth.login("nobody@example.com", "secret123"), code("invalid_credentials"));

    const token = await auth.createSession(user.id);
    assert.equal((await auth.getSessionUser(token))?.id, user.id);
    assert.equal(await auth.getSessionUser("forged-token"), undefined);
    const sessionsRaw = await fs.readFile(path.join(dir, "sessions.json"), "utf8");
    assert.ok(!sessionsRaw.includes(token), "raw session tokens must not be stored");
    await auth.deleteSession(token);
    assert.equal(await auth.getSessionUser(token), undefined);

    // Google sign-in links to the existing email account instead of creating a duplicate
    const linked = await auth.findOrCreateGoogleUser({ sub: "g-1", email: "priya@example.com", name: "Priya G" });
    assert.equal(linked.id, user.id);
    const fresh = await auth.findOrCreateGoogleUser({ sub: "g-2", email: "new@example.com", name: "New User" });
    assert.notEqual(fresh.id, user.id);
    await assert.rejects(auth.login("new@example.com", "anything1"), code("use_google"));
    assert.equal((await auth.findOrCreateGoogleUser({ sub: "g-2", email: "new@example.com", name: "x" })).id, fresh.id);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
