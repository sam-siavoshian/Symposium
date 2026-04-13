#!/usr/bin/env bun
/**
 * collect_results.ts
 * Gathers benchmark results and produces:
 *   - comparison.json   structured data
 *   - report.html       beautiful interactive chart
 *
 * Usage:
 *   bun run collect_results.ts <results-dir>
 *   bun run collect_results.ts --baseline <dir> --enhanced <dir>
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, resolve } from "path";

const SWE_TASKS = [
  "fix-code-vulnerability",
  "fix-git",
  "fix-ocaml-gc",
  "cancel-async-tasks",
  "cobol-modernization",
  "compile-compcert",
  "configure-git-webserver",
  "git-leak-recovery",
  "git-multibranch",
  "polyglot-c-py",
  "polyglot-rust-c",
  "query-optimize",
  "sanitize-git-repo",
];

interface TaskResult {
  task: string;
  reward: number;
  duration_sec?: number;
  status: "PASS" | "FAIL" | "MISSING";
}

interface RunResults {
  mode: string;
  tasks: TaskResult[];
  passed: number;
  total: number;
  score_pct: number;
}

function readReward(dir: string, task: string): TaskResult {
  const rewardPath = join(dir, task, "reward.txt");
  const metaPath = join(dir, task, "meta.json");

  if (!existsSync(rewardPath)) {
    return { task, reward: 0, status: "MISSING" };
  }

  const raw = readFileSync(rewardPath, "utf8").trim();
  const reward = parseFloat(raw) || 0;

  let duration_sec: number | undefined;
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf8"));
      duration_sec = meta.duration_sec;
    } catch {}
  }

  return {
    task,
    reward,
    duration_sec,
    status: reward >= 1 ? "PASS" : "FAIL",
  };
}

function collectRun(dir: string, mode: string): RunResults {
  const tasks = SWE_TASKS.map((t) => readReward(dir, t));
  const passed = tasks.filter((t) => t.status === "PASS").length;
  const total = tasks.filter((t) => t.status !== "MISSING").length || tasks.length;
  return {
    mode,
    tasks,
    passed,
    total,
    score_pct: total > 0 ? Math.round((passed / total) * 100 * 10) / 10 : 0,
  };
}

function generateHTML(baseline: RunResults, enhanced: RunResults): string {
  const taskLabels = SWE_TASKS.map((t) =>
    t.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );

  const baselineData = SWE_TASKS.map((t) => {
    const r = baseline.tasks.find((x) => x.task === t);
    return r?.reward ?? 0;
  });

  const enhancedData = SWE_TASKS.map((t) => {
    const r = enhanced.tasks.find((x) => x.task === t);
    return r?.reward ?? 0;
  });

  const improvementTasks = SWE_TASKS.filter((_t, i) => enhancedData[i] > baselineData[i]);
  const regressionTasks = SWE_TASKS.filter((_t, i) => enhancedData[i] < baselineData[i]);
  const delta = enhanced.passed - baseline.passed;
  const deltaSign = delta >= 0 ? "+" : "";

  const taskRows = SWE_TASKS.map((t, i) => {
    const b = baselineData[i];
    const e = enhancedData[i];
    const bIcon = b ? "\u2705" : "\u274C";
    const eIcon = e ? "\u2705" : "\u274C";
    let trend = "\u2192";
    let trendClass = "neutral";
    if (e > b) { trend = "\u2191"; trendClass = "improved"; }
    if (e < b) { trend = "\u2193"; trendClass = "regressed"; }
    const er = enhanced.tasks.find((x) => x.task === t);
    const br = baseline.tasks.find((x) => x.task === t);
    const eDur = er?.duration_sec ? `${er.duration_sec}s` : "-";
    const bDur = br?.duration_sec ? `${br.duration_sec}s` : "-";
    return `
      <tr class="${trendClass}-row">
        <td class="task-name">${t}</td>
        <td class="center">${bIcon}</td>
        <td class="center">${eIcon}</td>
        <td class="center trend ${trendClass}">${trend}</td>
        <td class="center time">${bDur}</td>
        <td class="center time">${eDur}</td>
      </tr>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Symposium vs Vanilla Claude - Terminal Bench 2.0</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
  <style>
    :root {
      --bg: #0d0f14;
      --surface: #161a23;
      --surface2: #1e2330;
      --border: #2a3045;
      --text: #e2e8f0;
      --muted: #8896b3;
      --green: #00e5a0;
      --blue: #4f9cf9;
      --red: #ff6b7a;
      --yellow: #ffc93c;
      --purple: #a78bfa;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      padding: 2rem;
      max-width: 1200px;
      margin: 0 auto;
    }
    .header { text-align: center; margin-bottom: 3rem; }
    .header .badge {
      display: inline-block;
      background: linear-gradient(135deg, #1e2330, #2a3045);
      border: 1px solid var(--green);
      border-radius: 100px;
      padding: 0.3rem 1rem;
      font-size: 0.75rem;
      color: var(--green);
      letter-spacing: 0.1em;
      text-transform: uppercase;
      margin-bottom: 1rem;
    }
    h1 {
      font-size: 2.5rem;
      font-weight: 800;
      background: linear-gradient(135deg, var(--green) 0%, var(--blue) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: 0.5rem;
    }
    .subtitle { color: var(--muted); font-size: 1rem; }
    .score-row {
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      gap: 1.5rem;
      margin-bottom: 2.5rem;
      align-items: center;
    }
    .score-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 2rem;
      text-align: center;
    }
    .score-card.winner {
      border-color: var(--green);
      box-shadow: 0 0 40px rgba(0, 229, 160, 0.12);
    }
    .score-card .label {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--muted);
      margin-bottom: 0.5rem;
    }
    .score-card .score {
      font-size: 3.5rem;
      font-weight: 900;
      line-height: 1;
    }
    .score-card.winner .score { color: var(--green); }
    .score-card:not(.winner) .score { color: var(--blue); }
    .score-card .fraction {
      font-size: 1rem;
      color: var(--muted);
      margin-top: 0.3rem;
    }
    .vs-block { text-align: center; }
    .delta-badge {
      background: ${delta >= 0 ? "rgba(0,229,160,0.15)" : "rgba(255,107,122,0.15)"};
      border: 1px solid ${delta >= 0 ? "var(--green)" : "var(--red)"};
      color: ${delta >= 0 ? "var(--green)" : "var(--red)"};
      border-radius: 12px;
      padding: 0.75rem 1.25rem;
      font-size: 1.5rem;
      font-weight: 800;
      margin-bottom: 0.5rem;
    }
    .vs-block .vs-label {
      font-size: 0.7rem;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }
    .charts-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1.5rem;
      margin-bottom: 2.5rem;
    }
    @media (max-width: 800px) {
      .charts-grid { grid-template-columns: 1fr; }
      .score-row { grid-template-columns: 1fr; }
    }
    .chart-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 1.5rem;
    }
    .chart-card.full-width { grid-column: 1 / -1; }
    .chart-card h3 {
      font-size: 0.85rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
      margin-bottom: 1.25rem;
    }
    canvas { max-height: 320px; }
    .table-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 1.5rem;
      margin-bottom: 2.5rem;
      overflow-x: auto;
    }
    .table-card h3 {
      font-size: 0.85rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
      margin-bottom: 1.25rem;
    }
    table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
    th {
      text-align: left;
      padding: 0.6rem 0.75rem;
      border-bottom: 1px solid var(--border);
      color: var(--muted);
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    td {
      padding: 0.7rem 0.75rem;
      border-bottom: 1px solid rgba(42,48,69,0.5);
    }
    td.center { text-align: center; }
    td.task-name { font-family: monospace; font-size: 0.85rem; color: var(--text); }
    td.time { color: var(--muted); font-size: 0.8rem; }
    tr.improved-row { background: rgba(0,229,160,0.04); }
    tr.regressed-row { background: rgba(255,107,122,0.04); }
    .trend.improved { color: var(--green); font-weight: 700; font-size: 1.1rem; }
    .trend.regressed { color: var(--red); font-weight: 700; font-size: 1.1rem; }
    .trend.neutral { color: var(--muted); }
    .insights {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 1rem;
      margin-bottom: 2.5rem;
    }
    .insight-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1.25rem;
      text-align: center;
    }
    .insight-card .number {
      font-size: 2.2rem;
      font-weight: 800;
      margin-bottom: 0.25rem;
    }
    .insight-card .insight-label {
      font-size: 0.75rem;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .insight-card.green .number { color: var(--green); }
    .insight-card.red .number { color: var(--red); }
    .insight-card.blue .number { color: var(--blue); }
    .footer {
      text-align: center;
      color: var(--muted);
      font-size: 0.75rem;
      margin-top: 3rem;
      padding-top: 1.5rem;
      border-top: 1px solid var(--border);
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="badge">Terminal Bench 2.0 - SWE Tasks</div>
    <h1>Symposium vs Vanilla Claude</h1>
    <p class="subtitle">13 SWE tasks | Opus 4.6 | Parallel execution | Binary pass/fail scoring</p>
  </div>
  <div class="score-row">
    <div class="score-card">
      <div class="label">Vanilla Claude (Baseline)</div>
      <div class="score">${baseline.score_pct}%</div>
      <div class="fraction">${baseline.passed} / ${baseline.total} tasks</div>
      <div style="margin-top:0.75rem;font-size:0.75rem;color:var(--muted);">--effort low | no MCP</div>
    </div>
    <div class="vs-block">
      <div class="delta-badge">${deltaSign}${delta} tasks</div>
      <div class="vs-label">${delta >= 0 ? "Symposium wins" : "Baseline wins"}</div>
    </div>
    <div class="score-card winner">
      <div class="label">Symposium MCP (Enhanced)</div>
      <div class="score">${enhanced.score_pct}%</div>
      <div class="fraction">${enhanced.passed} / ${enhanced.total} tasks</div>
      <div style="margin-top:0.75rem;font-size:0.75rem;color:var(--green);">--effort high | Symposium MCP</div>
    </div>
  </div>
  <div class="insights">
    <div class="insight-card green">
      <div class="number">${improvementTasks.length}</div>
      <div class="insight-label">Tasks gained by Symposium</div>
    </div>
    <div class="insight-card red">
      <div class="number">${regressionTasks.length}</div>
      <div class="insight-label">Tasks lost by Symposium</div>
    </div>
    <div class="insight-card blue">
      <div class="number">${deltaSign}${(enhanced.score_pct - baseline.score_pct).toFixed(1)}%</div>
      <div class="insight-label">Score delta</div>
    </div>
  </div>
  <div class="charts-grid">
    <div class="chart-card full-width">
      <h3>Task-by-Task Results</h3>
      <canvas id="taskChart"></canvas>
    </div>
    <div class="chart-card">
      <h3>Baseline Distribution</h3>
      <canvas id="baselinePie"></canvas>
    </div>
    <div class="chart-card">
      <h3>Symposium Distribution</h3>
      <canvas id="enhancedPie"></canvas>
    </div>
  </div>
  <div class="table-card">
    <h3>Per-Task Breakdown</h3>
    <table>
      <thead>
        <tr>
          <th>Task</th>
          <th class="center">Baseline</th>
          <th class="center">Symposium</th>
          <th class="center">Change</th>
          <th class="center">Baseline Time</th>
          <th class="center">Symposium Time</th>
        </tr>
      </thead>
      <tbody>${taskRows}</tbody>
    </table>
  </div>
  <div class="footer">
    Generated ${new Date().toLocaleString()} | Terminal Bench 2.0 | claude-opus-4-6
  </div>
  <script>
    const tasks = ${JSON.stringify(taskLabels)};
    const baseline = ${JSON.stringify(baselineData)};
    const enhanced = ${JSON.stringify(enhancedData)};
    const greenColor = 'rgba(0,229,160,0.85)';
    const blueColor = 'rgba(79,156,249,0.85)';
    const greenBorder = 'rgb(0,229,160)';
    const blueBorder = 'rgb(79,156,249)';
    new Chart(document.getElementById('taskChart'), {
      type: 'bar',
      data: {
        labels: tasks,
        datasets: [
          { label: 'Vanilla Claude', data: baseline, backgroundColor: blueColor, borderColor: blueBorder, borderWidth: 1, borderRadius: 4 },
          { label: 'Symposium MCP', data: enhanced, backgroundColor: greenColor, borderColor: greenBorder, borderWidth: 1, borderRadius: 4 }
        ]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { labels: { color: '#8896b3', font: { size: 12 } } },
          tooltip: { callbacks: { label: (ctx) => ctx.raw === 1 ? ctx.dataset.label + ': PASS' : ctx.dataset.label + ': FAIL' } }
        },
        scales: {
          x: { ticks: { color: '#8896b3', font: { size: 10 }, maxRotation: 35, minRotation: 20 }, grid: { color: 'rgba(42,48,69,0.5)' } },
          y: { min: 0, max: 1.2, ticks: { color: '#8896b3', callback: (v) => v === 0 ? 'FAIL' : v === 1 ? 'PASS' : '' }, grid: { color: 'rgba(42,48,69,0.5)' } }
        }
      }
    });
    const donutOpts = (passed, total, color) => ({
      type: 'doughnut',
      data: {
        labels: ['Passed', 'Failed'],
        datasets: [{ data: [passed, total - passed], backgroundColor: [color, 'rgba(42,48,69,0.7)'], borderColor: ['transparent', 'transparent'], borderWidth: 0, hoverOffset: 6 }]
      },
      options: {
        responsive: true,
        cutout: '72%',
        plugins: { legend: { labels: { color: '#8896b3', font: { size: 12 } } }, tooltip: { callbacks: { label: (ctx) => ctx.label + ': ' + ctx.raw + ' tasks' } } }
      }
    });
    new Chart(document.getElementById('baselinePie'), donutOpts(${baseline.passed}, ${baseline.total}, blueColor));
    new Chart(document.getElementById('enhancedPie'), donutOpts(${enhanced.passed}, ${enhanced.total}, greenColor));
  </script>
</body>
</html>`;
}

// --- Main ---
const args = process.argv.slice(2);
let baselineDir: string;
let enhancedDir: string;
let outDir: string;

if (args.includes("--baseline") && args.includes("--enhanced")) {
  const bi = args.indexOf("--baseline");
  const ei = args.indexOf("--enhanced");
  baselineDir = resolve(args[bi + 1]);
  enhancedDir = resolve(args[ei + 1]);
  outDir = resolve(enhancedDir, "..");
} else if (args.length >= 1) {
  const resultsDir = resolve(args[0]);
  baselineDir = join(resultsDir, "baseline");
  enhancedDir = join(resultsDir, "enhanced");
  outDir = resultsDir;
} else {
  console.error("Usage: bun run collect_results.ts <results-dir>");
  console.error("   or: bun run collect_results.ts --baseline <dir> --enhanced <dir>");
  process.exit(1);
}

if (!existsSync(baselineDir)) {
  console.error("Baseline dir not found: " + baselineDir);
  process.exit(1);
}
if (!existsSync(enhancedDir)) {
  console.error("Enhanced dir not found: " + enhancedDir);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

const baseline = collectRun(baselineDir, "baseline");
const enhanced = collectRun(enhancedDir, "enhanced");

const comparison = {
  generated_at: new Date().toISOString(),
  baseline,
  enhanced,
  delta: {
    tasks_gained: enhanced.passed - baseline.passed,
    score_pct_delta: Math.round((enhanced.score_pct - baseline.score_pct) * 10) / 10,
    improved_tasks: SWE_TASKS.filter(
      (t) =>
        (enhanced.tasks.find((x) => x.task === t)?.reward ?? 0) >
        (baseline.tasks.find((x) => x.task === t)?.reward ?? 0)
    ),
    regressed_tasks: SWE_TASKS.filter(
      (t) =>
        (enhanced.tasks.find((x) => x.task === t)?.reward ?? 0) <
        (baseline.tasks.find((x) => x.task === t)?.reward ?? 0)
    ),
  },
};

const compPath = join(outDir, "comparison.json");
writeFileSync(compPath, JSON.stringify(comparison, null, 2));
console.log("\nSaved: " + compPath);

const htmlPath = join(outDir, "report.html");
writeFileSync(htmlPath, generateHTML(baseline, enhanced));
console.log("Saved: " + htmlPath);

console.log("\n================================================");
console.log("  Terminal Bench 2.0 - SWE Results");
console.log("================================================");
console.log("  Vanilla Claude:  " + baseline.passed + "/" + baseline.total + "  (" + baseline.score_pct + "%)");
console.log("  Symposium MCP:   " + enhanced.passed + "/" + enhanced.total + "  (" + enhanced.score_pct + "%)");
const cd = comparison.delta;
console.log("  Delta:           " + (cd.tasks_gained >= 0 ? "+" : "") + cd.tasks_gained + " tasks  (" + (cd.score_pct_delta >= 0 ? "+" : "") + cd.score_pct_delta + "%)");
console.log("------------------------------------------------");

for (const task of SWE_TASKS) {
  const b = baseline.tasks.find((x) => x.task === task);
  const e = enhanced.tasks.find((x) => x.task === task);
  const bIcon = b?.status === "PASS" ? "PASS" : "FAIL";
  const eIcon = e?.status === "PASS" ? "PASS" : "FAIL";
  let arrow = "  ";
  if ((e?.reward ?? 0) > (b?.reward ?? 0)) arrow = "^ ";
  if ((e?.reward ?? 0) < (b?.reward ?? 0)) arrow = "v ";
  console.log("  " + arrow + task.padEnd(30) + " baseline=" + bIcon + "  symposium=" + eIcon);
}

console.log("================================================\n");
console.log('Open the report: open "' + htmlPath + '"');
