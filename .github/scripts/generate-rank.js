const https = require("https");
const fs = require("fs");

const username = "Karthigaiselvam-R-official";
const token = process.env.GITHUB_TOKEN;

function exponential_cdf(x) { return 1 - Math.pow(2, -x); }
function log_normal_cdf(x) { return x / (1 + x); }

function calculateRank({ commits, prs, issues, stars, followers }) {
  const COMMITS_MEDIAN = 250, COMMITS_WEIGHT = 2;
  const PRS_MEDIAN = 50,     PRS_WEIGHT = 3;
  const ISSUES_MEDIAN = 25,  ISSUES_WEIGHT = 1;
  const STARS_MEDIAN = 50,   STARS_WEIGHT = 4;
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
  const res = await query(`{
    user(login: "${username}") {
      followers { totalCount }
      repositories(ownerAffiliations: OWNER, isFork: false, first: 100) {
        nodes { stargazers { totalCount } }
      }
      pullRequests { totalCount }
      issues { totalCount }
      contributionsCollection {
        totalCommitContributions
        restrictedContributionsCount
      }
    }
  }`);

  const user = res.data.user;
  const stars     = user.repositories.nodes.reduce((a, r) => a + r.stargazers.totalCount, 0);
  const commits   = user.contributionsCollection.totalCommitContributions
                  + user.contributionsCollection.restrictedContributionsCount;
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

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="120" viewBox="0 0 220 120">
  <rect width="220" height="120" rx="12" fill="#0d0221"/>
  <rect width="218" height="118" x="1" y="1" rx="11" fill="none" stroke="${color}" stroke-width="1.5"/>
  <text x="110" y="28" text-anchor="middle" font-family="monospace" font-size="13" fill="#00fffa">GitHub Rank</text>
  <text x="110" y="78" text-anchor="middle" font-family="monospace" font-size="52" font-weight="bold" fill="${color}">${level}</text>
  <text x="110" y="108" text-anchor="middle" font-family="monospace" font-size="12" fill="#FEE75C">Top ${percentile}%  •  ${commits} commits  •  ⭐ ${stars}</text>
</svg>`;

  fs.mkdirSync("rank-card", { recursive: true });
  fs.writeFileSync("rank-card/rank.svg", svg);
  console.log(`Rank: ${level} | Percentile: ${percentile}%`);
}

main();
