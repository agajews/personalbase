import { SpritesClient, type Sprite } from "@fly/sprites";
import { z } from "zod";
import type { Reactor, ReactorEvent } from "@nc/process";

// Hosts the main UI on a long-lived sprite so access rides Fly's org SSO —
// the same browser sign-in the dev-preview URLs use — instead of a copied
// password. Manual job: enqueue `reactor:main-ui` (payload {}) to (re)sync
// the sprite to trunk, rebuild, and (re)register the service; rerun after
// landing UI changes. Deliberately self-contained (SpritesClient directly)
// rather than extending the dev-agent Sandbox interface: this is a
// deployment target, not an agent sandbox, and the devagents module is under
// active refactor by the other session.

const sandboxName = "nc-main-ui";
const serviceName = "main-ui";

export const mainUiJobPayload = z.object({});

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
corepack enable --install-directory /nc/bin > /dev/null 2>&1 || true
if [ ! -d /nc/repo-main/.git ]; then
  git clone --quiet "https://x-access-token:\${GITHUB_TOKEN}@github.com/\${DEV_REPO}.git" /nc/repo-main
fi
cd /nc/repo-main
git fetch -q origin "$DEV_TRUNK"
git checkout -q "$DEV_TRUNK" 2>/dev/null || git checkout -qb "$DEV_TRUNK" "origin/$DEV_TRUNK"
git reset --hard -q "origin/$DEV_TRUNK"
pnpm install --frozen-lockfile > /nc/main-install.log 2>&1 || pnpm install > /nc/main-install.log 2>&1
pnpm --filter @nc/ui exec vite build > /nc/main-build.log 2>&1
git rev-parse --short HEAD
`;

export const mainUiReactor: Reactor = {
  kind: "reactor",
  name: "main-ui",
  trigger: { kind: "manual" },
  async run(_ctx, input): Promise<ReactorEvent[]> {
    if (input.kind !== "job") {
      throw new Error("main-ui only supports job triggers");
    }
    mainUiJobPayload.parse(input.payload);
    const spritesToken = required("SPRITES_TOKEN");
    const githubToken = required("GITHUB_TOKEN");
    const databaseUrl = required("DATABASE_URL");
    const repo = process.env["DEV_REPO"] ?? "agajews/personalbase";
    const trunk = process.env["DEV_TRUNK"] ?? "main";
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
      },
      // What the sprite's HTTPS URL proxies to.
      httpPort: 4680,
    });
    const url = (await client.getSprite(sandboxName)).url ?? "(url pending)";
    console.log(`main-ui service registered: ${url}`);
    return [];
  },
};
