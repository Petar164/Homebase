import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { VoiceCommand, VoiceEvent, VoiceTransport } from "./protocol.ts";

/** What the core holds for cloud models and for web search. The worker never calls either. */
const WITHHELD_FROM_WORKER = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "BRAVE_SEARCH_API_KEY", "TAVILY_API_KEY"];

/**
 * The environment the voice worker is started with: the core's own, without
 * the cloud key and the web search keys. The worker only hears and speaks, and speech libraries
 * from other projects run inside it, so it is not handed a secret it has
 * no use for. (Names are compared without regard to case, as Windows does.)
 */
export function workerEnv(env: NodeJS.ProcessEnv, modelsDir: string): NodeJS.ProcessEnv {
  const kept = Object.entries(env).filter(([name]) => !WITHHELD_FROM_WORKER.includes(name.toUpperCase()));
  return { ...Object.fromEntries(kept), HOMEBASE_MODELS_DIR: env.HOMEBASE_MODELS_DIR ?? modelsDir };
}

/**
 * The voice worker as a child process. It is a separate program on
 * purpose: audio drivers and speech models crash more than anything else
 * in this system, and when they do, only this child goes down. The core,
 * the data and the conversation carry on, and the worker is started again.
 */
export class ProcessTransport implements VoiceTransport {
  private readonly command: string[];
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private child: ChildProcess | null = null;
  private eventListener: (event: VoiceEvent) => void = () => {};
  private exitListener: () => void = () => {};

  constructor(options: { command: string[]; cwd: string; env?: NodeJS.ProcessEnv }) {
    this.command = options.command;
    this.cwd = options.cwd;
    this.env = options.env ?? process.env;
  }

  onEvent(listener: (event: VoiceEvent) => void): void {
    this.eventListener = listener;
  }

  onExit(listener: () => void): void {
    this.exitListener = listener;
  }

  start(): void {
    const [program, ...args] = this.command;
    if (!program) throw new Error("No command is set for the voice worker.");
    // The worker's log (standard error) is not copied into the core's log.
    // The worker promises to keep words out of it, but the speech libraries
    // it uses print on their own, and the core's log must stay free of
    // anything that was said.
    const child = spawn(program, args, { cwd: this.cwd, env: this.env, stdio: ["pipe", "pipe", "ignore"] });
    this.child = child;
    let exited = false;
    const exit = () => {
      if (exited) return;
      exited = true;
      if (this.child === child) this.child = null;
      this.exitListener();
    };
    child.once("error", exit); // the program could not be started at all
    child.once("exit", exit);
    child.stdin?.on("error", () => {}); // writing to a worker that just died must not crash the core

    if (child.stdout) {
      createInterface({ input: child.stdout }).on("line", (line) => {
        try {
          const event = JSON.parse(line) as VoiceEvent;
          if (event && typeof event === "object" && typeof event.type === "string") this.eventListener(event);
        } catch {
          // not a protocol line; ignored
        }
      });
    }
  }

  send(command: VoiceCommand): boolean {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) return false;
    stdin.write(`${JSON.stringify(command)}\n`);
    return true;
  }

  stop(): void {
    const child = this.child;
    if (!child) return;
    this.send({ type: "shutdown" });
    child.stdin?.end();
    // If it does not leave by itself, it is made to.
    setTimeout(() => child.exitCode === null && child.kill(), 2000).unref();
  }
}
