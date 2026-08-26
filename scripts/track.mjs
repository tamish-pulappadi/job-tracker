// Job tracker: finds new-grad / intern PM, Product Engineer, and TPM roles
// from company ATS boards (Greenhouse/Lever/Ashby) and SimplifyJobs lists,
// pushes a ntfy.sh notification for each newly seen posting, and writes
// docs/data.json for the dashboard.
//
// Env:
//   NTFY_TOPIC  - ntfy.sh topic to push to (no pushes if unset)
//   NTFY_SERVER - defaults to https://ntfy.sh
//   DRY_RUN=1   - log notifications instead of sending

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEEN_PATH = join(ROOT, "data", "seen.json");
const DATA_PATH = join(ROOT, "docs", "data.json");

const SIMPLIFY_SOURCES = [
  {
    name: "Simplify New Grad",
    kind: "newgrad",
    url: "https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json",
  },
  {
    name: "Simplify Internships",
    kind: "intern",
    url: "https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/.github/scripts/listings.json",
  },
];

// ---------- filters ----------

// PM, Product Engineer, and TPM titles.
const ROLE_RE =
  /product manage|product intern|product engineer|technical program manage|rotational product/i;

// "APM"/"TPM" as acronyms are ambiguous (Application Performance Monitoring,
// Trusted Platform Module, etc.) — only count them when the title has no
// tech-context words that suggest the other meaning.
const ACRONYM_RE = /\bapm\b|\btpm\b/i;
const ACRONYM_CONTEXT_EXCLUDE_RE =
  /marketing|engineer|serverless|observability|monitoring|infrastructure|security|firmware|hardware/i;

const MARKETING_RE = /\bmarketing\b|\bpmm\b/i;

// Early-career signal, required for ATS boards (Simplify lists are already
// early-career only). "Associate Product Manager" / APM counts by itself.
const EARLY_RE =
  /\b(intern|internship|co-?op|new grad|university|campus|early career|early in career|entry level|graduate|rotational|associate product manager|\bapm\b|class of 20\d\d|20\d\d start)\b/i;

const SENIOR_RE =
  /\b(senior|staff|principal|lead|director|vp|head|sr\.?|manager,? (ii|iii|iv|2|3|4)|experienced)\b/i;

const NON_US_RE =
  /\b(canada|toronto|vancouver|montreal|ottawa|waterloo|uk|united kingdom|london|dublin|ireland|india|bangalore|bengaluru|hyderabad|mumbai|delhi|gurgaon|pune|chennai|singapore|australia|sydney|melbourne|germany|berlin|munich|france|paris|amsterdam|netherlands|japan|tokyo|brazil|s[aã]o paulo|mexico|bogot[aá]|colombia|argentina|israel|tel aviv|poland|warsaw|krakow|spain|madrid|barcelona|portugal|lisbon|china|shanghai|beijing|hong kong|taiwan|taipei|korea|seoul|philippines|manila|vietnam|dubai|uae|abu dhabi|saudi|riyadh|switzerland|zurich|geneva|sweden|stockholm|denmark|copenhagen|norway|oslo|finland|helsinki|estonia|tallinn|italy|milan|rome|austria|vienna|belgium|brussels|czech|prague|hungary|budapest|romania|bucharest|turkey|istanbul|egypt|cairo|nigeria|lagos|kenya|nairobi|south africa|cape town|johannesburg|new zealand|auckland|emea|apac|latam)\b/i;

const US_STATES =
  "AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC";
const US_RE = new RegExp(
  `\\b(united states|usa|u\\.s\\.|america)\\b|,\\s*(${US_STATES})\\b|\\b(san francisco|sf bay|bay area|sf|new york|nyc|seattle|austin|boston|chicago|denver|los angeles|san diego|palo alto|mountain view|menlo park|sunnyvale|san jose|santa clara|redwood city|san mateo|oakland|bellevue|redmond|kirkland|portland|atlanta|miami|dallas|houston|phoenix|philadelphia|pittsburgh|washington,? d\\.?c\\.?|salt lake|nashville|charlotte|minneapolis|detroit|columbus|raleigh|durham|boulder|irvine|cupertino|burlingame|foster city|cambridge)\\b`,
  "i"
);

function locationOk(locText) {
  const t = (locText || "").trim();
  if (!t) return true; // no location info: keep, let the human judge
  if (US_RE.test(t)) return true;
  if (NON_US_RE.test(t)) return false;
  return /\bremote\b|\bglobal\b|\banywhere\b/i.test(t) || false;
}

function titleOk(title, { requireEarly }) {
  const roleMatch =
    ROLE_RE.test(title) ||
    (ACRONYM_RE.test(title) && !ACRONYM_CONTEXT_EXCLUDE_RE.test(title));
  if (!roleMatch) return false;
  if (MARKETING_RE.test(title)) return false;
  if (SENIOR_RE.test(title)) return false;
  if (requireEarly && !EARLY_RE.test(title)) return false;
  return true;
}

function jobKind(title) {
  return /\b(intern|internship|co-?op)\b/i.test(title) ? "intern" : "newgrad";
}

// ---------- fetchers ----------

async function getJSON(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(20000),
    headers: { "user-agent": "job-tracker (github.com/tamish-pulappadi/job-tracker)" },
  });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

// Workday boards paginate 20 at a time (larger limits are rejected) and report
// recency as prose ("Posted Today"), so dates are approximated from that text.
const WD_PAGE = 20;
const WD_MAX_PAGES = 60;

function workdayPostedAt(text, now = Date.now()) {
  const t = (text || "").trim();
  if (/posted today/i.test(t)) return new Date(now).toISOString();
  if (/posted yesterday/i.test(t)) return new Date(now - 864e5).toISOString();
  const m = t.match(/posted\s+(\d+)\+?\s*days?\s+ago/i);
  if (m) return new Date(now - Number(m[1]) * 864e5).toISOString();
  return null;
}

async function fetchCompany({ name, ats, slug, host, site }) {
  if (ats === "greenhouse") {
    const j = await getJSON(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
    return (j.jobs || []).map((job) => ({
      id: `gh:${slug}:${job.id}`,
      company: name,
      title: job.title || "",
      location: job.location?.name || "",
      url: job.absolute_url,
      postedAt: job.first_published || job.updated_at || null,
      source: "ats",
    }));
  }
  if (ats === "lever") {
    const j = await getJSON(`https://api.lever.co/v0/postings/${slug}?mode=json`);
    return (Array.isArray(j) ? j : []).map((job) => ({
      id: `lv:${slug}:${job.id}`,
      company: name,
      title: job.text || "",
      location: [job.categories?.location, ...(job.categories?.allLocations || [])]
        .filter(Boolean)
        .join("; "),
      url: job.hostedUrl,
      postedAt: job.createdAt ? new Date(job.createdAt).toISOString() : null,
      source: "ats",
    }));
  }
  if (ats === "ashby") {
    const j = await getJSON(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
    return (j.jobs || []).map((job) => ({
      id: `ab:${slug}:${job.id || job.jobUrl}`,
      company: name,
      title: job.title || "",
      location: [
        job.location,
        ...(job.secondaryLocations || []).map((l) => l.location),
        job.isRemote ? "Remote" : "",
      ]
        .filter(Boolean)
        .join("; "),
      url: job.jobUrl || job.applyUrl,
      postedAt: job.publishedAt || null,
      source: "ats",
    }));
  }
  if (ats === "workday") {
    const endpoint = `https://${host}/wday/cxs/${slug}/${site}/jobs`;
    const page = async (offset) => {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "user-agent": "job-tracker (github.com/tamish-pulappadi/job-tracker)",
        },
        body: JSON.stringify({ appliedFacets: {}, limit: WD_PAGE, offset, searchText: "" }),
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`${res.status} ${endpoint} offset=${offset}`);
      return res.json();
    };

    const first = await page(0);
    const postings = [...(first.jobPostings || [])];
    const total = Math.min(first.total || 0, WD_PAGE * WD_MAX_PAGES);
    const offsets = [];
    for (let o = WD_PAGE; o < total; o += WD_PAGE) offsets.push(o);
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (offsets.length) {
          const j = await page(offsets.shift());
          postings.push(...(j.jobPostings || []));
        }
      })
    );

    return postings.map((job) => {
      const loc = (job.locationsText || "").trim();
      return {
        id: `wd:${slug}:${job.bulletFields?.[0] || job.externalPath}`,
        company: name,
        title: job.title || "",
        // "4 Locations" carries no geography - blank it so locationOk keeps it
        location: /^\d+\s+locations$/i.test(loc) ? "" : loc,
        url: `https://${host}/en-US/${site}${job.externalPath}`,
        postedAt: workdayPostedAt(job.postedOn),
        source: "ats",
      };
    });
  }
  throw new Error(`unknown ats ${ats}`);
}

async function fetchSimplify({ name, kind, url }) {
  const listings = await getJSON(url);
  return listings
    .filter((j) => j.active && j.is_visible)
    .filter(
      (j) =>
        /^product/i.test(j.category || "") || ROLE_RE.test(j.title || "")
    )
    .map((j) => ({
      id: `sim:${j.id}`,
      company: j.company_name || "",
      title: j.title || "",
      location: (j.locations || []).join("; "),
      url: j.url,
      postedAt: j.date_posted ? new Date(j.date_posted * 1000).toISOString() : null,
      source: name,
      kindHint: kind,
    }));
}

// ---------- main ----------

async function readJSONFile(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

const companies = JSON.parse(
  await readFile(join(ROOT, "config", "companies.json"), "utf8")
);

const failures = [];
const allJobs = [];

// company boards, bounded concurrency
const queue = [...companies];
await Promise.all(
  Array.from({ length: 8 }, async () => {
    while (queue.length) {
      const c = queue.shift();
      try {
        const jobs = await fetchCompany(c);
        allJobs.push(
          ...jobs.filter(
            (j) => titleOk(j.title, { requireEarly: true }) && locationOk(j.location)
          )
        );
      } catch (e) {
        failures.push(`${c.name}: ${e.message}`);
      }
    }
  })
);

for (const src of SIMPLIFY_SOURCES) {
  try {
    const jobs = await fetchSimplify(src);
    allJobs.push(
      ...jobs.filter(
        (j) => titleOk(j.title, { requireEarly: false }) && locationOk(j.location)
      )
    );
  } catch (e) {
    failures.push(`${src.name}: ${e.message}`);
  }
}

if (failures.length) console.error(`fetch failures (${failures.length}):\n  ${failures.join("\n  ")}`);
if (allJobs.length === 0 && failures.length > 0) {
  console.error("all sources failed; aborting without touching state");
  process.exit(1);
}

// de-dupe across sources: prefer the ATS version, keyed by company+title+location
const byId = new Map();
const byFingerprint = new Map();
for (const job of allJobs) {
  if (byId.has(job.id)) continue;
  const fp = `${job.company}|${job.title}|${job.location}`.toLowerCase();
  const existing = byFingerprint.get(fp);
  if (existing) {
    if (existing.source !== "ats" && job.source === "ats") {
      byId.delete(existing.id);
      byId.set(job.id, job);
      byFingerprint.set(fp, job);
    }
    continue;
  }
  byId.set(job.id, job);
  byFingerprint.set(fp, job);
}
const jobs = [...byId.values()];

// state
const seen = await readJSONFile(SEEN_PATH, null);
const firstRun = seen === null;
const seenMap = seen || {};
const now = new Date().toISOString();

const newJobs = jobs.filter((j) => !seenMap[j.id]);
for (const j of newJobs) seenMap[j.id] = { firstSeen: now };

// prune state entries that vanished from sources >120 days ago
const cutoff = Date.now() - 120 * 24 * 3600 * 1000;
const liveIds = new Set(jobs.map((j) => j.id));
for (const [id, meta] of Object.entries(seenMap)) {
  if (!liveIds.has(id) && Date.parse(meta.firstSeen) < cutoff) delete seenMap[id];
}

// notify
const topic = process.env.NTFY_TOPIC;
const server = process.env.NTFY_SERVER || "https://ntfy.sh";
const dryRun = process.env.DRY_RUN === "1";

async function notify(job) {
  const title = `${job.company} — ${job.title}`;
  const body = [job.location, jobKind(job.title) === "intern" ? "Internship" : "New Grad"]
    .filter(Boolean)
    .join(" · ");
  if (dryRun || !topic) {
    console.log(`[dry-run notify] ${title} | ${body} | ${job.url}`);
    return;
  }
  // publish via the JSON endpoint: HTTP headers only allow Latin-1, and
  // titles/URLs can contain arbitrary Unicode (em dashes, accents, ...)
  const res = await fetch(server, {
    method: "POST",
    body: JSON.stringify({
      topic,
      title,
      message: body,
      click: job.url,
      tags: [jobKind(job.title) === "intern" ? "mortar_board" : "briefcase"],
      priority: 4,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) console.error(`ntfy failed (${res.status}) for ${title}`);
}

if (firstRun) {
  console.log(`first run: seeded ${jobs.length} jobs without notifying`);
} else {
  for (const j of newJobs) {
    try {
      await notify(j);
    } catch (err) {
      console.error(`notify failed for ${j.company} ${j.title}: ${err.message}`);
    }
  }
  console.log(`${newJobs.length} new job(s) of ${jobs.length} tracked`);
}

// persist
jobs.sort(
  (a, b) =>
    Date.parse(seenMap[b.id].firstSeen) - Date.parse(seenMap[a.id].firstSeen) ||
    a.company.localeCompare(b.company)
);

await mkdir(dirname(SEEN_PATH), { recursive: true });
await mkdir(dirname(DATA_PATH), { recursive: true });
await writeFile(SEEN_PATH, JSON.stringify(seenMap, null, 1) + "\n");
await writeFile(
  DATA_PATH,
  JSON.stringify(
    {
      generatedAt: now,
      companiesTracked: companies.length,
      failures,
      jobs: jobs.map((j) => ({
        company: j.company,
        title: j.title,
        location: j.location,
        url: j.url,
        kind: jobKind(j.title),
        source: j.source === "ats" ? "Company board" : j.source,
        firstSeen: seenMap[j.id].firstSeen,
        postedAt: j.postedAt,
      })),
    },
    null,
    1
  ) + "\n"
);

console.log(`wrote ${jobs.length} jobs to docs/data.json`);
