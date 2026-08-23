/**
 * The bash/node programs that run detached inside a sandbox. They communicate
 * back exclusively through three files the poller reads: /nc/run.log (stdout
 * of everything), /nc/exit-code, and /nc/result.json.
 *
 * Everything dynamic arrives via environment variables set at launch — the
 * scripts themselves are static strings, so nothing user-typed is ever
 * interpolated into bash.
 */

export interface DevConfig {
  readonly repo: string; // e.g. 'agajews/personalbase'
  readonly trunk: string; // PR base branch
  readonly githubToken: string;
  readonly anthropicApiKey: string;
  readonly flyDeployTokenWorker: string;
  readonly flyDeployTokenUi: string;
}

export function devConfigFromEnv(): DevConfig {
  const require = (name: string): string => {
    const value = process.env[name];
    if (value === undefined || value === "") {
      throw new Error(`${name} is not set`);
    }
    return value;
  };
  return {
    repo: process.env["DEV_REPO"] ?? "agajews/personalbase",
    trunk: process.env["DEV_TRUNK"] ?? "worktree-claude",
    githubToken: require("GITHUB_TOKEN"),
    anthropicApiKey: require("ANTHROPIC_API_KEY"),
    // Only the merge lane passes these into a sandbox.
    flyDeployTokenWorker: process.env["FLY_DEPLOY_TOKEN_WORKER"] ?? "",
    flyDeployTokenUi: process.env["FLY_DEPLOY_TOKEN_UI"] ?? "",
  };
}

/** The prompt handed to Claude Code inside a feature sandbox. */
export function featureSpec(args: {
  repo: string;
  trunk: string;
  branch: string;
  title: string;
  spec: string;
}): string {
  return `You are a background dev agent working on a clone of ${args.repo}, on branch \
${args.branch} (branched from ${args.trunk}). Dependencies are installed.

# Task: ${args.title}

${args.spec}

# House rules

- Read DESIGN.md and the surrounding code first; match the existing style exactly.
- Commit as you go with clear messages. Do NOT push and do NOT open a PR — the \
harness pushes your branch and opens the PR when you finish.
- Before finishing, write /nc/pr.md: first line is the PR title, the rest is the PR \
description (what changed, how you verified it).
- Run \`pnpm typecheck\` and fix any failures before finishing.
- Database-backed tests are unavailable in this sandbox; do not block on them, but \
keep \`pnpm typecheck\` green.
- Never modify ${args.trunk} directly, never rewrite public history, never write \
secrets into the repo.`;
}

export const featureRunScript = `#!/usr/bin/env bash
set -uo pipefail
cd /nc
echo "[nc] cloning $DEV_REPO"
git clone --quiet "https://x-access-token:\${GITHUB_TOKEN}@github.com/\${DEV_REPO}.git" repo \
  || { echo '{"error":"clone failed"}' > /nc/result.json; exit 1; }
cd repo
git config user.name "nc dev agent"
git config user.email "dev-agent@personalbase.invalid"
git checkout -qb "$DEV_BRANCH" "origin/$DEV_TRUNK" \
  || { echo '{"error":"branch checkout failed"}' > /nc/result.json; exit 1; }
echo "[nc] installing dependencies"
corepack enable > /dev/null 2>&1 || true
pnpm install --frozen-lockfile > /dev/null 2>&1 \
  || { echo '{"error":"pnpm install failed"}' > /nc/result.json; exit 1; }
echo "[nc] installing claude code"
npm install -g @anthropic-ai/claude-code > /dev/null 2>&1 \
  || { echo '{"error":"claude code install failed"}' > /nc/result.json; exit 1; }
echo "[nc] starting claude"
claude -p "$(cat /nc/spec.md)" --output-format stream-json --verbose \
  --dangerously-skip-permissions
CLAUDE_EXIT=$?
echo "[nc] claude exited with $CLAUDE_EXIT"
git add -A > /dev/null 2>&1 && git commit -qm "Dev agent: remaining working-tree changes" > /dev/null 2>&1
if [ -z "$(git log "origin/$DEV_TRUNK..HEAD" --oneline)" ]; then
  echo "[nc] agent made no commits"
  echo '{"error":"agent made no commits"}' > /nc/result.json
  exit 1
fi
echo "[nc] pushing $DEV_BRANCH"
git push -q origin "$DEV_BRANCH" \
  || { echo '{"error":"push failed"}' > /nc/result.json; exit 1; }
echo "[nc] opening pull request"
node /nc/finish.mjs || { echo '{"error":"PR creation failed"}' > /nc/result.json; exit 1; }
echo "[nc] done"
exit 0
`;

/** Opens the PR from /nc/pr.md and writes /nc/result.json. Runs inside the sandbox. */
export const featureFinishScript = `import { readFileSync, writeFileSync } from "node:fs";
const repo = process.env.DEV_REPO;
const trunk = process.env.DEV_TRUNK;
const branch = process.env.DEV_BRANCH;
let title = process.env.DEV_TITLE;
let body = "Automated change by the dev agent.";
try {
  const pr = readFileSync("/nc/pr.md", "utf8").split("\\n");
  if (pr[0].trim() !== "") title = pr[0].trim();
  body = pr.slice(1).join("\\n").trim() || body;
} catch {}
body += "\\n\\n🤖 Opened by the personalbase dev agent.";
const response = await fetch(\`https://api.github.com/repos/\${repo}/pulls\`, {
  method: "POST",
  headers: {
    authorization: \`Bearer \${process.env.GITHUB_TOKEN}\`,
    accept: "application/vnd.github+json",
  },
  body: JSON.stringify({ title, body, head: branch, base: trunk }),
});
const data = await response.json();
if (!response.ok) {
  console.log("[nc] PR creation failed:", JSON.stringify(data));
  process.exit(1);
}
writeFileSync(
  "/nc/result.json",
  JSON.stringify({ prNumber: data.number, prUrl: data.html_url, branch, title }),
);
console.log("[nc] opened PR", data.html_url);
`;

export const mergeRunScript = `#!/usr/bin/env bash
set -uo pipefail
cd /nc
echo "[nc] cloning $DEV_REPO"
git clone --quiet "https://x-access-token:\${GITHUB_TOKEN}@github.com/\${DEV_REPO}.git" repo \
  || { echo '{"error":"clone failed"}' > /nc/result.json; exit 1; }
cd repo
git config user.name "nc merge agent"
git config user.email "merge-agent@personalbase.invalid"
echo "[nc] checking out PR #$DEV_PR_NUMBER"
git fetch -q origin "pull/$DEV_PR_NUMBER/head:pr-branch" \
  || { echo '{"error":"PR fetch failed"}' > /nc/result.json; exit 1; }
git checkout -q pr-branch
echo "[nc] rebasing onto $DEV_TRUNK"
git rebase "origin/$DEV_TRUNK" \
  || { echo '{"error":"rebase conflict; resolve manually"}' > /nc/result.json; exit 1; }
echo "[nc] installing dependencies"
corepack enable > /dev/null 2>&1 || true
pnpm install --frozen-lockfile > /dev/null 2>&1 || pnpm install > /dev/null 2>&1 \
  || { echo '{"error":"pnpm install failed"}' > /nc/result.json; exit 1; }
echo "[nc] typechecking the rebased PR"
pnpm typecheck \
  || { echo '{"error":"typecheck failed on rebased PR"}' > /nc/result.json; exit 1; }
echo "[nc] merging via GitHub API"
node /nc/merge.mjs || { echo '{"error":"merge failed"}' > /nc/result.json; exit 1; }
echo "[nc] deploying from merged trunk"
git checkout -q "$DEV_TRUNK" && git pull -q origin "$DEV_TRUNK"
curl -fsSL https://fly.io/install.sh 2>/dev/null | sh > /dev/null 2>&1
export FLYCTL_INSTALL="$HOME/.fly"
export PATH="$FLYCTL_INSTALL/bin:$PATH"
DEPLOYED=""
if [ -n "\${FLY_DEPLOY_TOKEN_WORKER:-}" ]; then
  echo "[nc] deploying personalbase-worker"
  FLY_API_TOKEN="$FLY_DEPLOY_TOKEN_WORKER" flyctl deploy -c fly.toml --remote-only \
    && DEPLOYED="$DEPLOYED personalbase-worker" || echo "[nc] worker deploy FAILED"
fi
if [ -n "\${FLY_DEPLOY_TOKEN_UI:-}" ]; then
  echo "[nc] deploying personalbase-ui"
  FLY_API_TOKEN="$FLY_DEPLOY_TOKEN_UI" flyctl deploy -c fly.ui.toml --remote-only \
    && DEPLOYED="$DEPLOYED personalbase-ui" || echo "[nc] ui deploy FAILED"
fi
NC_DEPLOYED="$DEPLOYED" node -e "
const { readFileSync, writeFileSync } = require('node:fs');
const merged = JSON.parse(readFileSync('/nc/merged.json', 'utf8'));
writeFileSync('/nc/result.json', JSON.stringify({
  mergedSha: merged.sha,
  deployed: (process.env.NC_DEPLOYED || '').trim().split(' ').filter(Boolean),
}));
"
echo "[nc] done"
exit 0
`;

/** Squash-merges the PR via the GitHub API and records the merge sha. */
export const mergeFinishScript = `import { writeFileSync } from "node:fs";
const repo = process.env.DEV_REPO;
const pr = process.env.DEV_PR_NUMBER;
const response = await fetch(\`https://api.github.com/repos/\${repo}/pulls/\${pr}/merge\`, {
  method: "PUT",
  headers: {
    authorization: \`Bearer \${process.env.GITHUB_TOKEN}\`,
    accept: "application/vnd.github+json",
  },
  body: JSON.stringify({ merge_method: "squash" }),
});
const data = await response.json();
if (!response.ok || data.merged !== true) {
  console.log("[nc] merge failed:", JSON.stringify(data));
  process.exit(1);
}
writeFileSync("/nc/merged.json", JSON.stringify({ sha: data.sha }));
console.log("[nc] merged as", data.sha);
`;
