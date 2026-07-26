const https = require("https");
const fs = require("fs");

const USERNAME = process.env.GITHUB_USERNAME || "Karthigaiselvam-R-official";
const TOKEN = process.env.GITHUB_TOKEN;

// ─── Rank Algorithm ─────────────────────────────────────────────────────────
function exponential_cdf(x) { return 1 - Math.pow(2, -x); }
function log_normal_cdf(x)   { return x / (1 + x); }

function calculateRank({ commits, prs, issues, stars, followers }) {
  const COMMITS_WEIGHT = 2, COMMITS_MEDIAN = 250;
  const PRS_WEIGHT     = 3, PRS_MEDIAN     = 50;
  const ISSUES_WEIGHT  = 1, ISSUES_MEDIAN  = 25;
  const STARS_WEIGHT   = 4, STARS_MEDIAN   = 50;
  const FOL_WEIGHT     = 1, FOL_MEDIAN     = 10;
  const TOTAL          = COMMITS_WEIGHT + PRS_WEIGHT + ISSUES_WEIGHT + STARS_WEIGHT + FOL_WEIGHT;

  const score = 1 - (
    COMMITS_WEIGHT * exponential_cdf(commits   / COMMITS_MEDIAN) +
    PRS_WEIGHT     * exponential_cdf(prs        / PRS_MEDIAN)     +
    ISSUES_WEIGHT  * exponential_cdf(issues     / ISSUES_MEDIAN)  +
    STARS_WEIGHT   * log_normal_cdf(stars       / STARS_MEDIAN)   +
    FOL_WEIGHT     * log_normal_cdf(followers   / FOL_MEDIAN)
  ) / TOTAL;

  const pct        = score * 100;
  const THRESHOLDS = [1, 12.5, 25, 37.5, 50, 62.5, 75, 87.5, 100];
  const LEVELS     = ["S", "A+", "A", "A-", "B+", "B", "B-", "C+", "C"];
  const idx        = THRESHOLDS.findIndex(t => pct <= t);
  const level      = idx === -1 ? "C" : LEVELS[idx];

  return { level, percentile: pct.toFixed(1) };
}

// ─── HTTP GraphQL helper ─────────────────────────────────────────────────────
function graphql(q) {
  return new Promise((resolve, reject) => {
    if (!TOKEN) {
      return reject(new Error("GITHUB_TOKEN is not set."));
    }

    const body = JSON.stringify({ query: q });
    const req = https.request(
      {
        hostname: "api.github.com",
        path:     "/graphql",
        method:   "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `bearer ${TOKEN}`,
          "User-Agent":    "rank-generator/2.1",
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          // ── Guard 1: parse JSON ──────────────────────────────────────────
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch {
            return reject(new Error(
              `Non-JSON response from GitHub (HTTP ${res.statusCode}):\n${raw.slice(0, 300)}`
            ));
          }

          // ── Guard 2: HTTP-level error (401, 403, 500, rate limit) ────────
          // These return {"message": "...", "status": "..."} — NOT GraphQL shape
          if (parsed.message && !parsed.data) {
            return reject(new Error(
              `GitHub API HTTP error (status ${res.statusCode}): ${parsed.message}`
            ));
          }

          resolve(parsed);
        });
      }
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── SVG Builder ────────────────────────────────────────────────────────────
function buildSVG({ level, percentile, commits, stars }) {
  const COLORS = {
    S: "#EF9F27", "A+": "#1D9E75", A: "#1D9E75", "A-": "#1D9E75",
    "B+": "#3B8BD4", B: "#3B8BD4", "B-": "#3B8BD4", "C+": "#888780", C: "#888780",
  };
  const color = COLORS[level] || "#888780";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="350" height="120" viewBox="0 0 350 120">
  <rect width="350" height="120" rx="12" fill="#0d0221"/>
  <rect width="348" height="118" x="1" y="1" rx="11" fill="none" stroke="${color}" stroke-width="1.5"/>
  <text x="175" y="28" text-anchor="middle" font-family="monospace" font-size="13" fill="#00fffa">GitHub Rank</text>
  <text x="175" y="78" text-anchor="middle" font-family="monospace" font-size="52" font-weight="bold" fill="${color}">${level}</text>
  <text x="175" y="108" text-anchor="middle" font-family="monospace" font-size="13" fill="#FEE75C">Top ${percentile}%  •  ${commits} commits  •  ⭐ ${stars}</text>
</svg>`;
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  // ── Step 1: Fetch basic user stats ──────────────────────────────────────
  const statsRes = await graphql(`{
    user(login: "${USERNAME}") {
      createdAt
      followers { totalCount }
      repositories(ownerAffiliations: OWNER, isFork: false, first: 100) {
        nodes { stargazers { totalCount } }
      }
      pullRequests(first: 1) { totalCount }
      issues(first: 1)      { totalCount }
    }
  }`);

  // ── Guard 3: GraphQL-level errors ────────────────────────────────────────
  if (statsRes.errors && statsRes.errors.length > 0) {
    throw new Error(`GraphQL error: ${statsRes.errors.map(e => e.message).join("; ")}`);
  }
  if (!statsRes.data || !statsRes.data.user) {
    throw new Error(`User "${USERNAME}" not found. Response: ${JSON.stringify(statsRes)}`);
  }

  const user = statsRes.data.user;

  // ── Step 2: Fetch ALL-TIME commits across every year ─────────────────────
  const creationYear = new Date(user.createdAt).getFullYear();
  const currentYear  = new Date().getFullYear();

  // Build a single multi-alias query — one query, minimal API calls
  let yearsFragment = "";
  for (let yr = creationYear; yr <= currentYear; yr++) {
    // Cap 'to' at today to avoid GitHub rejecting future dates
    const from = `${yr}-01-01T00:00:00Z`;
    const to   = yr === currentYear
      ? new Date().toISOString().replace(/\.\d{3}Z$/, "Z")
      : `${yr}-12-31T23:59:59Z`;

    yearsFragment += `
      y${yr}: contributionsCollection(from: "${from}", to: "${to}") {
        totalCommitContributions
        restrictedContributionsCount
      }`;
  }

  const commitsRes = await graphql(`{ user(login: "${USERNAME}") { ${yearsFragment} } }`);

  if (commitsRes.errors && commitsRes.errors.length > 0) {
    throw new Error(`GraphQL error (commits): ${commitsRes.errors.map(e => e.message).join("; ")}`);
  }
  if (!commitsRes.data || !commitsRes.data.user) {
    throw new Error(`No commit data returned. Response: ${JSON.stringify(commitsRes).slice(0, 300)}`);
  }

  let commits = 0;
  for (let yr = creationYear; yr <= currentYear; yr++) {
    const yrData = commitsRes.data.user[`y${yr}`];
    if (yrData) {
      commits += yrData.totalCommitContributions + yrData.restrictedContributionsCount;
    }
  }

  // ── Step 3: Assemble metrics ─────────────────────────────────────────────
  const stars     = user.repositories.nodes.reduce((s, r) => s + r.stargazers.totalCount, 0);
  const prs       = user.pullRequests.totalCount;
  const issues    = user.issues.totalCount;
  const followers = user.followers.totalCount;

  console.log(`Metrics → commits:${commits} prs:${prs} issues:${issues} stars:${stars} followers:${followers}`);

  // ── Step 4: Compute rank & write SVG ─────────────────────────────────────
  const { level, percentile } = calculateRank({ commits, prs, issues, stars, followers });
  console.log(`Rank: ${level} | Top ${percentile}%`);

  const svg = buildSVG({ level, percentile, commits, stars });
  fs.mkdirSync("rank-card", { recursive: true });
  fs.writeFileSync("rank-card/rank.svg", svg, "utf8");
  console.log("✓ rank-card/rank.svg written successfully.");
}

main().catch((err) => {
  console.error("✗ generate-rank failed:", err.message);
  process.exit(1);
});
