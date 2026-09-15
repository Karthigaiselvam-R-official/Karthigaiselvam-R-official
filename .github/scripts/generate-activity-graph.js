const https = require("https");
const fs = require("fs");

const USERNAME = process.env.GITHUB_USERNAME || "Karthigaiselvam-R-official";
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

// Options for exactly replicating the graph style
const options = {
  width: 1200,
  height: 460, // Increased height to give plenty of room for rotated labels
  colors: {
    bgColor: "000000",
    color: "FEE75C", // Text and title color
    lineColor: "00fffa",
    pointColor: "FEE75C",
    areaColor: "00fffa"
  },
  padding: { top: 80, right: 50, bottom: 80, left: 50 },
  radius: 15 // Curved edges
};

function graphql(q, variables) {
  return new Promise((resolve, reject) => {
    if (!TOKEN) return reject(new Error("GITHUB_TOKEN is not set."));

    const body = JSON.stringify({ query: q, variables });
    const req = https.request(
      {
        hostname: "api.github.com",
        path: "/graphql",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `bearer ${TOKEN}`,
          "User-Agent": "rank-generator/2.2",
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch {
            return reject(new Error(`Non-JSON: ${raw.slice(0, 200)}`));
          }
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

// Generate the Cardinal Spline bezier curve path
function getCurvePath(points) {
  if (points.length === 0) return '';
  let path = `M ${points[0].x},${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(i - 1, 0)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(i + 2, points.length - 1)];

    // Catmull-Rom to Bezier control points (tension = 0) -> gives smooth curve
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;

    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;

    path += ` C ${cp1x.toFixed(2)},${cp1y.toFixed(2)} ${cp2x.toFixed(2)},${cp2y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`;
  }
  return path;
}

// Dynamically calculates clean axis steps (e.g., jumps of 10, 20, 50, 100)
function calcYScale(maxVal) {
  if (maxVal === 0) return { max: 5, sections: 5, step: 1 };
  const roughStep = maxVal / 5;
  const mag = Math.pow(10, Math.floor(Math.log10(roughStep || 1)));
  const norm = roughStep / mag; 
  
  let step;
  if (norm < 1.5) step = 1 * mag;
  else if (norm < 3.5) step = 2 * mag;
  else if (norm < 7.5) step = 5 * mag;
  else step = 10 * mag;
  
  let niceMax = Math.ceil(maxVal / step) * step;
  
  // Add a small buffer so the peak doesn't touch the absolute ceiling
  if (niceMax - maxVal < step * 0.2) {
    niceMax += step;
  }
  
  const sections = Math.round(niceMax / step);
  return { max: niceMax, sections, step };
}

async function main() {
  console.log(`Generating activity graph for: ${USERNAME}`);
  
  // Calculate date range: last 31 days
  const from = new Date();
  from.setDate(from.getDate() - 31);
  const to = new Date();
  to.setDate(to.getDate() + 1);

  const query = `
    query userInfo($LOGIN: String!, $FROM: DateTime!, $TO: DateTime!) {
      user(login: $LOGIN) {
        name
        contributionsCollection(from: $FROM, to: $TO) {
          contributionCalendar {
            weeks {
              contributionDays {
                contributionCount
                date
              }
            }
          }
        }
      }
    }
  `;

  const vars = { LOGIN: USERNAME, FROM: from.toISOString(), TO: to.toISOString() };
  const res = await graphql(query, vars);
  
  if (res.errors && res.errors.length > 0) throw new Error(res.errors[0].message);
  if (!res.data || !res.data.user) throw new Error("Could not fetch user data.");

  const name = res.data.user.name || USERNAME;
  const weeks = res.data.user.contributionsCollection.contributionCalendar.weeks;
  
  let days = [];
  for (const w of weeks) {
    for (const d of w.contributionDays) {
      days.push(d);
    }
  }

  // Exact 31 days
  if (days.length > 31) days = days.slice(days.length - 31);

  // We need to build the SVG layout manually
  const w = options.width - options.padding.left - options.padding.right;
  const h = options.height - options.padding.top - options.padding.bottom;
  
  // Max contributions for Y scaling
  let actualMax = Math.max(...days.map(d => d.contributionCount));
  const yScale = calcYScale(actualMax);
  const maxCount = yScale.max;

  // Build grid lines and labels
  let gridLines = '';
  let yLabels = '';
  
  // Y-axis grid 
  for (let i = 0; i <= yScale.sections; i++) {
    const yVal = yScale.step * i;
    const yPos = options.padding.top + h - (h / yScale.sections) * i;
    
    // Grid horizontal line
    gridLines += `<line x1="${options.padding.left}" y1="${yPos}" x2="${options.padding.left + w}" y2="${yPos}" class="ct-grid" />\n`;
    // Y Label
    yLabels += `<text x="${options.padding.left - 10}" y="${yPos + 4}" class="ct-label ct-vertical ct-start">${yVal}</text>\n`;
  }

  // X-axis mapping
  let points = [];
  let xLabels = '';
  
  for (let i = 0; i < days.length; i++) {
    const xPos = options.padding.left + (w / (days.length - 1)) * i;
    const yPos = options.padding.top + h - (days[i].contributionCount / maxCount) * h;
    points.push({ x: xPos, y: yPos });
    
    // X Label (Month + Day)
    const dateParts = days[i].date.split('-');
    const dateObj = new Date(dateParts[0], dateParts[1] - 1, dateParts[2]);
    const monthStr = dateObj.toLocaleString('en-US', { month: 'short' });
    const dayStr = parseInt(dateParts[2], 10).toString();
    const labelStr = `${monthStr} ${dayStr}`;
    
    // Rotate text by -45 degrees for better spacing
    xLabels += `<text x="${xPos}" y="${options.padding.top + h + 25}" class="ct-label" transform="rotate(-45, ${xPos}, ${options.padding.top + h + 25})" style="font-size: 13px; text-anchor: end;">${labelStr}</text>\n`;
  }
  
  // Y-axis title
  const yAxisTitle = `<text x="15" y="${options.padding.top + h / 2}" class="ct-label" transform="rotate(-90, 15, ${options.padding.top + h / 2})" style="font-size: 16px; font-weight: bold;">Contributions</text>`;
  
  // Generate curve path
  const curvePath = getCurvePath(points);
  
  // Area path (curve + close down to the bottom)
  const areaPath = `${curvePath} L ${points[points.length - 1].x},${options.padding.top + h} L ${points[0].x},${options.padding.top + h} Z`;

  // Draw points
  let pointsSvg = '';
  for (const pt of points) {
    pointsSvg += `<line x1="${pt.x}" y1="${pt.y}" x2="${pt.x + 0.01}" y2="${pt.y}" class="ct-point"></line>\n`;
  }

  const svg = `<svg width="${options.width}" height="${options.height}" viewBox="0 0 ${options.width} ${options.height}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="100%" height="100%" rx="${options.radius}" fill="#${options.colors.bgColor}" stroke="none"/>
  <style>
    body { font: 600 18px 'Segoe UI', Ubuntu, Sans-Serif; }
    .header { font: 600 20px 'Segoe UI', Ubuntu, Sans-Serif; text-align: center; color: #${options.colors.color}; margin-top: 20px; }
    svg { font: 600 18px 'Segoe UI', Ubuntu, Sans-Serif; user-select: none; }
    
    .ct-label { fill: #${options.colors.color}; font-size: 14px; line-height: 1; text-anchor: middle; }
    .ct-vertical.ct-start { text-anchor: end; }
    .ct-grid { stroke: #${options.colors.color}; stroke-width: 1px; stroke-opacity: 0.3; stroke-dasharray: 2px; }
    
    .ct-point {
      stroke-width: 10px;
      stroke-linecap: round;
      stroke: #${options.colors.pointColor};
      animation: blink 1s ease-in-out forwards;
      opacity: 0;
    }
    .ct-line {
      stroke-width: 4px;
      stroke-dasharray: 5000;
      stroke-dashoffset: 5000;
      stroke: #${options.colors.lineColor};
      animation: dash 5s ease-in-out forwards;
      fill: none;
    }
    .ct-area {
      stroke: none;
      fill-opacity: 0.1;
      fill: #${options.colors.areaColor};
    }
    
    @keyframes dash {
      from { stroke-dashoffset: 5000; }
      to { stroke-dashoffset: 0; }
    }
    @keyframes blink {
      0% { opacity: 0; }
      100% { opacity: 1; }
    }
  </style>

  <foreignObject x="0" y="0" width="${options.width}" height="50">
    <h1 xmlns="http://www.w3.org/1999/xhtml" class="header">
      ${name}'s Contribution Graph
    </h1>
  </foreignObject>

  <!-- Grid -->
  ${gridLines}
  ${yLabels}
  ${yAxisTitle}
  ${xLabels}

  <!-- Data graph -->
  <path class="ct-area" d="${areaPath}" />
  <path class="ct-line" d="${curvePath}" />
  ${pointsSvg}

</svg>`;

  fs.mkdirSync("rank-card", { recursive: true });
  fs.writeFileSync("rank-card/activity-graph.svg", svg);
  console.log(`✓ Generated activity-graph.svg successfully.`);
}

main().catch((err) => {
  console.error("✗ generate-activity-graph failed:", err.message);
  process.exit(1);
});
