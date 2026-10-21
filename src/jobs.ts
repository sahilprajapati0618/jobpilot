// Searches all job sources in parallel, then dedupes, filters, and ranks results by relevance.

import { ALL_SOURCES, type Job, type JobSource } from "./sources.js";
import { matchResume, type MatchResult } from "./matcher.js";

export type { Job } from "./sources.js";

export interface SearchOptions {
  query: string;
  location?: string;
  remoteOnly?: boolean;
  limit?: number;
}

export interface SearchResult {
  jobs: Job[];
  totalMatches: number;
  warnings: string[]; // sources that failed; the search still returns what the others found
}

// In-memory cache so other tools (match_resume, get_job_details, ...) can refer to jobs by ID.
const jobCache = new Map<string, Job>();

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ""))
    .filter((t) => t.length > 1);
}

// Words that describe almost every tech job, so they shouldn't count as a relevant match on their own.
const GENERIC_TERMS = new Set(["developer", "engineer", "software", "remote", "job", "jobs", "senior", "junior"]);

// Higher is more relevant. Title hits matter most, then tags, then the description body.
// Returns 0 when none of the specific (non-generic) terms appear anywhere.
export function relevance(job: Job, terms: string[]): number {
  const title = job.title.toLowerCase();
  const tags = job.tags.join(" ").toLowerCase();
  const desc = job.description.toLowerCase();

  let score = 0;
  let specificHit = false;
  for (const term of terms) {
    const re = new RegExp(`(^|[^a-z0-9])${escapeRegex(term)}(?![a-z0-9])`, "i");
    const hit = (re.test(title) ? 5 : 0) + (re.test(tags) ? 3 : 0) + (re.test(desc) ? 1 : 0);
    score += hit;
    if (hit > 0 && !GENERIC_TERMS.has(term)) specificHit = true;
  }
  const hasSpecificTerms = terms.some((t) => !GENERIC_TERMS.has(t));
  return hasSpecificTerms && !specificHit ? 0 : score;
}

function matchesLocation(job: Job, location: string): boolean {
  const loc = job.location.toLowerCase();
  return loc.includes(location.toLowerCase()) || /worldwide|anywhere|global/.test(loc);
}

function dedupeKey(job: Job): string {
  return `${job.title}|${job.company}`.toLowerCase().replace(/[^a-z0-9|]/g, "");
}

export async function searchJobs(
  { query, location, remoteOnly = false, limit = 10 }: SearchOptions,
  sources: JobSource[] = ALL_SOURCES,
): Promise<SearchResult> {
  const results = await Promise.allSettled(sources.map((s) => s.fetchJobs(query)));

  const warnings: string[] = [];
  const all: Job[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") all.push(...r.value);
    else warnings.push(`${sources[i].name} unavailable: ${(r.reason as Error).message}`);
  });
  if (all.length === 0 && warnings.length === sources.length) {
    throw new Error(`All job sources failed. ${warnings.join("; ")}`);
  }

  const terms = queryTerms(query);
  const seen = new Set<string>();
  const ranked = all
    .filter((job) => {
      const key = dedupeKey(job);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .filter((job) => !remoteOnly || job.remote)
    .filter((job) => !location || matchesLocation(job, location))
    .map((job) => ({ job, score: relevance(job, terms) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.job.postedAt.localeCompare(a.job.postedAt))
    .map(({ job }) => job);

  const jobs = ranked.slice(0, limit);
  for (const job of jobs) jobCache.set(job.id, job);
  return { jobs, totalMatches: ranked.length, warnings };
}

// Runs one search per skill and merges the results, for "find jobs that fit my skills" without a typed query.
export async function searchBySkills(
  skills: string[],
  { location, remoteOnly }: Omit<SearchOptions, "query" | "limit"> = {},
  sources: JobSource[] = ALL_SOURCES,
): Promise<SearchResult> {
  const results = await Promise.allSettled(
    skills.map((query) => searchJobs({ query, location, remoteOnly, limit: 30 }, sources)),
  );

  const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failures.length === results.length) throw failures[0].reason;

  const seen = new Set<string>();
  const jobs: Job[] = [];
  const warnings = new Set<string>();
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    r.value.warnings.forEach((w) => warnings.add(w));
    for (const job of r.value.jobs) {
      const key = dedupeKey(job);
      if (!seen.has(key)) {
        seen.add(key);
        jobs.push(job);
      }
    }
  }
  return { jobs, totalMatches: jobs.length, warnings: [...warnings] };
}

export function getCachedJob(id: string): Job | undefined {
  return jobCache.get(id);
}

// Text used for matching. Skills found in `core` (title + tags) are treated as the job's key requirements.
export function jobMatchText(job: Job): { full: string; core: string } {
  const core = `${job.title} ${job.tags.join(" ")}`;
  return { full: `${core} ${job.description}`, core };
}

export function scoreJob(resume: string, job: Job): MatchResult {
  const { full, core } = jobMatchText(job);
  return matchResume(resume, full, core);
}
