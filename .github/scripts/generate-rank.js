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
        nodes { stargazers { totalCount } forkCount isFork }
      }
      
      publicRepos: repositories(ownerAffiliations: OWNER, privacy: PUBLIC, first: 100, orderBy: {field: STARGAZERS, direction: DESC}) {
        totalCount
        nodes { stargazers { totalCount } }
      }
      
      pullRequests(first: 1) { totalCount }
      mergedPRs: pullRequests(states: MERGED, first: 1) { totalCount }
      issues(first: 1) { totalCount }
      repositoriesContributedTo(first: 1) { totalCount }
      gists(first: 1) { totalCount }
    }
  }`);

  if (res.errors && res.errors.length > 0) throw new Error(res.errors[0].message);
  
  const u = res.data.user;
  
  const totalStars = u.totalRepos.nodes.reduce((s, r) => s + r.stargazers.totalCount, 0);
  const totalForks = u.totalRepos.nodes.reduce((s, r) => s + r.forkCount, 0);
  const publicStars = u.publicRepos.nodes.reduce((s, r) => s + r.stargazers.totalCount, 0);
  const scratchWorks = u.totalRepos.nodes.filter(r => !r.isFork).length;

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
    contributedTo: u.repositoriesContributedTo.totalCount,
    gists: u.gists.totalCount,
    scratchWorks
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
    stars: stats.totalStars, 
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
  <text x="160" y="108" text-anchor="middle" font-family="monospace" font-size="12" fill="#FEE75C">Top ${percentile}%  •  ${formatK(commits)} commits  •  ⭐ ${stats.totalStars}</text>
</svg>`;

  // 2. Generate the Custom Total Stats SVG (Replica of gh-readme-profile)
  const statsSvg = `<svg width="580" height="260" viewBox="0 0 580 260" fill="none" xmlns="http://www.w3.org/2000/svg">
  <style>
    .title { font-family: 'Segoe UI', Ubuntu, sans-serif; font-weight: bold; font-size: 18px; fill: #00fffa; }
    .stat-label { font-family: 'Segoe UI', Ubuntu, sans-serif; font-size: 13px; fill: #ffffff; }
    .stat-value { font-family: 'Segoe UI', Ubuntu, sans-serif; font-weight: bold; font-size: 13px; fill: #FEE75C; }
    .name { font-family: 'Segoe UI', Ubuntu, sans-serif; font-weight: bold; font-size: 14px; fill: #ffffff; }
    .username { font-family: 'Segoe UI', Ubuntu, sans-serif; font-size: 11px; fill: #8b949e; }
    .icon { fill: #FF2079; }
  </style>
  <rect width="580" height="260" rx="8" fill="#000000"/>
  
  <g transform="translate(0, 40)">
    <clipPath id="avatarClip">
      <circle cx="100" cy="60" r="60"/>
    </clipPath>
    ${avatarBase64 ? `<image href="${avatarBase64}" width="120" height="120" x="40" y="0" clip-path="url(#avatarClip)"/>` : `<circle cx="100" cy="60" r="60" fill="#30363d"/>`}
    <text x="100" y="145" text-anchor="middle" class="name">${USERNAME}</text>
    <text x="100" y="165" text-anchor="middle" class="username">${stats.followers} Followers · ${stats.following} Following</text>
  </g>

  <g transform="translate(210, 25)">
    <text x="0" y="0" class="title">${stats.name}'s GitHub Stats</text>
    
    <g transform="translate(0, 25)">
      <svg x="0" y="0" viewBox="0 0 16 16" width="16" height="16"><path class="icon" fill-rule="evenodd" d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 110-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1V9h-8c-.356 0-.694.074-1 .208V2.5a1 1 0 011-1h8zM5 12.25v3.25a.25.25 0 00.4.2l1.45-1.087a.25.25 0 01.3 0L8.6 15.7a.25.25 0 00.4-.2v-3.25a.25.25 0 00-.25-.25h-3.5a.25.25 0 00-.25.25z"/></svg>
      <text x="25" y="12" class="stat-label">Total Repository (Public + Private):</text>
      <text x="330" y="12" class="stat-value" text-anchor="end">${stats.totalRepos}</text>
      
      <svg x="0" y="24" viewBox="0 0 16 16" width="16" height="16"><path class="icon" fill-rule="evenodd" d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25zm0 2.445L6.615 5.5a.75.75 0 01-.564.41l-3.097.45 2.24 2.184a.75.75 0 01.216.664l-.528 3.084 2.769-1.456a.75.75 0 01.698 0l2.77 1.456-.53-3.084a.75.75 0 01.216-.664l2.24-2.183-3.096-.45a.75.75 0 01-.564-.41L8 2.694v.001z"/></svg>
      <text x="25" y="36" class="stat-label">Total Star's Count (Public + Private):</text>
      <text x="330" y="36" class="stat-value" text-anchor="end">${stats.totalStars}</text>
      
      <svg x="0" y="48" viewBox="0 0 16 16" width="16" height="16"><path class="icon" fill-rule="evenodd" d="M5 3.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm0 2.122a2.25 2.25 0 10-1.5 0v.878A2.25 2.25 0 005.75 8.5h1.5v2.128a2.251 2.251 0 101.5 0V8.5h1.5a2.25 2.25 0 002.25-2.25v-.878a2.25 2.25 0 10-1.5 0v.878a.75.75 0 01-.75.75h-4.5A.75.75 0 015 6.25v-.878zm3.75 7.378a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm3-8.75a.75.75 0 11-1.5 0 .75.75 0 011.5 0z"/></svg>
      <text x="25" y="60" class="stat-label">Fork's Count:</text>
      <text x="330" y="60" class="stat-value" text-anchor="end">${stats.totalForks}</text>
      
      <svg x="0" y="72" viewBox="0 0 16 16" width="16" height="16"><path class="icon" fill-rule="evenodd" d="M1.643 3.143L.427 1.927A.25.25 0 000 2.104V5.75c0 .138.112.25.25.25h3.646a.25.25 0 00.177-.427L2.715 4.215a6.5 6.5 0 11-1.18 4.458.75.75 0 10-1.493.154 8.001 8.001 0 101.6-5.684zM7.75 4a.75.75 0 01.75.75v2.992l2.028.812a.75.75 0 01-.557 1.392l-2.5-1A.75.75 0 017 8.25v-3.5A.75.75 0 017.75 4z"/></svg>
      <text x="25" y="84" class="stat-label">Commit's Count:</text>
      <text x="330" y="84" class="stat-value" text-anchor="end">${formatK(commits)}</text>
      
      <svg x="0" y="96" viewBox="0 0 16 16" width="16" height="16"><path class="icon" fill-rule="evenodd" d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z"/></svg>
      <text x="25" y="108" class="stat-label">Total PRs:</text>
      <text x="330" y="108" class="stat-value" text-anchor="end">${stats.prs}</text>
      
      <svg x="0" y="120" viewBox="0 0 16 16" width="16" height="16"><path class="icon" fill-rule="evenodd" d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z"/></svg>
      <text x="25" y="132" class="stat-label">Total PRs Merged:</text>
      <text x="330" y="132" class="stat-value" text-anchor="end">${stats.mergedPRs}</text>
      
      <svg x="0" y="144" viewBox="0 0 16 16" width="16" height="16"><path class="icon" fill-rule="evenodd" d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM0 8a8 8 0 1116 0A8 8 0 010 8zm9 3a1 1 0 11-2 0 1 1 0 012 0zm-.25-6.25a.75.75 0 00-1.5 0v3.5a.75.75 0 001.5 0v-3.5z"/></svg>
      <text x="25" y="156" class="stat-label">Total Issues:</text>
      <text x="330" y="156" class="stat-value" text-anchor="end">${stats.issues}</text>
      
      <svg x="0" y="168" viewBox="0 0 16 16" width="16" height="16"><path class="icon" fill-rule="evenodd" d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 110-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1V9h-8c-.356 0-.694.074-1 .208V2.5a1 1 0 011-1h8zM5 12.25v3.25a.25.25 0 00.4.2l1.45-1.087a.25.25 0 01.3 0L8.6 15.7a.25.25 0 00.4-.2v-3.25a.25.25 0 00-.25-.25h-3.5a.25.25 0 00-.25.25z"/></svg>
      <text x="25" y="180" class="stat-label">Contributed to (last year):</text>
      <text x="330" y="180" class="stat-value" text-anchor="end">${stats.contributedTo}</text>
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
    commits, prs: stats.prs, issues: stats.issues, followers: stats.followers, gists: stats.gists, scratchWorks: stats.scratchWorks
  }));
  
  console.log(`✓ Generated rank.svg, github-stats.svg, and stats.json successfully.`);
}

main().catch((err) => {
  console.error("✗ generate-rank failed:", err.message);
  process.exit(1);
});
