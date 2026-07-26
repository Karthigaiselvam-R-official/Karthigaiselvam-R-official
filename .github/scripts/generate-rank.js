const https = require("https");
const fs = require("fs");

const USERNAME = process.env.GITHUB_USERNAME || "Karthigaiselvam-R-official";
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

// ─── Rank Algorithm ─────────────────────────────────────────────────────────
function exponential_cdf(x) { return 1 - Math.pow(2, -x); }
function log_normal_cdf(x)   { return x / (1 + x); }

function calculateRank({ commits, prs, issues, stars, followers }) {
  const COMMITS_WEIGHT = 2, COMMITS_MEDIAN = 250;
  const PRS_WEIGHT     = 3, PRS_MEDIAN     = 50;
  const ISSUES_WEIGHT  = 1, ISSUES_MEDIAN  = 25;
  const STARS_WEIGHT   = 4, STARS_MEDIAN   = 50;
  const FOL_WEIGHT     = 1, FOL_MEDIAN     = 10;
  const TOTAL = COMMITS_WEIGHT + PRS_WEIGHT + ISSUES_WEIGHT + STARS_WEIGHT + FOL_WEIGHT;

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
  return { level: idx === -1 ? "C" : LEVELS[idx], percentile: pct.toFixed(1) };
}

// ─── HTTP GraphQL helper ─────────────────────────────────────────────────────
function graphql(q) {
  return new Promise((resolve, reject) => {
    if (!TOKEN) return reject(new Error("GITHUB_TOKEN is not set."));

    const body = JSON.stringify({ query: q });
    const req = https.request(
      {
        hostname: "api.github.com",
        path:     "/graphql",
        method:   "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `bearer ${TOKEN}`,
          "User-Agent":    "rank-generator/2.2",
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed;
          try { parsed = JSON.parse(raw); }
          catch {
            return reject(new Error(
              `Non-JSON from GitHub (HTTP ${res.statusCode}): ${raw.slice(0, 200)}`
            ));
          }
          // HTTP-level error (401, 403, 500): {"message":"...", "status":"..."}
          if (parsed.message && !parsed.data) {
            return reject(new Error(
              `GitHub API error (HTTP ${res.statusCode}): ${parsed.message}`
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

// ─── SVG (original style restored) ─────────────────────────────────────────

// ─── Query 1: Public stats — works with default GITHUB_TOKEN ─────────────────
async function fetchPublicStats() {
  const res = await graphql(`{
    user(login: "${USERNAME}") {
      followers { totalCount }
      repositories(ownerAffiliations: OWNER, privacy: PUBLIC, first: 100, orderBy: {field: STARGAZERS, direction: DESC}) {
        nodes { stargazers { totalCount } }
      }
      publicRepos: repositories(privacy: PUBLIC, ownerAffiliations: OWNER) {
        totalCount
      }
      pullRequests(first: 1) { totalCount }
      issues(first: 1)      { totalCount }
    }
  }`);

  if (res.errors && res.errors.length > 0) {
    throw new Error(`GraphQL error: ${res.errors.map(e => e.message).join("; ")}`);
  }
  if (!res.data || !res.data.user) {
    throw new Error(`User "${USERNAME}" not found. Response: ${JSON.stringify(res)}`);
  }

  const u = res.data.user;
  return {
    stars:     u.repositories.nodes.reduce((s, r) => s + r.stargazers.totalCount, 0),
    prs:       u.pullRequests.totalCount,
    issues:    u.issues.totalCount,
    followers: u.followers.totalCount,
    publicRepos: u.publicRepos.totalCount,
  };
}

// ─── Query 2: Commit counts — requires PAT with read:user scope ───────────────
// Returns 0 silently if token is a default GITHUB_TOKEN (integration token).
async function fetchCommits() {
  // Get account creation year first
  const infoRes = await graphql(`{ user(login: "${USERNAME}") { createdAt } }`);
  if (!infoRes.data || !infoRes.data.user) return 0;

  const creationYear = new Date(infoRes.data.user.createdAt).getFullYear();
  const currentYear  = new Date().getFullYear();

  // Build multi-year alias query
  let fragment = "";
  for (let yr = creationYear; yr <= currentYear; yr++) {
    const from = `${yr}-01-01T00:00:00Z`;
    // Cap 'to' at today to avoid GitHub rejecting future dates
    const to = yr === currentYear
      ? new Date().toISOString().replace(/\.\d{3}Z$/, "Z")
      : `${yr}-12-31T23:59:59Z`;
    fragment += `y${yr}: contributionsCollection(from: "${from}", to: "${to}") {
        totalCommitContributions
        restrictedContributionsCount
      } `;
  }

  const res = await graphql(`{ user(login: "${USERNAME}") { ${fragment} } }`);

  // "Resource not accessible by integration" = default GITHUB_TOKEN, not a PAT.
  // Gracefully return 0 so the rank card still generates without crashing.
  if (res.errors && res.errors.length > 0) {
    const msg = res.errors[0].message;
    if (msg.includes("not accessible by integration") || msg.includes("insufficient scopes")) {
      console.warn(`⚠ Commit data unavailable (token lacks read:user scope): ${msg}`);
      console.warn("  → Add a PAT with read:user scope as secret 'GH_TOKEN' for full commit counts.");
      return 0;
    }
    throw new Error(`GraphQL error (commits): ${msg}`);
  }
  if (!res.data || !res.data.user) return 0;

  let total = 0;
  for (let yr = creationYear; yr <= currentYear; yr++) {
    const d = res.data.user[`y${yr}`];
    if (d) total += d.totalCommitContributions + d.restrictedContributionsCount;
  }
  return total;
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Generating rank card for: ${USERNAME}`);

  const { stars, prs, issues, followers, publicRepos } = await fetchPublicStats();
  console.log(`Public stats → prs:${prs} issues:${issues} stars:${stars} followers:${followers}`);

  const commits = await fetchCommits();
  console.log(`Commits → ${commits > 0 ? commits : "0 (PAT not set — commit data unavailable)"}`);

  const { level, percentile } = calculateRank({ commits, prs, issues, stars, followers });
  console.log(`Rank: ${level} | Top ${percentile}%`);

  // Color per rank level (original)
  const colors = {
    S: "#EF9F27", "A+": "#1D9E75", A: "#1D9E75", "A-": "#1D9E75",
    "B+": "#3B8BD4", B: "#3B8BD4", "B-": "#3B8BD4", "C+": "#888780", C: "#888780"
  };
  const color = colors[level] || "#888780";

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120" viewBox="0 0 320 120">
  <rect width="320" height="120" rx="12" fill="#0d0221"/>
  <rect width="318" height="118" x="1" y="1" rx="11" fill="none" stroke="${color}" stroke-width="1.5"/>
  <text x="160" y="28" text-anchor="middle" font-family="monospace" font-size="13" fill="#00fffa">GitHub Rank</text>
  <text x="160" y="78" text-anchor="middle" font-family="monospace" font-size="52" font-weight="bold" fill="${color}">${level}</text>
  <text x="160" y="108" text-anchor="middle" font-family="monospace" font-size="12" fill="#FEE75C">Top ${percentile}%  •  ${commits} commits  •  ⭐ ${stars}</text>
</svg>`;

  fs.mkdirSync("rank-card", { recursive: true });
  fs.writeFileSync("rank-card/rank.svg", svg);
  fs.writeFileSync("rank-card/stats.json", JSON.stringify({ stars, commits, prs, issues, followers, publicRepos }));
  console.log(`✓ rank-card/rank.svg and stats.json written. Rank: ${level} | Top ${percentile}%`);
}

main().catch((err) => {
  console.error("✗ generate-rank failed:", err.message);
  process.exit(1);
});
