import { SpritesClient, type Sprite } from "@fly/sprites";

/**
 * A cloud sandbox running one detached dev-agent script. The script writes
 * its output to /nc/run.log, its exit status to /nc/exit-code, and its
 * machine-readable outcome to /nc/result.json; poll() reads all three so the
 * reactor watching the sandbox never holds a connection open.
 */
export interface SandboxPoll {
  /** New log bytes from `cursor`, at most `maxBytes` (utf8-decoded). */
  readonly content: string;
  readonly exited: boolean;
  readonly exitCode: number | null;
  /** Parsed /nc/result.json, when the script has exited and wrote one. */
  readonly result: unknown;
  /** True once the agent has started a dev-server preview (/nc/preview.json). */
  readonly previewRunning: boolean;
}

export interface Sandbox {
  readonly name: string;
  /**
   * Writes each file under `runDir`, then starts `bash <runDir>/run.sh`
   * detached with NC_RUN_DIR set. One sandbox hosts many runs (conversation
   * turns share the workspace); each run gets its own directory.
   */
  start(
    runDir: string,
    files: Readonly<Record<string, string>>,
    env: Readonly<Record<string, string>>,
  ): Promise<void>;
  poll(runDir: string, cursor: number, maxBytes: number): Promise<SandboxPoll>;
  /**
   * Stops a run mid-turn (kills its process group) and marks it exited with
   * an interrupted result, so the poll chain closes it out gracefully.
   * Idempotent; a no-op if the run already exited.
   */
  interrupt(runDir: string): Promise<void>;
  /** The sandbox's SSO-gated HTTPS URL (null until known). */
  url(): Promise<string | null>;
  /**
   * Registers the preview as supervised sandbox services (API on loopback,
   * vite with httpPort so the sandbox URL proxies to it). Idempotent.
   */
  startPreview(previewDatabaseUrl: string): Promise<void>;
  destroy(): Promise<void>;
}

export interface SandboxProvider {
  create(name: string): Promise<Sandbox>;
  /** Reattaches to an existing sandbox by name (poll jobs across restarts). */
  open(name: string): Sandbox;
}

let client: SpritesClient | undefined;

function spritesClient(): SpritesClient {
  const token = process.env["SPRITES_TOKEN"]?.trim();
  if (token === undefined || token === "") {
    throw new Error("SPRITES_TOKEN is not set");
  }
  // The API token is the full CLI-style string: org-slug/org-id/token-id/value.
  client ??= new SpritesClient(token);
  return client;
}

class SpriteSandbox implements Sandbox {
  private sprite: Sprite | undefined;

  constructor(
    readonly name: string,
    private readonly createOnFirstUse: boolean,
  ) {}

  private async handle(): Promise<Sprite> {
    if (this.sprite === undefined) {
      if (this.createOnFirstUse) {
        // Get-or-create: createSprite errors on an existing name, and
        // conversation turns deliberately reuse the task's sandbox.
        try {
          this.sprite = await spritesClient().getSprite(this.name);
        } catch {
          this.sprite = await spritesClient().createSprite(this.name, {
            config: {
              ramMB: 2048,
              cpus: 2,
              region: process.env["SPRITES_REGION"] ?? "sjc",
            },
          });
        }
      } else {
        this.sprite = spritesClient().sprite(this.name);
      }
    }
    return this.sprite;
  }

  // The SDK's exec() runs the binary directly, no shell — pipes, redirects,
  // and `cd` need an explicit bash -c.
  private async exec(
    command: string,
    timeoutMs: number,
    env?: Readonly<Record<string, string>>,
  ): Promise<string> {
    const sprite = await this.handle();
    const { stdout } = await sprite.execFile("bash", ["-c", command], {
      timeout: timeoutMs,
      ...(env === undefined ? {} : { env: { ...env } }),
    });
    return String(stdout);
  }

  private static checkRunDir(runDir: string): void {
    if (!/^\/nc\/[a-zA-Z0-9._/-]+$/.test(runDir)) {
      throw new Error(`unsafe sandbox run dir: ${runDir}`);
    }
  }

  async start(
    runDir: string,
    files: Readonly<Record<string, string>>,
    env: Readonly<Record<string, string>>,
  ): Promise<void> {
    SpriteSandbox.checkRunDir(runDir);
    const sprite = await this.handle();
    const fs = sprite.filesystem(runDir);
    await fs.mkdir(runDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
        throw new Error(`unsafe sandbox file name: ${name}`);
      }
      await fs.writeFile(name, content);
    }
    // setsid detaches the run from this exec's session so it survives the
    // connection closing; the run inherits env from this exec. The `launched`
    // guard makes this idempotent: a retried start (e.g. after a cold-start
    // timeout on a launch that actually went through) can't run the script
    // twice. Generous timeout — the first exec on a fresh sprite can be slow.
    // The setsid child is its own process-group leader; its pid is recorded
    // so interrupt() can kill the whole turn's process tree.
    await this.exec(
      `cd ${runDir} && ( [ -f launched ] || { touch launched; ` +
        `setsid bash -c 'bash ${runDir}/run.sh > ${runDir}/run.log 2>&1; ` +
        `echo $? > ${runDir}/exit-code' < /dev/null > /dev/null 2>&1 & ` +
        `echo $! > ${runDir}/leader.pid; } ); echo launched`,
      180_000,
      { ...env, NC_RUN_DIR: runDir },
    );
  }

  async interrupt(runDir: string): Promise<void> {
    SpriteSandbox.checkRunDir(runDir);
    await this.exec(
      `cd ${runDir} && if [ ! -f exit-code ] && [ -f leader.pid ]; then ` +
        `kill -9 -- -$(cat leader.pid) 2>/dev/null; ` +
        `echo '{"interrupted":true}' > result.json; echo 130 > exit-code; ` +
        `echo '[nc] turn interrupted by the user' >> run.log; fi; echo done`,
      60_000,
    );
  }

  async poll(runDir: string, cursor: number, maxBytes: number): Promise<SandboxPoll> {
    SpriteSandbox.checkRunDir(runDir);
    const chunk = await this.exec(
      `tail -c +${cursor + 1} ${runDir}/run.log 2>/dev/null | head -c ${maxBytes} | base64 -w0; true`,
      60_000,
    );
    const content = Buffer.from(chunk.trim(), "base64").toString("utf8");
    // exit-code and the preview marker piggyback on one round trip.
    const state = (
      await this.exec(
        `echo "exit=$(cat ${runDir}/exit-code 2>/dev/null)"; ` +
          `echo "preview=$([ -f /nc/preview.json ] && echo 1)"; true`,
        60_000,
      )
    ).trim();
    const exitRaw = /exit=(\S*)/.exec(state)?.[1] ?? "";
    const previewRunning = /preview=1/.test(state);
    if (exitRaw === "") {
      return { content, exited: false, exitCode: null, result: null, previewRunning };
    }
    const resultRaw = (
      await this.exec(`cat ${runDir}/result.json 2>/dev/null; true`, 60_000)
    ).trim();
    let result: unknown = null;
    if (resultRaw !== "") {
      try {
        result = JSON.parse(resultRaw);
      } catch {
        result = null;
      }
    }
    return { content, exited: true, exitCode: Number(exitRaw), result, previewRunning };
  }

  async url(): Promise<string | null> {
    const fetched = await spritesClient().getSprite(this.name);
    return fetched.url ?? null;
  }

  async startPreview(previewDatabaseUrl: string): Promise<void> {
    const sprite = await this.handle();
    const services = await sprite.listServices();
    const have = new Set(services.map((s) => s.name));
    // PREPEND to the service's base PATH rather than replacing it — the base
    // carries /.sprite/bin (node itself); overriding it leaves pnpm with no
    // node to run on.
    const withPath = (cmd: string) =>
      `export PATH="/nc/bin:$HOME/.local/bin:$PATH"; ${cmd}`;
    if (!have.has("preview-api")) {
      await sprite.createService("preview-api", {
        cmd: "bash",
        args: ["-c", withPath("pnpm exec tsx apps/ui/src/server.ts")],
        dir: "/nc/repo",
        env: {
          DATABASE_URL: previewDatabaseUrl,
          NC_PREVIEW: "1",
          HOST: "127.0.0.1",
          PORT: "4680",
        },
      });
    }
    if (!have.has("preview-vite")) {
      await sprite.createService("preview-vite", {
        cmd: "bash",
        args: ["-c", withPath("pnpm --filter @nc/ui exec vite --host 0.0.0.0 --port 5173")],
        dir: "/nc/repo",
        needs: ["preview-api"],
        // This is what the sandbox's HTTPS URL proxies to.
        httpPort: 5173,
      });
    }
  }

  async destroy(): Promise<void> {
    await spritesClient().deleteSprite(this.name);
  }
}

export const spritesProvider: SandboxProvider = {
  async create(name: string): Promise<Sandbox> {
    const sandbox = new SpriteSandbox(name, true);
    return sandbox;
  },
  open(name: string): Sandbox {
    return new SpriteSandbox(name, false);
  },
};
