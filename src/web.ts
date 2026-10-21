#!/usr/bin/env node
// JobPilot web app: landing page, sign up / login (email + Google), and the job search app.
// Every signed-in user gets their own resume and application tracker. Run with: npm run web

import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { searchJobs, searchBySkills, getCachedJob, scoreJob, type SearchResult } from "./jobs.js";
import { extractSkills, topSkills } from "./matcher.js";
import { extractResumeText, ResumeParseError } from "./resume.js";
import { STATUSES, type Status, type Store, userStore } from "./store.js";
import {
  AuthError,
  SESSION_TTL_MS,
  type User,
  signup,
  login,
  findOrCreateGoogleUser,
  createSession,
  getSessionUser,
  deleteSession,
  toPublic,
} from "./auth.js";
import { googleConfig, googleAuthUrl, googleProfile } from "./google.js";

// `||` rather than `??` so settings left blank in a hosting dashboard fall back to the defaults.
const PORT = Number(process.env.PORT || 3000);
// Local only by default; set HOST=0.0.0.0 when deploying.
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const SECURE_COOKIES = process.env.NODE_ENV === "production";
const TRUST_PROXY = process.env.TRUST_PROXY === "1"; // behind Render/Railway etc., read the client IP from X-Forwarded-For
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const MAX_JSON_BODY = 200_000;
const MAX_UPLOAD = 5 * 1024 * 1024;
const SESSION_COOKIE = "jp_session";
const STATE_COOKIE = "jp_oauth_state";
const GOOGLE_REDIRECT = `${PUBLIC_URL}/auth/google/callback`;

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string, // lets the page show the error in the user's language
  ) {
    super(message);
  }
}

// ---------- HTTP helpers ----------

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
};

function send(res: http.ServerResponse, status: number, data: unknown, headers: Record<string, string | string[]> = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(data));
}

function redirect(res: http.ServerResponse, location: string, headers: Record<string, string | string[]> = {}) {
  res.writeHead(302, { ...SECURITY_HEADERS, Location: location, ...headers });
  res.end();
}

function parseCookies(req: http.IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name: string, value: string, maxAgeSeconds: number): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
    SECURE_COOKIES ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

const sessionCookie = (token: string) => cookie(SESSION_COOKIE, token, SESSION_TTL_MS / 1000);
const clearSessionCookie = () => cookie(SESSION_COOKIE, "", 0);

async function readRaw(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "File or request too large", "too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const raw = (await readRaw(req, MAX_JSON_BODY)).toString("utf8");
  try {
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const isStatus = (v: unknown): v is Status => STATUSES.includes(v as Status);

function clientIp(req: http.IncomingMessage): string {
  const forwarded = TRUST_PROXY ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "";
  return forwarded || req.socket.remoteAddress || "unknown";
}

// Fixed-window limiter for login/sign-up attempts, per client IP.
const AUTH_LIMIT = 20;
const AUTH_WINDOW_MS = 15 * 60_000;
const authAttempts = new Map<string, { count: number; resetAt: number }>();
function checkAuthRate(req: http.IncomingMessage) {
  const ip = clientIp(req);
  const now = Date.now();
  const entry = authAttempts.get(ip);
  if (!entry || entry.resetAt < now) {
    authAttempts.set(ip, { count: 1, resetAt: now + AUTH_WINDOW_MS });
    return;
  }
  if (++entry.count > AUTH_LIMIT) throw new HttpError(429, "Too many attempts. Try again later.", "too_many_attempts");
}

async function currentUser(req: http.IncomingMessage): Promise<User | undefined> {
  return getSessionUser(parseCookies(req)[SESSION_COOKIE]);
}

// ---------- Pages and static assets ----------

const ASSET_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

async function sendFile(res: http.ServerResponse, file: string, type: string) {
  const body = await fs.readFile(file);
  res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": type });
  res.end(body);
}

const sendPage = (res: http.ServerResponse, name: string) =>
  sendFile(res, path.join(PUBLIC_DIR, name), "text/html; charset=utf-8");

async function serveAsset(res: http.ServerResponse, pathname: string) {
  const assetsDir = path.join(PUBLIC_DIR, "assets");
  const file = path.resolve(assetsDir, "." + decodeURIComponent(pathname.slice("/assets".length)));
  const type = ASSET_TYPES[path.extname(file)];
  // Refuse anything outside public/assets (e.g. "/assets/../../.env") and unknown file types.
  if (!file.startsWith(assetsDir + path.sep) || !type) return send(res, 404, { error: "Not found" });
  try {
    await sendFile(res, file, type);
  } catch {
    send(res, 404, { error: "Not found" });
  }
}

async function handlePage(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  switch (url.pathname) {
    case "/":
      return sendPage(res, "landing.html");
    case "/login":
    case "/signup":
      if (await currentUser(req)) return redirect(res, "/app");
      return sendPage(res, "auth.html");
    case "/app":
      if (!(await currentUser(req))) return redirect(res, "/login");
      return sendPage(res, "app.html");
    case "/auth/google":
      return startGoogle(res);
    case "/auth/google/callback":
      return finishGoogle(req, res, url);
    default:
      if (url.pathname.startsWith("/assets/")) return serveAsset(res, url.pathname);
      res.writeHead(404, { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
      res.end("Page not found");
  }
}

// ---------- Google sign-in ----------

function startGoogle(res: http.ServerResponse) {
  const cfg = googleConfig();
  if (!cfg) return redirect(res, "/login?error=google_not_configured");
  const state = crypto.randomBytes(16).toString("hex");
  redirect(res, googleAuthUrl(cfg, GOOGLE_REDIRECT, state), { "Set-Cookie": cookie(STATE_COOKIE, state, 600) });
}

async function finishGoogle(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const cfg = googleConfig();
  const clearState = cookie(STATE_COOKIE, "", 0);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expected = parseCookies(req)[STATE_COOKIE];
  // The state must match the cookie set in startGoogle, which blocks forged callbacks.
  if (!cfg || !code || !state || !expected || state !== expected) {
    return redirect(res, "/login?error=google_failed", { "Set-Cookie": clearState });
  }
  try {
    const user = await findOrCreateGoogleUser(await googleProfile(cfg, code, GOOGLE_REDIRECT));
    const token = await createSession(user.id);
    redirect(res, "/app", { "Set-Cookie": [clearState, sessionCookie(token)] });
  } catch (err) {
    console.error("Google sign-in failed:", (err as Error).message);
    redirect(res, "/login?error=google_failed", { "Set-Cookie": clearState });
  }
}

// ---------- Auth API ----------

async function handleAuthApi(req: http.IncomingMessage, res: http.ServerResponse, action: string) {
  const route = `${req.method} ${action}`;
  try {
    switch (route) {
      case "GET config":
        return send(res, 200, { google: Boolean(googleConfig()) });

      case "GET me": {
        const user = await currentUser(req);
        return user ? send(res, 200, { user: toPublic(user) }) : send(res, 401, { error: "Not signed in", code: "unauthorized" });
      }

      case "POST signup": {
        checkAuthRate(req);
        const body = await readBody(req);
        const user = await signup({
          name: String(body.name ?? ""),
          email: String(body.email ?? ""),
          password: String(body.password ?? ""),
        });
        const token = await createSession(user.id);
        return send(res, 200, { user: toPublic(user) }, { "Set-Cookie": sessionCookie(token) });
      }

      case "POST login": {
        checkAuthRate(req);
        const body = await readBody(req);
        const user = await login(String(body.email ?? ""), String(body.password ?? ""));
        const token = await createSession(user.id);
        return send(res, 200, { user: toPublic(user) }, { "Set-Cookie": sessionCookie(token) });
      }

      case "POST logout":
        await deleteSession(parseCookies(req)[SESSION_COOKIE]);
        return send(res, 200, { ok: true }, { "Set-Cookie": clearSessionCookie() });

      default:
        throw new HttpError(404, "Not found");
    }
  } catch (err) {
    if (err instanceof AuthError) throw new HttpError(err.code === "email_taken" ? 409 : 400, err.message, err.code);
    throw err;
  }
}

// ---------- App API (signed-in users only) ----------

function resumeInfo(resume: string) {
  return { resume, skills: [...extractSkills(resume)], topSkills: topSkills(resume) };
}

// Shapes search results for the page, scoring them against the user's resume when useResume is set.
async function scoredResults(store: Store, { jobs, totalMatches, warnings }: SearchResult, useResume: boolean, limit = 20) {
  const resume = useResume ? await store.getResume() : undefined;
  const results = jobs.map(({ description, ...job }) => {
    const m = resume ? scoreJob(resume, { ...job, description }) : undefined;
    return {
      ...job,
      preview: description.slice(0, 220),
      match: m && { score: m.score, matchedSkills: m.matchedSkills, missingSkills: m.missingSkills },
    };
  });
  if (resume) results.sort((a, b) => b.match!.score - a.match!.score);
  return { jobs: results.slice(0, limit), totalMatches, warnings, scored: Boolean(resume) };
}

async function handleAppApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL, user: User) {
  const store = userStore(user.id);
  // "/api/applications/abc123" -> route "PATCH /api/applications/:id", id "abc123"
  const [, , resource, rawId] = url.pathname.split("/");
  const route = `${req.method} /api/${resource}${rawId ? "/:id" : ""}`;
  const id = decodeURIComponent(rawId ?? "");

  switch (route) {
    case "GET /api/resume": {
      const resume = await store.getResume();
      return send(res, 200, resume ? resumeInfo(resume) : { resume: "", skills: [], topSkills: [] });
    }

    case "POST /api/resume": {
      const text = str((await readBody(req)).resume_text);
      if (!text || text.length < 50) throw new HttpError(400, "Resume must be at least 50 characters", "too_short");
      await store.saveResume(text);
      return send(res, 200, resumeInfo(text));
    }

    // Raw file body; the original filename comes in the X-Filename header.
    case "POST /api/upload": {
      const filename = decodeURIComponent(String(req.headers["x-filename"] ?? ""));
      if (!filename) throw new HttpError(400, "Missing X-Filename header");
      try {
        const text = await extractResumeText(await readRaw(req, MAX_UPLOAD), filename);
        await store.saveResume(text);
        return send(res, 200, resumeInfo(text));
      } catch (err) {
        if (err instanceof ResumeParseError) throw new HttpError(400, err.message, err.code);
        throw err;
      }
    }

    case "GET /api/jobs": {
      const query = str(url.searchParams.get("query"));
      if (!query) throw new HttpError(400, "query is required");
      const result = await searchJobs({
        query,
        location: str(url.searchParams.get("location")),
        remoteOnly: url.searchParams.get("remote") === "true",
        limit: 20,
      });
      // A typed search is independent of the resume unless the user opts in to scoring.
      return send(res, 200, await scoredResults(store, result, url.searchParams.get("match") === "true"));
    }

    // Jobs for the user's top resume skills, no typed query needed.
    case "GET /api/recommendations": {
      const resume = await store.getResume();
      if (!resume) throw new HttpError(400, "Upload or paste your resume first", "no_resume");
      const skills = topSkills(resume);
      if (skills.length === 0) throw new HttpError(400, "No skills detected in the resume", "no_skills");
      const result = await searchBySkills(skills, {
        location: str(url.searchParams.get("location")),
        remoteOnly: url.searchParams.get("remote") === "true",
      });
      return send(res, 200, { ...(await scoredResults(store, result, true)), skillsUsed: skills });
    }

    case "GET /api/jobs/:id": {
      const job = getCachedJob(id);
      if (!job) throw new HttpError(404, "Job not found. Search again.", "job_not_found");
      return send(res, 200, job);
    }

    case "GET /api/applications": {
      const [applications, stats] = await Promise.all([store.listApplications(), store.applicationStats()]);
      return send(res, 200, { applications: applications.reverse(), stats });
    }

    case "POST /api/applications": {
      const job = getCachedJob(str((await readBody(req)).job_id) ?? "");
      if (!job) throw new HttpError(404, "Job not found. Search again.", "job_not_found");
      return send(res, 200, await store.addApplication({ jobId: job.id, title: job.title, company: job.company, url: job.url }));
    }

    case "PATCH /api/applications/:id": {
      const { status, notes } = await readBody(req);
      if (status !== undefined && !isStatus(status)) throw new HttpError(400, "Invalid status");
      const app = await store.updateApplication(id, { status, notes: typeof notes === "string" ? notes : undefined });
      if (!app) throw new HttpError(404, "Application not found");
      return send(res, 200, app);
    }

    case "DELETE /api/applications/:id":
      if (!(await store.deleteApplication(id))) throw new HttpError(404, "Application not found");
      return send(res, 200, { deleted: id });

    default:
      throw new HttpError(404, "Not found");
  }
}

// ---------- Server ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", PUBLIC_URL);
  try {
    if (url.pathname.startsWith("/api/auth/")) {
      await handleAuthApi(req, res, url.pathname.slice("/api/auth/".length));
    } else if (url.pathname.startsWith("/api/")) {
      const user = await currentUser(req);
      if (!user) throw new HttpError(401, "Please log in", "unauthorized");
      await handleAppApi(req, res, url, user);
    } else if (req.method === "GET") {
      await handlePage(req, res, url);
    } else {
      throw new HttpError(405, "Method not allowed");
    }
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) {
      send(res, status, {
        error: status === 500 ? "Something went wrong" : (err as Error).message,
        code: err instanceof HttpError ? err.code : undefined,
      });
    }
  }
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Set a different PORT in .env`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log(`\n  JobPilot is running at  ${PUBLIC_URL}`);
  console.log(`  Google sign-in: ${googleConfig() ? "enabled" : "not configured (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)"}\n`);
});
