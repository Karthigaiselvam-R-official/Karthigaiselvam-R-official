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
          catch { return reject(new Error(`Non-JSON: ${raw.slice(0, 200)}`)); }
          if (parsed.message && !parsed.data) {
            return reject(new Error(`GitHub API error: ${parsed.message}`));
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

function fetchImageBase64(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve(`data:${res.headers['content-type']};base64,${buffer.toString('base64')}`);
      });
    }).on('error', reject);
  });
}

// ─── Query 1: All Stats ─────────────────────────────────────────────────────
async function fetchAllStats() {
  const res = await graphql(`{
    user(login: "${USERNAME}") {
      name
      avatarUrl(size: 200)
      followers { totalCount }
      following { totalCount }
      
      totalRepos: repositories(ownerAffiliations: [OWNER, COLLABORATOR], first: 100, orderBy: {field: STARGAZERS, direction: DESC}) {
        totalCount
        nodes { stargazers { totalCount } forkCount }
      }
      
      publicRepos: repositories(ownerAffiliations: OWNER, privacy: PUBLIC, first: 100, orderBy: {field: STARGAZERS, direction: DESC}) {
        totalCount
        nodes { stargazers { totalCount } }
      }
      
      pullRequests(first: 1) { totalCount }
      mergedPRs: pullRequests(states: MERGED, first: 1) { totalCount }
      issues(first: 1) { totalCount }
      repositoriesContributedTo(first: 1) { totalCount }
    }
  }`);

  if (res.errors && res.errors.length > 0) throw new Error(res.errors[0].message);
  
  const u = res.data.user;
  
  const totalStars = u.totalRepos.nodes.reduce((s, r) => s + r.stargazers.totalCount, 0);
  const totalForks = u.totalRepos.nodes.reduce((s, r) => s + r.forkCount, 0);
  const publicStars = u.publicRepos.nodes.reduce((s, r) => s + r.stargazers.totalCount, 0);

  return {
    name: u.name || USERNAME,
    avatarUrl: u.avatarUrl,
    followers: u.followers.totalCount,
    following: u.following.totalCount,
    totalRepos: u.totalRepos.totalCount,
    publicRepos: u.publicRepos.totalCount,
    totalStars,
    publicStars,
    totalForks,
    prs: u.pullRequests.totalCount,
    mergedPRs: u.mergedPRs.totalCount,
    issues: u.issues.totalCount,
    contributedTo: u.repositoriesContributedTo.totalCount
  };
}

// ─── Query 2: Commit counts ───────────────────────────────────────────────────
async function fetchCommits() {
  const infoRes = await graphql(`{ user(login: "${USERNAME}") { createdAt } }`);
  if (!infoRes.data || !infoRes.data.user) return 0;

  const creationYear = new Date(infoRes.data.user.createdAt).getFullYear();
  const currentYear  = new Date().getFullYear();

  let fragment = "";
  for (let yr = creationYear; yr <= currentYear; yr++) {
    const from = `${yr}-01-01T00:00:00Z`;
    const to = yr === currentYear ? new Date().toISOString().replace(/\.\d{3}Z$/, "Z") : `${yr}-12-31T23:59:59Z`;
    fragment += `y${yr}: contributionsCollection(from: "${from}", to: "${to}") { totalCommitContributions restrictedContributionsCount } `;
  }

  const res = await graphql(`{ user(login: "${USERNAME}") { ${fragment} } }`);
  if (res.errors && res.errors.length > 0) return 0;
  
  let total = 0;
  for (let yr = creationYear; yr <= currentYear; yr++) {
    const d = res.data.user[`y${yr}`];
    if (d) total += d.totalCommitContributions + d.restrictedContributionsCount;
  }
  return total;
}

function formatK(num) {
  return num >= 1000 ? (num / 1000).toFixed(1) + 'K' : num.toString();
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Generating rank card for: ${USERNAME}`);

  const stats = await fetchAllStats();
  const commits = await fetchCommits();
  
  let avatarBase64 = "";
  try {
    avatarBase64 = await fetchImageBase64(stats.avatarUrl);
  } catch (e) {
    console.warn("Failed to fetch avatar", e);
  }

  // Calculate rank based on PUBLIC stats to match typical rank cards
  const { level, percentile } = calculateRank({ 
    commits, 
    prs: stats.prs, 
    issues: stats.issues, 
    stars: stats.publicStars, 
    followers: stats.followers 
  });
  
  const colors = {
    S: "#EF9F27", "A+": "#1D9E75", A: "#1D9E75", "A-": "#1D9E75",
    "B+": "#3B8BD4", B: "#3B8BD4", "B-": "#3B8BD4", "C+": "#888780", C: "#888780"
  };
  const color = colors[level] || "#888780";

  // 1. Generate the Rank SVG
  const rankSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120" viewBox="0 0 320 120">
  <rect width="320" height="120" rx="12" fill="#0d0221"/>
  <rect width="318" height="118" x="1" y="1" rx="11" fill="none" stroke="${color}" stroke-width="1.5"/>
  <text x="160" y="28" text-anchor="middle" font-family="monospace" font-size="13" fill="#00fffa">GitHub Rank</text>
  <text x="160" y="78" text-anchor="middle" font-family="monospace" font-size="52" font-weight="bold" fill="${color}">${level}</text>
  <text x="160" y="108" text-anchor="middle" font-family="monospace" font-size="12" fill="#FEE75C">Top ${percentile}%  •  ${formatK(commits)} commits  •  ⭐ ${stats.publicStars}</text>
</svg>`;

  // 2. Generate the Custom Total Stats SVG (Replica of gh-readme-profile)
  const statsSvg = `<svg width="450" height="230" viewBox="0 0 450 230" fill="none" xmlns="http://www.w3.org/2000/svg">
  <style>
    .title { font-family: 'Segoe UI', Ubuntu, sans-serif; font-weight: bold; font-size: 16px; fill: #00fffa; }
    .stat-label { font-family: 'Segoe UI', Ubuntu, sans-serif; font-size: 12px; fill: #8b949e; }
    .stat-value { font-family: 'Segoe UI', Ubuntu, sans-serif; font-weight: bold; font-size: 12px; fill: #FEE75C; }
    .name { font-family: 'Segoe UI', Ubuntu, sans-serif; font-weight: bold; font-size: 13px; fill: #ffffff; }
    .username { font-family: 'Segoe UI', Ubuntu, sans-serif; font-size: 11px; fill: #8b949e; }
    .icon { fill: #39FF14; }
  </style>
  <rect width="450" height="230" rx="8" fill="#0d0221" stroke="#30363d" stroke-width="1"/>
  
  <g transform="translate(25, 45)">
    <clipPath id="avatarClip">
      <circle cx="45" cy="45" r="45"/>
    </clipPath>
    ${avatarBase64 ? `<image href="${avatarBase64}" width="90" height="90" clip-path="url(#avatarClip)"/>` : `<circle cx="45" cy="45" r="45" fill="#30363d"/>`}
    <text x="45" y="115" text-anchor="middle" class="name">@${USERNAME}</text>
    <text x="45" y="132" text-anchor="middle" class="username">${stats.followers} Followers · ${stats.following} Following</text>
  </g>

  <g transform="translate(180, 25)">
    <text x="0" y="0" class="title">${stats.name}'s GitHub Stats</text>
    
    <g transform="translate(0, 25)">
      <text x="25" y="10" class="stat-label">Total Repository:</text>
      <text x="240" y="10" class="stat-value" text-anchor="end">${stats.totalRepos}</text>
      <text x="0" y="10" class="icon" font-size="12">📦</text>
      
      <text x="25" y="32" class="stat-label">Star's Count:</text>
      <text x="240" y="32" class="stat-value" text-anchor="end">${stats.totalStars}</text>
      <text x="0" y="32" class="icon" font-size="12">⭐</text>
      
      <text x="25" y="54" class="stat-label">Fork's Count:</text>
      <text x="240" y="54" class="stat-value" text-anchor="end">${stats.totalForks}</text>
      <text x="0" y="54" class="icon" font-size="12">🍴</text>
      
      <text x="25" y="76" class="stat-label">Commit's Count:</text>
      <text x="240" y="76" class="stat-value" text-anchor="end">${formatK(commits)}</text>
      <text x="0" y="76" class="icon" font-size="12">⏱️</text>
      
      <text x="25" y="98" class="stat-label">Total PRs:</text>
      <text x="240" y="98" class="stat-value" text-anchor="end">${stats.prs}</text>
      <text x="0" y="98" class="icon" font-size="12">🔀</text>
      
      <text x="25" y="120" class="stat-label">Total PRs Merged:</text>
      <text x="240" y="120" class="stat-value" text-anchor="end">${stats.mergedPRs}</text>
      <text x="0" y="120" class="icon" font-size="12">✅</text>
      
      <text x="25" y="142" class="stat-label">Total Issues:</text>
      <text x="240" y="142" class="stat-value" text-anchor="end">${stats.issues}</text>
      <text x="0" y="142" class="icon" font-size="12">❗</text>
      
      <text x="25" y="164" class="stat-label">Contributed to (last year):</text>
      <text x="240" y="164" class="stat-value" text-anchor="end">${stats.contributedTo}</text>
      <text x="0" y="164" class="icon" font-size="12">🤝</text>
    </g>
  </g>
</svg>`;

  fs.mkdirSync("rank-card", { recursive: true });
  fs.writeFileSync("rank-card/rank.svg", rankSvg);
  fs.writeFileSync("rank-card/github-stats.svg", statsSvg);
  
  // 3. Write stats.json for dynamic shields.io badges (Right Panel)
  fs.writeFileSync("rank-card/stats.json", JSON.stringify({ 
    stars: stats.publicStars, // Standard badges usually show public
    publicRepos: stats.publicRepos,
    totalStars: stats.totalStars,
    totalRepos: stats.totalRepos,
    commits, prs: stats.prs, issues: stats.issues, followers: stats.followers 
  }));
  
  console.log(`✓ Generated rank.svg, github-stats.svg, and stats.json successfully.`);
}

main().catch((err) => {
  console.error("✗ generate-rank failed:", err.message);
  process.exit(1);
});
