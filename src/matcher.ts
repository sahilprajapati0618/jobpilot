// Scores how well a resume fits a job. The score blends two signals:
//   1. Skill overlap (80%): skills from a curated dictionary, with "core" skills (in the job title/tags) weighted 2x
//   2. Text similarity (20%): cosine similarity of word frequencies, catching overlap the dictionary misses

const SKILLS: Record<string, string[]> = {
  // languages
  javascript: ["javascript", "js", "es6"],
  typescript: ["typescript", "ts"],
  python: ["python"],
  java: ["java"],
  go: ["golang", "go lang"], // plain "go" is too common an English word
  rust: ["rust"],
  "c++": ["c++", "cpp"],
  "c#": ["c#", "csharp"],
  php: ["php"],
  ruby: ["ruby"],
  kotlin: ["kotlin"],
  swift: ["swift"],
  sql: ["sql"],
  // frontend
  react: ["react", "reactjs", "react.js"],
  "next.js": ["next.js", "nextjs"],
  vue: ["vue", "vuejs", "vue.js"],
  angular: ["angular"],
  html: ["html", "html5"],
  css: ["css", "css3"],
  tailwind: ["tailwind", "tailwindcss"],
  redux: ["redux"],
  // backend
  "node.js": ["node.js", "nodejs", "node"],
  express: ["express", "express.js"],
  django: ["django"],
  flask: ["flask"],
  fastapi: ["fastapi"],
  "spring boot": ["spring boot", "spring framework"],
  graphql: ["graphql"],
  "rest api": ["rest api", "rest apis", "restful"],
  // data / storage
  postgresql: ["postgresql", "postgres"],
  mysql: ["mysql"],
  mongodb: ["mongodb", "mongo"],
  redis: ["redis"],
  elasticsearch: ["elasticsearch"],
  kafka: ["kafka"],
  // cloud / devops
  aws: ["aws", "amazon web services"],
  gcp: ["gcp", "google cloud"],
  azure: ["azure"],
  docker: ["docker"],
  kubernetes: ["kubernetes", "k8s"],
  terraform: ["terraform"],
  "ci/cd": ["ci/cd", "github actions", "jenkins", "gitlab ci"],
  ansible: ["ansible"],
  helm: ["helm"],
  prometheus: ["prometheus"],
  grafana: ["grafana"],
  bash: ["bash", "shell scripting"],
  linux: ["linux"],
  git: ["git", "github"],
  // AI / data
  "machine learning": ["machine learning", "ml"],
  "deep learning": ["deep learning"],
  llm: ["llm", "llms", "large language model"],
  "generative ai": ["generative ai", "genai"],
  rag: ["rag", "retrieval augmented generation", "retrieval-augmented"],
  langchain: ["langchain"],
  pytorch: ["pytorch"],
  tensorflow: ["tensorflow"],
  pandas: ["pandas"],
  numpy: ["numpy"],
  nlp: ["nlp", "natural language processing"],
  spark: ["spark", "pyspark"],
  airflow: ["airflow"],
  tableau: ["tableau"],
  "power bi": ["power bi", "powerbi"],
  excel: ["excel"],
  // more frameworks
  nestjs: ["nestjs", "nest.js"],
  laravel: ["laravel"],
  rails: ["ruby on rails", "rails"],
  // testing / design
  jest: ["jest"],
  playwright: ["playwright"],
  cypress: ["cypress"],
  figma: ["figma"],
  // mobile
  "react native": ["react native"],
  flutter: ["flutter"],
  android: ["android"],
  ios: ["ios"],
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Precompile one regex per alias, with boundaries that also work for "c++", "c#", "next.js".
const SKILL_PATTERNS = Object.entries(SKILLS).map(([skill, aliases]) => ({
  skill,
  patterns: aliases.map((a) => new RegExp(`(^|[^a-z0-9+#.])${escapeRegex(a)}(?![a-z0-9+#])`, "i")),
}));

export function extractSkills(text: string): Set<string> {
  return new Set(skillCounts(text).keys());
}

// How many times each skill is mentioned, which hints at what the candidate is strongest in.
export function skillCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { skill, patterns } of SKILL_PATTERNS) {
    const n = patterns.reduce((sum, p) => sum + (text.match(new RegExp(p.source, "gi"))?.length ?? 0), 0);
    if (n > 0) counts.set(skill, n);
  }
  // "react native" also contains "react"; only keep plain react if it appears on its own.
  if (counts.has("react native")) {
    const plain = text.match(/react(?!\s*native)/gi)?.length ?? 0;
    if (plain === 0) counts.delete("react");
    else counts.set("react", plain);
  }
  return counts;
}

// Skills nearly every developer lists. They make poor job search keywords on their own.
const SUPPORTING_SKILLS = new Set([
  "git", "html", "css", "sql", "rest api", "linux", "excel", "ci/cd", "jest", "cypress", "playwright",
  "figma", "tailwind", "redux", "numpy", "pandas", "bash",
]);

// The resume's most job-defining skills, best search keywords first.
export function topSkills(resumeText: string, limit = 3): string[] {
  return [...skillCounts(resumeText)]
    .sort(([a, na], [b, nb]) => Number(SUPPORTING_SKILLS.has(a)) - Number(SUPPORTING_SKILLS.has(b)) || nb - na)
    .slice(0, limit)
    .map(([skill]) => skill);
}

const STOPWORDS = new Set(
  (
    "a an and are as at be by for from has have in is it its of on or our that the their this to was we will with " +
    "you your they them who what which work working team experience years year role job using use also can able " +
    "about all any into more most other such than then there these those through very well would should must"
  ).split(" "),
);

function wordFrequencies(text: string): Map<string, number> {
  const freq = new Map<string, number>();
  for (const word of text.toLowerCase().match(/[a-z][a-z0-9+#.]*[a-z0-9+#]|[a-z]/g) ?? []) {
    if (word.length < 3 || STOPWORDS.has(word)) continue;
    freq.set(word, (freq.get(word) ?? 0) + 1);
  }
  return freq;
}

// Cosine similarity of word-frequency vectors, 0 (nothing in common) to 1 (identical wording).
export function textSimilarity(a: string, b: string): number {
  const fa = wordFrequencies(a);
  const fb = wordFrequencies(b);
  let dot = 0;
  for (const [word, n] of fa) dot += n * (fb.get(word) ?? 0);
  const norm = (f: Map<string, number>) => Math.sqrt([...f.values()].reduce((sum, n) => sum + n * n, 0));
  const denom = norm(fa) * norm(fb);
  return denom === 0 ? 0 : dot / denom;
}

export interface MatchResult {
  score: number; // 0-100, blended
  skillScore: number; // 0-100, weighted skill overlap
  textSimilarity: number; // 0-100, scaled cosine similarity
  coreSkills: string[]; // skills from the job title/tags, weighted 2x
  matchedSkills: string[];
  missingSkills: string[]; // core skills listed first
  extraSkills: string[]; // resume skills the job doesn't ask for
  verdict: string;
}

const SKILL_WEIGHT = 0.8;
// Resume vs. job description cosine similarity rarely exceeds ~0.5 even for great fits, so scale it up.
const SIMILARITY_SCALE = 200;
// Total skill weight a job needs before its skill score is fully trusted.
const MIN_CONFIDENT_WEIGHT = 4;

export function matchResume(resumeText: string, jobText: string, jobCoreText = ""): MatchResult {
  const resumeSkills = extractSkills(resumeText);
  const jobSkills = extractSkills(`${jobCoreText} ${jobText}`);
  const coreSkills = extractSkills(jobCoreText);

  const weight = (s: string) => (coreSkills.has(s) ? 2 : 1);
  const matched = [...jobSkills].filter((s) => resumeSkills.has(s));
  const missing = [...jobSkills]
    .filter((s) => !resumeSkills.has(s))
    .sort((a, b) => weight(b) - weight(a));
  const extra = [...resumeSkills].filter((s) => !jobSkills.has(s));

  const totalWeight = [...jobSkills].reduce((sum, s) => sum + weight(s), 0);
  const matchedWeight = matched.reduce((sum, s) => sum + weight(s), 0);
  const skillScore = totalWeight === 0 ? 0 : Math.round((matchedWeight / totalWeight) * 100);
  const similarity = Math.min(100, Math.round(textSimilarity(resumeText, `${jobCoreText} ${jobText}`) * SIMILARITY_SCALE));

  // Matching 1 of 1 detected skills says little, so trust the skill score less when the job lists few skills
  // and lean on text similarity instead. With no detectable skills, similarity is the only signal.
  const confidence = Math.min(1, totalWeight / MIN_CONFIDENT_WEIGHT);
  const blended = SKILL_WEIGHT * skillScore + (1 - SKILL_WEIGHT) * similarity;
  const score = Math.round(confidence * blended + (1 - confidence) * similarity);

  const missingCore = missing.filter((s) => coreSkills.has(s));
  let verdict: string;
  if (score >= 75) verdict = "Strong match. Apply with confidence.";
  else if (score >= 50) verdict = "Good match. Highlight your matched skills and address a few gaps.";
  else if (score >= 25) verdict = "Partial match. Consider upskilling in the missing areas first.";
  else verdict = "Weak match. This role needs skills your resume doesn't show yet.";
  if (missingCore.length) verdict += ` Key requirement(s) missing: ${missingCore.join(", ")}.`;
  if (jobSkills.size === 0) verdict += " (No specific skills detected in the job; score is based on text similarity only.)";

  return {
    score,
    skillScore,
    textSimilarity: similarity,
    coreSkills: [...coreSkills],
    matchedSkills: matched,
    missingSkills: missing,
    extraSkills: extra,
    verdict,
  };
}
