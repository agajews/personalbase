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
}

export interface Sandbox {
  readonly name: string;
  /** Writes each file under /nc/, then starts `bash /nc/run.sh` detached. */
  start(
    files: Readonly<Record<string, string>>,
    env: Readonly<Record<string, string>>,
  ): Promise<void>;
  poll(cursor: number, maxBytes: number): Promise<SandboxPoll>;
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
      this.sprite = this.createOnFirstUse
        ? await spritesClient().createSprite(this.name, {
            config: {
              ramMB: 2048,
              cpus: 2,
              region: process.env["SPRITES_REGION"] ?? "sjc",
            },
          })
        : spritesClient().sprite(this.name);
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

  async start(
    files: Readonly<Record<string, string>>,
    env: Readonly<Record<string, string>>,
  ): Promise<void> {
    const sprite = await this.handle();
    const fs = sprite.filesystem("/nc");
    await fs.mkdir("/nc", { recursive: true });
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
    await this.exec(
      "cd /nc && ( [ -f launched ] || { touch launched; rm -f exit-code result.json; " +
        "touch run.log; setsid bash -c 'bash /nc/run.sh > /nc/run.log 2>&1; " +
        "echo $? > /nc/exit-code' < /dev/null > /dev/null 2>&1 & } ); echo launched",
      180_000,
      env,
    );
  }

  async poll(cursor: number, maxBytes: number): Promise<SandboxPoll> {
    const chunk = await this.exec(
      `tail -c +${cursor + 1} /nc/run.log 2>/dev/null | head -c ${maxBytes} | base64 -w0; true`,
      60_000,
    );
    const content = Buffer.from(chunk.trim(), "base64").toString("utf8");
    const exitRaw = (await this.exec("cat /nc/exit-code 2>/dev/null; true", 60_000)).trim();
    if (exitRaw === "") {
      return { content, exited: false, exitCode: null, result: null };
    }
    const resultRaw = (
      await this.exec("cat /nc/result.json 2>/dev/null; true", 60_000)
    ).trim();
    let result: unknown = null;
    if (resultRaw !== "") {
      try {
        result = JSON.parse(resultRaw);
      } catch {
        result = null;
      }
    }
    return { content, exited: true, exitCode: Number(exitRaw), result };
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
