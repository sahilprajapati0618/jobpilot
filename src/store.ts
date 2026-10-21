// Persists resumes and tracked job applications as JSON files.
// The MCP server uses the default store in ~/.jobpilot/ (override with JOBPILOT_DATA_DIR);
// the web app gives every signed-in user their own store under <data dir>/users/<user id>/.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const STATUSES = ["saved", "applied", "interview", "offer", "rejected"] as const;
export type Status = (typeof STATUSES)[number];

export interface Application {
  id: string;
  jobId?: string;
  title: string;
  company: string;
  url?: string;
  status: Status;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Stats {
  total: number;
  byStatus: Record<Status, number>;
  responseRate: string; // share of applied jobs that reached interview or beyond
}

export function dataDir(): string {
  return process.env.JOBPILOT_DATA_DIR ?? path.join(os.homedir(), ".jobpilot");
}

// ---------- File helpers (shared with auth.ts) ----------

export async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw err;
  }
}

// Writes to a temp file then renames, so a crash mid-write can't corrupt existing data.
export async function writeFileAtomic(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, file);
}

// ---------- Store ----------

export function createStore(dir: () => string) {
  const appsFile = () => path.join(dir(), "applications.json");
  const resumeFile = () => path.join(dir(), "resume.txt");
  const loadApps = () => readJsonFile<Application[]>(appsFile(), []);
  const saveApps = (apps: Application[]) => writeFileAtomic(appsFile(), JSON.stringify(apps, null, 2));

  return {
    async saveResume(text: string): Promise<void> {
      await writeFileAtomic(resumeFile(), text.trim());
    },

    async getResume(): Promise<string | undefined> {
      try {
        return (await fs.readFile(resumeFile(), "utf8")) || undefined;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw err;
      }
    },

    async addApplication(
      input: Pick<Application, "title" | "company" | "url" | "notes" | "jobId"> & { status?: Status },
    ): Promise<{ application: Application; duplicate: boolean }> {
      const apps = await loadApps();

      const sameJob = (a: Application) =>
        (input.jobId && a.jobId === input.jobId) ||
        (input.url && a.url === input.url) ||
        (a.title.toLowerCase() === input.title.toLowerCase() && a.company.toLowerCase() === input.company.toLowerCase());
      const existing = apps.find(sameJob);
      if (existing) return { application: existing, duplicate: true };

      const now = new Date().toISOString();
      const application: Application = {
        id: randomUUID().slice(0, 8),
        jobId: input.jobId,
        title: input.title,
        company: input.company,
        url: input.url,
        notes: input.notes,
        status: input.status ?? "saved",
        createdAt: now,
        updatedAt: now,
      };
      apps.push(application);
      await saveApps(apps);
      return { application, duplicate: false };
    },

    async updateApplication(
      id: string,
      changes: { status?: Status; notes?: string },
    ): Promise<Application | undefined> {
      const apps = await loadApps();
      const app = apps.find((a) => a.id === id);
      if (!app) return undefined;
      if (changes.status) app.status = changes.status;
      if (changes.notes !== undefined) app.notes = changes.notes;
      app.updatedAt = new Date().toISOString();
      await saveApps(apps);
      return app;
    },

    async deleteApplication(id: string): Promise<boolean> {
      const apps = await loadApps();
      const remaining = apps.filter((a) => a.id !== id);
      if (remaining.length === apps.length) return false;
      await saveApps(remaining);
      return true;
    },

    async listApplications(status?: Status): Promise<Application[]> {
      const apps = await loadApps();
      return status ? apps.filter((a) => a.status === status) : apps;
    },

    async applicationStats(): Promise<Stats> {
      const apps = await loadApps();
      const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
      for (const a of apps) byStatus[a.status]++;

      // Everything past "saved" was applied to at some point.
      const applied = apps.length - byStatus.saved;
      const responded = byStatus.interview + byStatus.offer;
      const responseRate = applied === 0 ? "n/a" : `${Math.round((responded / applied) * 100)}%`;
      return { total: apps.length, byStatus, responseRate };
    },
  };
}

export type Store = ReturnType<typeof createStore>;

export function userStore(userId: string): Store {
  // User IDs are server-generated UUIDs; reject anything else so an ID can never escape the data dir.
  if (!/^[a-f0-9-]{36}$/.test(userId)) throw new Error("Invalid user id");
  return createStore(() => path.join(dataDir(), "users", userId));
}

// Default single-user store, used by the MCP server.
export const {
  saveResume,
  getResume,
  addApplication,
  updateApplication,
  deleteApplication,
  listApplications,
  applicationStats,
} = createStore(dataDir);
