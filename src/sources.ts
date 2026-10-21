// Job board adapters. Each one fetches listings from a free public API (no API keys)
// and normalizes them into the shared Job shape.

export interface Job {
  id: string; // "<source>-<native id>", unique across sources
  source: string;
  title: string;
  company: string;
  location: string;
  remote: boolean;
  jobType: string;
  salary: string;
  url: string;
  postedAt: string; // ISO date
  tags: string[];
  description: string; // plain text, HTML stripped
}

export interface JobSource {
  name: string;
  fetchJobs(query: string): Promise<Job[]>;
}

const TIMEOUT_MS = 15_000;

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;|&rsquo;|&lsquo;/g, "'")
    .replace(/&rdquo;|&ldquo;/g, '"')
    .replace(/&ndash;|&mdash;/g, "-")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

export function stripHtml(html: string): string {
  // Some feeds double-encode their HTML (&amp;lt;p&amp;gt;), so decode until stable before stripping tags.
  let s = html;
  for (let i = 0; i < 3; i++) {
    const decoded = decodeEntities(s);
    if (decoded === s) break;
    s = decoded;
  }
  return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

// Short-lived response cache: a skills search queries the same feeds several times in a row,
// and Arbeitnow returns the same full listing for every query.
const CACHE_TTL_MS = 5 * 60_000;
const responseCache = new Map<string, { at: number; data: unknown }>();

async function getJson<T>(url: string): Promise<T> {
  const hit = responseCache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data as T;

  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "User-Agent": "jobpilot-mcp" },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const data = (await res.json()) as T;
  responseCache.set(url, { at: Date.now(), data });
  return data;
}

// --- Remotive: remote jobs, supports server-side search ---

interface RemotiveJob {
  id: number;
  url: string;
  title: string;
  company_name: string;
  tags: string[];
  job_type: string;
  publication_date: string;
  candidate_required_location: string;
  salary: string;
  description: string;
}

export const remotive: JobSource = {
  name: "remotive",
  async fetchJobs(query) {
    const params = new URLSearchParams({ search: query, limit: "50" });
    const data = await getJson<{ jobs: RemotiveJob[] }>(`https://remotive.com/api/remote-jobs?${params}`);
    return data.jobs.map((j) => ({
      id: `remotive-${j.id}`,
      source: "remotive",
      title: j.title,
      company: j.company_name,
      location: j.candidate_required_location || "Worldwide",
      remote: true,
      jobType: j.job_type?.replace(/_/g, " ") || "Not specified",
      salary: j.salary || "Not disclosed",
      url: j.url,
      postedAt: new Date(j.publication_date).toISOString(),
      tags: j.tags ?? [],
      description: stripHtml(j.description ?? ""),
    }));
  },
};

// --- Jobicy: remote jobs, filters by a single tag/keyword ---

interface JobicyJob {
  id: number;
  url: string;
  jobTitle: string;
  companyName: string;
  jobIndustry?: string[];
  jobType?: string[] | string;
  jobGeo?: string;
  jobLevel?: string;
  jobDescription?: string;
  pubDate: string;
  salaryMin?: number;
  salaryMax?: number;
  salaryCurrency?: string;
}

export const jobicy: JobSource = {
  name: "jobicy",
  async fetchJobs(query) {
    const params = new URLSearchParams({ count: "50", tag: query });
    const data = await getJson<{ jobs?: JobicyJob[] }>(`https://jobicy.com/api/v2/remote-jobs?${params}`);
    return (data.jobs ?? []).map((j) => {
      const salary =
        j.salaryMin && j.salaryMax
          ? `${j.salaryCurrency ?? ""} ${j.salaryMin.toLocaleString()} - ${j.salaryMax.toLocaleString()}`.trim()
          : "Not disclosed";
      const jobType = Array.isArray(j.jobType) ? j.jobType.join(", ") : j.jobType;
      return {
        id: `jobicy-${j.id}`,
        source: "jobicy",
        title: stripHtml(j.jobTitle),
        company: stripHtml(j.companyName),
        location: j.jobGeo || "Worldwide",
        remote: true,
        jobType: jobType || "Not specified",
        salary,
        url: j.url,
        postedAt: new Date(j.pubDate).toISOString(),
        tags: [...(j.jobIndustry ?? []).map(stripHtml), ...(j.jobLevel ? [j.jobLevel] : [])],
        description: stripHtml(j.jobDescription ?? ""),
      };
    });
  },
};

// --- Arbeitnow: mostly European jobs (remote and on-site). No search param, so filtering happens in jobs.ts ---

interface ArbeitnowJob {
  slug: string;
  company_name: string;
  title: string;
  description: string;
  remote: boolean;
  url: string;
  tags: string[];
  job_types: string[];
  location: string;
  created_at: number; // unix seconds
}

export const arbeitnow: JobSource = {
  name: "arbeitnow",
  async fetchJobs() {
    const data = await getJson<{ data: ArbeitnowJob[] }>("https://www.arbeitnow.com/api/job-board-api");
    return data.data.map((j) => ({
      id: `arbeitnow-${j.slug}`,
      source: "arbeitnow",
      title: j.title,
      company: j.company_name,
      location: j.remote ? `Remote (${j.location})` : j.location,
      remote: j.remote,
      jobType: j.job_types?.join(", ") || "Not specified",
      salary: "Not disclosed",
      url: j.url,
      postedAt: new Date(j.created_at * 1000).toISOString(),
      tags: j.tags ?? [],
      description: stripHtml(j.description ?? ""),
    }));
  },
};

export const ALL_SOURCES: JobSource[] = [remotive, jobicy, arbeitnow];
