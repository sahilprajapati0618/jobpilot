#!/usr/bin/env node
// JobPilot MCP server: exposes job search, resume matching, and application tracking as MCP tools,
// plus prompts for cover letters and interview prep.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { promises as fs } from "node:fs";
import { searchJobs, searchBySkills, getCachedJob, scoreJob, type Job } from "./jobs.js";
import { matchResume, extractSkills, topSkills } from "./matcher.js";
import { extractResumeText } from "./resume.js";
import {
  STATUSES,
  addApplication,
  updateApplication,
  deleteApplication,
  listApplications,
  applicationStats,
  saveResume,
  getResume,
} from "./store.js";

const VERSION = "0.2.0";
const server = new McpServer({ name: "jobpilot", version: VERSION });

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function error(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

// Compact view for lists: a short preview instead of the full description.
function summary({ description, ...job }: Job) {
  return { ...job, preview: description.length > 200 ? description.slice(0, 200) + "..." : description };
}

const NO_RESUME = "No resume provided and none saved. Pass resume_text or call save_resume first.";
const jobNotFound = (id: string) =>
  `Job ${id} not found. Job IDs come from search_jobs or rank_jobs and last until the server restarts.`;

async function resolveResume(resumeText?: string): Promise<string | undefined> {
  return resumeText?.trim() || (await getResume());
}

// ---------- Search ----------

const searchInput = {
  query: z.string().min(1).describe("Keywords, e.g. 'react developer' or 'python'"),
  location: z.string().optional().describe("Filter by location, e.g. 'India', 'Europe', 'Berlin'"),
  remote_only: z.boolean().default(false).describe("Only return remote jobs"),
};

server.registerTool(
  "search_jobs",
  {
    title: "Search jobs",
    description:
      "Search live job listings across multiple job boards (Remotive, Jobicy, Arbeitnow), ranked by relevance. " +
      "Returns job IDs usable with the other tools.",
    inputSchema: {
      ...searchInput,
      limit: z.number().int().min(1).max(25).default(10).describe("Max results to return"),
    },
  },
  async ({ query, location, remote_only, limit }) => {
    try {
      const { jobs, totalMatches, warnings } = await searchJobs({ query, location, remoteOnly: remote_only, limit });
      if (jobs.length === 0) return text({ message: "No jobs found. Try broader keywords or drop the location.", warnings });
      return text({ showing: jobs.length, totalMatches, warnings, jobs: jobs.map(summary) });
    } catch (err) {
      return error(`Job search failed: ${(err as Error).message}`);
    }
  },
);

server.registerTool(
  "rank_jobs",
  {
    title: "Find best-fit jobs",
    description:
      "Search jobs and rank them by how well they fit the resume (uses the saved resume if resume_text is omitted). " +
      "Omit query to search by the resume's top skills automatically. Best for requests like 'find jobs that suit me'.",
    inputSchema: {
      ...searchInput,
      query: searchInput.query.optional().describe("Keywords; omit to search by the resume's top skills"),
      resume_text: z.string().optional().describe("Resume text; defaults to the saved resume"),
      limit: z.number().int().min(1).max(15).default(5).describe("How many top matches to return"),
    },
  },
  async ({ query, location, remote_only, resume_text, limit }) => {
    const resume = await resolveResume(resume_text);
    if (!resume) return error(NO_RESUME);
    const skillsUsed = query ? undefined : topSkills(resume);
    if (skillsUsed?.length === 0) return error("No skills detected in the resume. Pass a query instead.");
    try {
      // Score a wider pool than requested so the best fits aren't cut off by relevance ordering.
      const { jobs, warnings } = query
        ? await searchJobs({ query, location, remoteOnly: remote_only, limit: 30 })
        : await searchBySkills(skillsUsed!, { location, remoteOnly: remote_only });
      const ranked = jobs
        .map((job) => {
          const m = scoreJob(resume, job);
          return {
            id: job.id,
            title: job.title,
            company: job.company,
            location: job.location,
            salary: job.salary,
            url: job.url,
            score: m.score,
            matchedSkills: m.matchedSkills,
            missingSkills: m.missingSkills,
          };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      if (ranked.length === 0) return text({ message: "No jobs found. Try broader keywords.", skillsUsed, warnings });
      return text({ scored: jobs.length, skillsUsed, warnings, topMatches: ranked });
    } catch (err) {
      return error(`Job search failed: ${(err as Error).message}`);
    }
  },
);

server.registerTool(
  "get_job_details",
  {
    title: "Get job details",
    description: "Get the full description and details of a job returned by search_jobs or rank_jobs.",
    inputSchema: { job_id: z.string().describe("Job ID, e.g. 'remotive-123456'") },
  },
  async ({ job_id }) => {
    const job = getCachedJob(job_id);
    return job ? text(job) : error(jobNotFound(job_id));
  },
);

// ---------- Resume ----------

server.registerTool(
  "save_resume",
  {
    title: "Save resume",
    description:
      "Save the user's resume so other tools can use it without pasting it every time. " +
      "Pass resume_text, or file_path to a local PDF, DOCX, or TXT file.",
    inputSchema: {
      resume_text: z.string().min(50).optional().describe("Full resume text"),
      file_path: z.string().optional().describe("Absolute path to a resume file (.pdf, .docx, .txt)"),
    },
  },
  async ({ resume_text, file_path }) => {
    let resume = resume_text;
    if (!resume && file_path) {
      try {
        resume = await extractResumeText(await fs.readFile(file_path), file_path);
      } catch (err) {
        return error(`Could not read ${file_path}: ${(err as Error).message}`);
      }
    }
    if (!resume) return error("Provide resume_text or file_path.");
    await saveResume(resume);
    return text({ saved: true, characters: resume.trim().length, skills: [...extractSkills(resume)], topSkills: topSkills(resume) });
  },
);

server.registerTool(
  "get_resume",
  {
    title: "Get saved resume",
    description: "Return the currently saved resume.",
    inputSchema: {},
  },
  async () => {
    const resume = await getResume();
    return resume ? text({ resume }) : error("No resume saved yet. Use save_resume first.");
  },
);

server.registerTool(
  "match_resume",
  {
    title: "Match resume to job",
    description:
      "Score how well a resume fits one job (0-100) with matched, missing, and key skills. " +
      "Pass a job_id from search_jobs/rank_jobs, or a raw job_description. Uses the saved resume if resume_text is omitted.",
    inputSchema: {
      resume_text: z.string().optional().describe("Resume text; defaults to the saved resume"),
      job_id: z.string().optional().describe("A job ID from search_jobs or rank_jobs"),
      job_description: z.string().optional().describe("Raw job description text, if not using job_id"),
    },
  },
  async ({ resume_text, job_id, job_description }) => {
    const resume = await resolveResume(resume_text);
    if (!resume) return error(NO_RESUME);

    if (job_id) {
      const job = getCachedJob(job_id);
      if (!job) return error(jobNotFound(job_id));
      return text({ job: { id: job.id, title: job.title, company: job.company }, ...scoreJob(resume, job) });
    }
    if (job_description) return text(matchResume(resume, job_description));
    return error("Provide either job_id or job_description.");
  },
);

// ---------- Application tracker ----------

server.registerTool(
  "save_application",
  {
    title: "Track a job application",
    description:
      "Add a job to the application tracker. Pass job_id to fill in details automatically, or give title and company.",
    inputSchema: {
      job_id: z.string().optional().describe("Job ID from search_jobs/rank_jobs"),
      title: z.string().optional().describe("Job title (required without job_id)"),
      company: z.string().optional().describe("Company name (required without job_id)"),
      url: z.string().optional().describe("Link to the job posting"),
      status: z.enum(STATUSES).default("saved"),
      notes: z.string().optional(),
    },
  },
  async ({ job_id, title, company, url, status, notes }) => {
    const job = job_id ? getCachedJob(job_id) : undefined;
    if (job_id && !job && !(title && company)) return error(jobNotFound(job_id));

    const finalTitle = title ?? job?.title;
    const finalCompany = company ?? job?.company;
    if (!finalTitle || !finalCompany) return error("Provide job_id, or both title and company.");

    const { application, duplicate } = await addApplication({
      jobId: job_id,
      title: finalTitle,
      company: finalCompany,
      url: url ?? job?.url,
      status,
      notes,
    });
    return text(
      duplicate
        ? { message: "This job is already tracked. Use update_application to change it.", application }
        : application,
    );
  },
);

server.registerTool(
  "update_application",
  {
    title: "Update application status",
    description: "Change the status (saved → applied → interview → offer/rejected) or notes of a tracked application.",
    inputSchema: {
      id: z.string().describe("Application ID from save_application or list_applications"),
      status: z.enum(STATUSES).optional(),
      notes: z.string().optional(),
    },
  },
  async ({ id, ...changes }) => {
    const app = await updateApplication(id, changes);
    return app ? text(app) : error(`No application with id ${id}.`);
  },
);

server.registerTool(
  "delete_application",
  {
    title: "Delete application",
    description: "Remove an application from the tracker.",
    inputSchema: { id: z.string().describe("Application ID") },
  },
  async ({ id }) => ((await deleteApplication(id)) ? text({ deleted: id }) : error(`No application with id ${id}.`)),
);

server.registerTool(
  "list_applications",
  {
    title: "List tracked applications",
    description: "List tracked job applications (optionally filtered by status) with overall stats.",
    inputSchema: { status: z.enum(STATUSES).optional() },
  },
  async ({ status }) => {
    const [applications, stats] = await Promise.all([listApplications(status), applicationStats()]);
    return text({ stats, applications });
  },
);

// ---------- Prompts ----------

async function jobAndResume(jobId: string): Promise<{ job: Job; resume: string } | string> {
  const job = getCachedJob(jobId);
  if (!job) return jobNotFound(jobId);
  const resume = await getResume();
  if (!resume) return "No resume saved. Call save_resume first.";
  return { job, resume };
}

function promptMessage(body: string) {
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text: body } }] };
}

function jobBlock(job: Job): string {
  return `Job: ${job.title} at ${job.company} (${job.location})\nURL: ${job.url}\n\nDescription:\n${job.description}`;
}

server.registerPrompt(
  "cover_letter",
  {
    title: "Write a cover letter",
    description: "Draft a tailored cover letter for a job using the saved resume.",
    argsSchema: { job_id: z.string().describe("Job ID from search_jobs or rank_jobs") },
  },
  async ({ job_id }) => {
    const data = await jobAndResume(job_id);
    if (typeof data === "string") return promptMessage(`Tell the user: ${data}`);
    const { job, resume } = data;
    const m = scoreJob(resume, job);
    return promptMessage(
      `Write a concise, specific cover letter (250-350 words) for this job.\n\n` +
        `Lead with the candidate's strongest matching skills: ${m.matchedSkills.join(", ") || "none detected"}.\n` +
        `Do not claim skills the resume doesn't show. If relevant, briefly show eagerness to learn: ${m.missingSkills.slice(0, 3).join(", ") || "n/a"}.\n` +
        `Avoid generic filler; reference concrete projects or results from the resume.\n\n` +
        `${jobBlock(job)}\n\nResume:\n${resume}`,
    );
  },
);

server.registerPrompt(
  "interview_prep",
  {
    title: "Prepare for an interview",
    description: "Generate likely interview questions and talking points for a job, based on the saved resume.",
    argsSchema: { job_id: z.string().describe("Job ID from search_jobs or rank_jobs") },
  },
  async ({ job_id }) => {
    const data = await jobAndResume(job_id);
    if (typeof data === "string") return promptMessage(`Tell the user: ${data}`);
    const { job, resume } = data;
    return promptMessage(
      `Help the candidate prepare for an interview for this job. Provide:\n` +
        `1. 5 technical questions likely for this role, each with a short model answer drawing on the resume\n` +
        `2. 3 behavioral questions with STAR-format talking points from the resume\n` +
        `3. The 2-3 biggest gaps between the resume and the job, and how to address them honestly\n` +
        `4. 3 smart questions the candidate can ask the interviewer\n\n` +
        `${jobBlock(job)}\n\nResume:\n${resume}`,
    );
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`JobPilot MCP server v${VERSION} running on stdio`);
