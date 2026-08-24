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
  /** Read-only connection string for live UI previews ("" disables them). */
  readonly previewDatabaseUrl: string;
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
    trunk: process.env["DEV_TRUNK"] ?? "main",
    githubToken: require("GITHUB_TOKEN"),
    anthropicApiKey: require("ANTHROPIC_API_KEY"),
    // Only the merge lane passes these into a sandbox.
    flyDeployTokenWorker: process.env["FLY_DEPLOY_TOKEN_WORKER"] ?? "",
    flyDeployTokenUi: process.env["FLY_DEPLOY_TOKEN_UI"] ?? "",
    previewDatabaseUrl: process.env["PREVIEW_DATABASE_URL"] ?? "",
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

- This is a live conversation: the user may send follow-ups at any time, and they \
arrive as new messages in this same session. Reply to them directly.
- Read DESIGN.md and the surrounding code first; match the existing style exactly.
- Do NOT push and do NOT open a PR yourself — after each of your turns, the \
harness pushes any commits on your branch and opens (or updates) the PR. Commit \
when a change is ready for review (or when the user asks); until then keep \
iterating.
- For UI work, run \`nc-preview\` (already on PATH) to start a live dev server \
against a read-only copy of production data — a private preview link appears on \
the user's task page automatically. Vite hot-reloads your edits; rerun nc-preview \
only after dependency or server-code changes. To verify visually yourself, you \
may install a browser (\`npx playwright install chromium\`) and screenshot \
http://127.0.0.1:5173.
- Before committing work that should land, write /nc/pr.md: first line is the PR \
title, the rest is the PR description (what changed, how you verified it).
- Run \`pnpm typecheck\` and fix any failures before finishing a turn with commits.
- Database-backed tests are unavailable in this sandbox; do not block on them, but \
keep \`pnpm typecheck\` green.
- Never modify ${args.trunk} directly, never rewrite public history, never write \
secrets into the repo.`;
}

/**
 * One script for every conversation turn of a feature task. Turn 1 clones and
 * pins the Claude session id; later turns (DEV_RESUME=1) reuse the workspace
 * and --resume the same session — the follow-up message is just the next
 * prompt. Every turn ends by pushing whatever was committed and making sure
 * the branch's PR exists.
 */
export const featureRunScript = `#!/usr/bin/env bash
set -uo pipefail
fail() { echo "{\\"error\\":\\"$1\\"}" > "$NC_RUN_DIR/result.json"; exit 1; }
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
mkdir -p /nc/bin
corepack enable --install-directory /nc/bin > /dev/null 2>&1 || true
export PATH="/nc/bin:$HOME/.local/bin:$PATH"
if [ ! -d /nc/repo ]; then
  echo "[nc] cloning $DEV_REPO"
  git clone --quiet "https://x-access-token:\${GITHUB_TOKEN}@github.com/\${DEV_REPO}.git" /nc/repo \
    || fail "clone failed"
  cd /nc/repo
  git config user.name "nc dev agent"
  git config user.email "dev-agent@personalbase.invalid"
  git checkout -qb "$DEV_BRANCH" "origin/$DEV_TRUNK" || fail "branch checkout failed"
else
  cd /nc/repo
  git checkout -q "$DEV_BRANCH" || fail "branch checkout failed"
fi
if ! command -v pnpm > /dev/null 2>&1; then
  echo "[nc] bootstrapping pnpm (slow the first time)"
  npm install -g pnpm --force > /dev/null 2>&1
fi
install -m 0755 "$NC_RUN_DIR/preview.sh" /nc/bin/nc-preview 2> /dev/null || true
if [ ! -d /nc/repo/node_modules ]; then
  echo "[nc] installing dependencies"
  pnpm install --frozen-lockfile > "$NC_RUN_DIR/install.log" 2>&1 \
    || { tail -20 "$NC_RUN_DIR/install.log"; fail "pnpm install failed"; }
fi
if ! command -v claude > /dev/null 2>&1; then
  echo "[nc] installing claude code"
  npm install -g @anthropic-ai/claude-code > "$NC_RUN_DIR/claude-install.log" 2>&1 \
    || { tail -20 "$NC_RUN_DIR/claude-install.log"; fail "claude code install failed"; }
fi
# One live Claude session per run: stream-json over a named pipe. The writer
# subshell delivers the initial prompt, then execs into a sleeper that holds
# the pipe open — killing it (holder.pid) EOFs stdin and the session ends
# gracefully. Follow-ups are streamed into the pipe by the harness.
rm -f "$NC_RUN_DIR/input"
mkfifo "$NC_RUN_DIR/input"
(
  node -e 'const fs = require("node:fs");
const text = fs.readFileSync(process.env.NC_RUN_DIR + "/prompt.md", "utf8");
process.stdout.write(JSON.stringify({
  type: "user", message: { role: "user", content: [{ type: "text", text }] },
}) + "\\n");'
  exec sleep 2147483647
) > "$NC_RUN_DIR/input" &
echo $! > "$NC_RUN_DIR/holder.pid"

# --resume FORKS the transcript under a fresh session id, so /nc/session-id
# always tracks the latest fork; the wrapper captures it from the stream the
# moment it appears (so even an interrupted run's id survives).
LAST_SESSION=$(cat /nc/session-id 2>/dev/null)
if [ -n "$LAST_SESSION" ]; then
  echo "[nc] starting claude session (resuming $LAST_SESSION)"
  RESUME_ARGS=(--resume "$LAST_SESSION")
else
  echo "[nc] starting claude session (new)"
  RESUME_ARGS=(--session-id "$DEV_SESSION_ID")
fi
claude -p --input-format stream-json --output-format stream-json --verbose \
  --dangerously-skip-permissions "\${RESUME_ARGS[@]}" < "$NC_RUN_DIR/input" | \
  while IFS= read -r line; do
    printf '%s\\n' "$line"
    if [ ! -f "$NC_RUN_DIR/sid-captured" ]; then
      SID=$(printf '%s' "$line" | grep -o '"session_id":"[0-9a-f-]*"' | head -1 | cut -d'"' -f4)
      if [ -n "$SID" ]; then
        printf '%s' "$SID" > /nc/session-id
        touch "$NC_RUN_DIR/sid-captured"
      fi
    fi
    case "$line" in
      '{"type":"result"'*) bash "$NC_RUN_DIR/turn-end.sh" 2>&1 ;;
    esac
  done
CLAUDE_EXIT=\${PIPESTATUS[0]}
echo "[nc] session ended with $CLAUDE_EXIT"
bash "$NC_RUN_DIR/turn-end.sh" 2>&1
echo '{"sessionEnded":true}' > "$NC_RUN_DIR/result.json"
exit 0
`;

/**
 * Runs after every completed turn (and at session end): publish whatever the
 * agent has committed and keep the branch's PR current. finish.mjs records
 * the PR in <runDir>/pr.json, which the poller watches.
 */
export const turnEndScript = `#!/usr/bin/env bash
export PATH="/nc/bin:$HOME/.local/bin:$PATH"
cd /nc/repo 2>/dev/null || exit 0
if [ -n "$(git log "origin/$DEV_TRUNK..HEAD" --oneline 2>/dev/null)" ]; then
  echo "[nc] pushing $DEV_BRANCH"
  git push -q origin "$DEV_BRANCH" 2>&1 || echo "[nc] push failed"
  node "$NC_RUN_DIR/finish.mjs" || echo "[nc] PR ensure failed"
fi
exit 0
`;

/**
 * Ensures the branch's PR exists (idempotent — turn N of a conversation finds
 * the PR turn 1 opened) and writes result.json. Runs inside the sandbox.
 */
export const featureFinishScript = `import { readFileSync, writeFileSync } from "node:fs";
const repo = process.env.DEV_REPO;
const trunk = process.env.DEV_TRUNK;
const branch = process.env.DEV_BRANCH;
const runDir = process.env.NC_RUN_DIR;
const headers = {
  authorization: \`Bearer \${process.env.GITHUB_TOKEN}\`,
  accept: "application/vnd.github+json",
};
let title = process.env.DEV_TITLE;
let body = "Automated change by the dev agent.";
try {
  const pr = readFileSync("/nc/pr.md", "utf8").split("\\n");
  if (pr[0].trim() !== "") title = pr[0].trim();
  body = pr.slice(1).join("\\n").trim() || body;
} catch {}
body += "\\n\\n🤖 Opened by the personalbase dev agent.";

const finish = (data) => {
  writeFileSync(
    \`\${runDir}/pr.json\`,
    JSON.stringify({ prNumber: data.number, prUrl: data.html_url, branch, title: data.title }),
  );
  console.log("[nc] PR ready:", data.html_url);
};

const existing = await fetch(
  \`https://api.github.com/repos/\${repo}/pulls?state=open&head=\${repo.split("/")[0]}:\${branch}\`,
  { headers },
);
const open = existing.ok ? await existing.json() : [];
if (Array.isArray(open) && open.length > 0) {
  finish(open[0]);
  process.exit(0);
}
const response = await fetch(\`https://api.github.com/repos/\${repo}/pulls\`, {
  method: "POST",
  headers,
  body: JSON.stringify({ title, body, head: branch, base: trunk }),
});
const data = await response.json();
if (!response.ok) {
  console.log("[nc] PR creation failed:", JSON.stringify(data));
  process.exit(1);
}
finish(data);
`;

/**
 * Installed as \`nc-preview\` in the sandbox. Just requests the preview: the
 * harness registers the dev servers as supervised sandbox services (the
 * sandbox URL proxies to a service's httpPort — loose processes are not
 * routable) and the link appears on the user's task page.
 */
export const previewScript = `#!/usr/bin/env bash
if [ -z "\${PREVIEW_DATABASE_URL:-}" ]; then
  echo "PREVIEW_DATABASE_URL is not set; previews are disabled"
  exit 1
fi
echo '{"port":5173}' > /nc/preview.json
echo "preview requested — a private link appears on the user's task page within ~30s"
`;

export const mergeRunScript = `#!/usr/bin/env bash
set -uo pipefail
cd /nc
echo "[nc] cloning $DEV_REPO"
git clone --quiet "https://x-access-token:\${GITHUB_TOKEN}@github.com/\${DEV_REPO}.git" repo \
  || { echo '{"error":"clone failed"}' > "$NC_RUN_DIR/result.json"; exit 1; }
cd repo
git config user.name "nc merge agent"
git config user.email "merge-agent@personalbase.invalid"
echo "[nc] checking out PR #$DEV_PR_NUMBER"
git fetch -q origin "pull/$DEV_PR_NUMBER/head:pr-branch" \
  || { echo '{"error":"PR fetch failed"}' > "$NC_RUN_DIR/result.json"; exit 1; }
git checkout -q pr-branch
echo "[nc] rebasing onto $DEV_TRUNK"
git rebase "origin/$DEV_TRUNK" \
  || { echo '{"error":"rebase conflict; resolve manually"}' > "$NC_RUN_DIR/result.json"; exit 1; }
echo "[nc] installing dependencies"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
mkdir -p /nc/bin
corepack enable --install-directory /nc/bin > /dev/null 2>&1 || true
export PATH="/nc/bin:$HOME/.local/bin:$PATH"
if ! command -v pnpm > /dev/null 2>&1; then
  echo "[nc] bootstrapping pnpm (slow the first time)"
  npm install -g pnpm --force > /dev/null 2>&1
fi
pnpm install --frozen-lockfile > "$NC_RUN_DIR/install.log" 2>&1 || pnpm install > "$NC_RUN_DIR/install.log" 2>&1 \
  || { tail -20 "$NC_RUN_DIR/install.log"; echo '{"error":"pnpm install failed"}' > "$NC_RUN_DIR/result.json"; exit 1; }
echo "[nc] typechecking the rebased PR"
pnpm typecheck \
  || { echo '{"error":"typecheck failed on rebased PR"}' > "$NC_RUN_DIR/result.json"; exit 1; }
echo "[nc] merging via GitHub API"
node "$NC_RUN_DIR/merge.mjs" || { echo '{"error":"merge failed"}' > "$NC_RUN_DIR/result.json"; exit 1; }
echo "[nc] deploying from merged trunk"
git checkout -q "$DEV_TRUNK" && git pull -q origin "$DEV_TRUNK"
curl -fsSL https://fly.io/install.sh 2>/dev/null | sh > /dev/null 2>&1
export FLYCTL_INSTALL="$HOME/.fly"
export PATH="$FLYCTL_INSTALL/bin:$PATH"
# The two deploys are independent — run them concurrently (each is a remote
# Docker build; the layer-cached Dockerfiles make unchanged-deps builds fast).
DEPLOYED=""
WORKER_PID=""
UI_PID=""
if [ -n "\${FLY_DEPLOY_TOKEN_WORKER:-}" ]; then
  echo "[nc] deploying personalbase-worker"
  FLY_API_TOKEN="$FLY_DEPLOY_TOKEN_WORKER" flyctl deploy -c fly.toml --remote-only \
    > "$NC_RUN_DIR/deploy-worker.log" 2>&1 &
  WORKER_PID=$!
fi
if [ -n "\${FLY_DEPLOY_TOKEN_UI:-}" ]; then
  echo "[nc] deploying personalbase-ui"
  FLY_API_TOKEN="$FLY_DEPLOY_TOKEN_UI" flyctl deploy -c fly.ui.toml --remote-only \
    > "$NC_RUN_DIR/deploy-ui.log" 2>&1 &
  UI_PID=$!
fi
if [ -n "$WORKER_PID" ]; then
  if wait "$WORKER_PID"; then DEPLOYED="$DEPLOYED personalbase-worker"; \
  else echo "[nc] worker deploy FAILED"; tail -5 "$NC_RUN_DIR/deploy-worker.log"; fi
fi
if [ -n "$UI_PID" ]; then
  if wait "$UI_PID"; then DEPLOYED="$DEPLOYED personalbase-ui"; \
  else echo "[nc] ui deploy FAILED"; tail -5 "$NC_RUN_DIR/deploy-ui.log"; fi
fi
NC_DEPLOYED="$DEPLOYED" node -e "
const { readFileSync, writeFileSync } = require('node:fs');
const merged = JSON.parse(readFileSync(process.env.NC_RUN_DIR + '/merged.json', 'utf8'));
writeFileSync(process.env.NC_RUN_DIR + '/result.json', JSON.stringify({
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
writeFileSync(process.env.NC_RUN_DIR + "/merged.json", JSON.stringify({ sha: data.sha }));
console.log("[nc] merged as", data.sha);
`;
