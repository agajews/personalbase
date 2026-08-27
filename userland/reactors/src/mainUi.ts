import { SpritesClient, type Sprite } from "@fly/sprites";
import { z } from "zod";
import type { Sql } from "@nc/log";
import { enqueueJob, type Reactor, type ReactorEvent } from "@nc/process";

// Hosts the main UI on a long-lived sprite so access rides Fly's org SSO —
// the same browser sign-in the dev-preview URLs use. This is the ONLY remote
// door to the UI: nothing binds a public port (see CLAUDE.md). The daemon
// polls trunk's sha every ~10s via enqueueMainUiIfTrunkMoved (a pure GitHub
// API read; no job/run rows unless trunk actually moved) and enqueues this
// reactor to resync/rebuild/replace the service. Enqueue manually with
// {force: true} to redeploy without a new commit (e.g. after service-def
// changes). Deliberately self-contained (SpritesClient directly) rather than
// extending the dev-agent Sandbox interface: this is a deployment target,
// not an agent sandbox, and the devagents module is under active refactor by
// the other session.

const sandboxName = "nc-main-ui";
const serviceName = "main-ui";

export const mainUiJobPayload = z.object({ force: z.boolean().optional() });

const mainUiState = z.object({ deployedSha: z.string() });

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set`);
  }
  return value;
}

async function exec(
  sprite: Sprite,
  command: string,
  timeoutMs: number,
  env?: Readonly<Record<string, string>>,
): Promise<string> {
  const { stdout } = await sprite.execFile("bash", ["-c", command], {
    timeout: timeoutMs,
    ...(env === undefined ? {} : { env: { ...env } }),
  });
  return String(stdout);
}

// Sync-or-clone the repo at trunk and build the UI bundle. GITHUB_TOKEN and
// branch names travel as env, never shell-interpolated.
const syncScript = `set -e
export PATH="/nc/bin:$HOME/.local/bin:$PATH"
mkdir -p /nc/bin
corepack enable --install-directory /nc/bin
if [ ! -d /nc/repo-main/.git ]; then
  git clone --quiet "https://x-access-token:\${GITHUB_TOKEN}@github.com/\${DEV_REPO}.git" /nc/repo-main
fi
cd /nc/repo-main
git fetch -q origin "$DEV_TRUNK"
git checkout -q "$DEV_TRUNK" 2>/dev/null || git checkout -qb "$DEV_TRUNK" "origin/$DEV_TRUNK"
git reset --hard -q "origin/$DEV_TRUNK"
pnpm install --frozen-lockfile > /nc/main-install.log 2>&1 || pnpm install > /nc/main-install.log 2>&1
pnpm --filter @nc/ui exec vite build > /nc/main-build.log 2>&1
git rev-parse HEAD
`;

/** Trunk's current sha, resolved without touching the sprite. */
async function trunkSha(repo: string, trunk: string, githubToken: string): Promise<string> {
  const response = await fetch(
    `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(trunk)}`,
    {
      headers: {
        authorization: `Bearer ${githubToken}`,
        accept: "application/vnd.github.sha",
      },
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub sha lookup failed: ${response.status}`);
  }
  return (await response.text()).trim();
}

/**
 * The daemon's 10s trigger: one GitHub API call compares trunk's sha with
 * the reactor's deployed-sha state and enqueues a resync job only on change.
 * Skips while a main-ui job is pending/running, and backs off for 10 minutes
 * after a failed run so a broken build can't hot-loop sprite execs.
 */
export async function enqueueMainUiIfTrunkMoved(sql: Sql): Promise<boolean> {
  const githubToken = required("GITHUB_TOKEN");
  const repo = process.env["DEV_REPO"] ?? "agajews/personalbase";
  const trunk = process.env["DEV_TRUNK"] ?? "main";
  const wantSha = await trunkSha(repo, trunk, githubToken);
  const stateRows = await sql`
    select state from process_state where process = 'reactor:main-ui'`;
  const state = mainUiState.safeParse(stateRows[0]?.["state"]);
  if (state.success && state.data.deployedSha === wantSha) {
    return false;
  }
  const blocked = await sql`
    select 1 from jobs
    where process = 'reactor:main-ui' and status in ('pending', 'running')
    union all
    select 1 from runs
    where process = 'reactor:main-ui' and status = 'failed'
      and started_at > now() - interval '10 minutes'
      and started_at = (select max(started_at) from runs where process = 'reactor:main-ui')
    limit 1`;
  if (blocked.length > 0) {
    return false;
  }
  await enqueueJob(sql, "reactor:main-ui", {});
  console.log(`main-ui: trunk moved to ${wantSha.slice(0, 8)}, resync enqueued`);
  return true;
}

export const mainUiReactor: Reactor = {
  kind: "reactor",
  name: "main-ui",
  trigger: { kind: "manual" },
  async run(ctx, input): Promise<ReactorEvent[]> {
    if (input.kind !== "job") {
      throw new Error("main-ui only supports job triggers");
    }
    const payload = mainUiJobPayload.parse(input.payload);
    const spritesToken = required("SPRITES_TOKEN");
    const githubToken = required("GITHUB_TOKEN");
    const databaseUrl = required("DATABASE_URL");
    const anthropicApiKey = process.env["ANTHROPIC_API_KEY"]?.trim() || undefined;
    const repo = process.env["DEV_REPO"] ?? "agajews/personalbase";
    const trunk = process.env["DEV_TRUNK"] ?? "main";
    const wantSha = await trunkSha(repo, trunk, githubToken);
    const state = mainUiState.safeParse(await ctx.getState());
    if (payload.force !== true && state.success && state.data.deployedSha === wantSha) {
      console.log(`main-ui already at ${trunk}@${wantSha.slice(0, 8)}`);
      return [];
    }
    const client = new SpritesClient(spritesToken);
    let sprite: Sprite;
    try {
      sprite = await client.getSprite(sandboxName);
    } catch {
      sprite = await client.createSprite(sandboxName, {
        config: { ramMB: 2048, cpus: 2, region: process.env["SPRITES_REGION"] ?? "sjc" },
      });
    }
    const sha = (
      await exec(sprite, syncScript, 600_000, {
        GITHUB_TOKEN: githubToken,
        DEV_REPO: repo,
        DEV_TRUNK: trunk,
      })
    ).trim();
    console.log(`main-ui synced to ${trunk}@${sha}`);
    // Replace-on-register: the service restarts on the fresh checkout, and a
    // stale definition can't crashloop behind the URL.
    const services = await sprite.listServices();
    if (services.some((s) => s.name === serviceName)) {
      await sprite.deleteService(serviceName);
    }
    await sprite.createService(serviceName, {
      cmd: "bash",
      // PREPEND to the base PATH — it carries /.sprite/bin (node itself).
      args: ["-c", 'export PATH="/nc/bin:$HOME/.local/bin:$PATH"; pnpm exec tsx apps/ui/src/server.ts'],
      dir: "/nc/repo-main",
      env: {
        DATABASE_URL: databaseUrl,
        // Transport auth is the sprite's SSO-gated URL; the in-app password
        // gate stands down (see NC_TRUSTED_TRANSPORT in apps/ui/src/server.ts).
        NC_TRUSTED_TRANSPORT: "1",
        HOST: "0.0.0.0",
        PORT: "4680",
        // The operator chat calls Anthropic from the UI server. Optional so
        // a keyless worker can still deploy the UI (chat degrades, not the
        // whole app).
        ...(anthropicApiKey === undefined ? {} : { ANTHROPIC_API_KEY: anthropicApiKey }),
      },
      // What the sprite's HTTPS URL proxies to.
      httpPort: 4680,
    });
    const url = (await client.getSprite(sandboxName)).url ?? "(url pending)";
    console.log(`main-ui service registered: ${url}`);
    await ctx.setState({ deployedSha: sha });
    return [];
  },
};
