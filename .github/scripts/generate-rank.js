const https = require("https");
const fs = require("fs");

// Allow username to be passed via environment variable or default to yours
const username = process.env.GITHUB_USERNAME || "Karthigaiselvam-R-official";
const token = process.env.GITHUB_TOKEN;

function exponential_cdf(x) { return 1 - Math.pow(2, -x); }
function log_normal_cdf(x) { return x / (1 + x); }

function calculateRank({ commits, prs, issues, stars, followers }) {
  const COMMITS_MEDIAN = 250, COMMITS_WEIGHT = 2;
  const PRS_MEDIAN = 50,      PRS_WEIGHT = 3;
  const ISSUES_MEDIAN = 25,   ISSUES_WEIGHT = 1;
  const STARS_MEDIAN = 50,    STARS_WEIGHT = 4;
  const FOLLOWERS_MEDIAN = 10, FOLLOWERS_WEIGHT = 1;
  const TOTAL_WEIGHT = COMMITS_WEIGHT + PRS_WEIGHT + ISSUES_WEIGHT + STARS_WEIGHT + FOLLOWERS_WEIGHT;

  const score = 1 - (
    COMMITS_WEIGHT   * exponential_cdf(commits   / COMMITS_MEDIAN) +
    PRS_WEIGHT       * exponential_cdf(prs        / PRS_MEDIAN) +
    ISSUES_WEIGHT    * exponential_cdf(issues     / ISSUES_MEDIAN) +
    STARS_WEIGHT     * log_normal_cdf(stars       / STARS_MEDIAN) +
    FOLLOWERS_WEIGHT * log_normal_cdf(followers   / FOLLOWERS_MEDIAN)
  ) / TOTAL_WEIGHT;

  const pct = score * 100;
  const THRESHOLDS = [1, 12.5, 25, 37.5, 50, 62.5, 75, 87.5, 100];
  const LEVELS     = ["S", "A+", "A", "A-", "B+", "B", "B-", "C+", "C"];
  const level = LEVELS[THRESHOLDS.findIndex(t => pct <= t)];
  
  return { level, percentile: pct.toFixed(1) };
}

function query(q) {
  return new Promise((resolve, reject) => {
    if (!token) {
      return reject(new Error("GITHUB_TOKEN environment variable is missing!"));
    }

    const data = JSON.stringify({ query: q });
    const req = https.request({
      hostname: "api.github.com",
      path: "/graphql",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `bearer ${token}`,
        "User-Agent": "rank-generator"
      }
    }, res => {
      let body = "";
      res.on("data", d => body += d);
      res.on("end", () => resolve(JSON.parse(body)));
    });
    
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  try {
    // Query 1: Get basic stats + account creation date
    const res = await query(`{
      user(login: "${username}") {
        createdAt
        followers { totalCount }
        repositories(ownerAffiliations: OWNER, isFork: false, first: 100) {
          nodes { stargazers { totalCount } }
        }
        pullRequests { totalCount }
        issues { totalCount }
      }
    }`);

    // Robust error handling for GraphQL errors
    if (res.errors) {
      console.error("GraphQL Error:", res.errors[0].message);
      process.exit(1);
    }
    
    if (!res.data || !res.data.user) {
      console.error("Could not fetch user data. Check the username provided.");
      process.exit(1);
    }

    const user = res.data.user;
    
    // Query 2: Fetch ALL-TIME commits (public + private) by iterating through years
    const creationYear = new Date(user.createdAt).getFullYear();
    const currentYear = new Date().getFullYear();

    let commitsQuery = `query { user(login: "${username}") { `;
    for (let i = creationYear; i <= currentYear; i++) {
      commitsQuery += `
        year${i}: contributionsCollection(from: "${i}-01-01T00:00:00Z", to: "${i}-12-31T23:59:59Z") {
          totalCommitContributions
          restrictedContributionsCount
        }
      `;
    }
    commitsQuery += ` } }`;

    const commitsRes = await query(commitsQuery);

    if (commitsRes.errors) {
      console.error("GraphQL Error fetching commits:", commitsRes.errors[0].message);
      process.exit(1);
    }

    let commits = 0;
    for (let i = creationYear; i <= currentYear; i++) {
      const yearData = commitsRes.data.user[`year${i}`];
      if (yearData) {
        // Adds both public (totalCommitContributions) and private (restrictedContributionsCount)
        commits += yearData.totalCommitContributions + yearData.restrictedContributionsCount;
      }
    }
    
    // Calculate other stats
    const stars     = user.repositories.nodes.reduce((a, r) => a + r.stargazers.totalCount, 0);
    const prs       = user.pullRequests.totalCount;
    const issues    = user.issues.totalCount;
    const followers = user.followers.totalCount;

    const { level, percentile } = calculateRank({ commits, prs, issues, stars, followers });

    // Color per rank level
    const colors = {
      S: "#EF9F27", "A+": "#1D9E75", A: "#1D9E75", "A-": "#1D9E75",
      "B+": "#3B8BD4", B: "#3B8BD4", "B-": "#3B8BD4", "C+": "#888780", C: "#888780"
    };
    const color = colors[level] || "#888780";

    // Fixed SVG layout: Width expanded to 350, x set to 175 for perfect centering!
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="350" height="120" viewBox="0 0 350 120">
  <rect width="350" height="120" rx="12" fill="#0d0221"/>
  <rect width="348" height="118" x="1" y="1" rx="11" fill="none" stroke="${color}" stroke-width="1.5"/>
  <text x="175" y="28" text-anchor="middle" font-family="monospace" font-size="13" fill="#00fffa">GitHub Rank</text>
  <text x="175" y="78" text-anchor="middle" font-family="monospace" font-size="52" font-weight="bold" fill="${color}">${level}</text>
  <text x="175" y="108" text-anchor="middle" font-family="monospace" font-size="13" fill="#FEE75C">Top ${percentile}%  •  ${commits} commits  •  ⭐ ${stars}</text>
</svg>`;

    fs.mkdirSync("rank-card", { recursive: true });
    fs.writeFileSync("rank-card/rank.svg", svg);
    console.log(`Successfully generated rank card for ${username}!`);
    console.log(`Rank: ${level} | Percentile: ${percentile}%`);
    
  } catch (error) {
    console.error("Failed to generate rank:", error.message);
    process.exit(1);
  }
}

main();
