import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { OpenROADManager } from "../core/manager.js";
import type { InteractiveSessionInfo } from "../core/models.js";
import { DockerPullResult } from "../core/models.js";
import { getSettings } from "../config/settings.js";
import { BaseTool } from "./base.js";

// Kept in sync with the ORFS_VERSION pinned in the repo's Makefile / Dockerfile
// (the upstream openroad/orfs base image, not this project's own
// ghcr.io/the-openroad-project/openroad-mcp image).
export const DEFAULT_ORFS_IMAGE = "openroad/orfs:26Q1-534-g510137693";

const DEFAULT_CONTAINER_FLOW_PATH = "/OpenROAD-flow-scripts/flow";
const DEFAULT_CONTAINER_COMMAND = ["openroad", "-no_init"];

// Registry/repo/tag characters only - rejects shell metacharacters and
// whitespace before the value ever reaches a spawned argv.
const IMAGE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*(:[A-Za-z0-9._-]+)?$/;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Bounds memory for long-running `docker pull` output; keeps the tail, which
// is what matters for diagnosing a failed or slow pull.
const MAX_OUTPUT_CHARS = 32 * 1024;

function appendBounded(current: string, chunk: string): string {
  return (current + chunk).slice(-MAX_OUTPUT_CHARS);
}

/** One-shot `docker pull <image>`. Not session-based - runs via child_process, not the PTY manager. */
export class PullOrfsImageTool extends BaseTool {
  constructor(manager: OpenROADManager) {
    super(manager);
  }

  async execute(image?: string, timeoutMs?: number): Promise<string> {
    const targetImage = image ?? DEFAULT_ORFS_IMAGE;

    if (!IMAGE_REF_PATTERN.test(targetImage)) {
      return this.formatResult(
        DockerPullResult.parse({
          image: targetImage,
          pulled: false,
          error: `Invalid image reference: ${JSON.stringify(targetImage)}`,
        }) as unknown as Record<string, unknown>,
      );
    }

    const timeout = timeoutMs && timeoutMs > 0 ? timeoutMs : getSettings().DOCKER_PULL_TIMEOUT_MS;
    const startedAt = Date.now();

    return new Promise<string>((resolve) => {
      let child;
      try {
        child = spawn("docker", ["pull", targetImage]);
      } catch (e) {
        resolve(
          this.formatResult(
            DockerPullResult.parse({
              image: targetImage,
              pulled: false,
              error: `Failed to spawn docker: ${(e as Error).message ?? String(e)}`,
            }) as unknown as Record<string, unknown>,
          ),
        );
        return;
      }

      let output = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        resolve(
          this.formatResult(
            DockerPullResult.parse({
              image: targetImage,
              pulled: false,
              durationSeconds: (Date.now() - startedAt) / 1000,
              output,
              error: `Timed out after ${timeout}ms pulling ${targetImage}`,
            }) as unknown as Record<string, unknown>,
          ),
        );
      }, timeout);

      child.stdout?.on("data", (chunk: Buffer) => {
        output = appendBounded(output, chunk.toString("utf8"));
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        output = appendBounded(output, chunk.toString("utf8"));
      });

      child.on("error", (e: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const message =
          e.code === "ENOENT"
            ? "Docker CLI not found on PATH. Install Docker Desktop / Docker Engine."
            : `Failed to run docker pull: ${e.message}`;
        resolve(
          this.formatResult(
            DockerPullResult.parse({
              image: targetImage,
              pulled: false,
              durationSeconds: (Date.now() - startedAt) / 1000,
              output,
              error: message,
            }) as unknown as Record<string, unknown>,
          ),
        );
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(
          this.formatResult(
            DockerPullResult.parse({
              image: targetImage,
              pulled: code === 0,
              durationSeconds: (Date.now() - startedAt) / 1000,
              output,
              error: code === 0 ? null : `docker pull exited with code ${code ?? "unknown"}`,
            }) as unknown as Record<string, unknown>,
          ),
        );
      });
    });
  }
}

function sessionErrorResult(sessionId: string | undefined, message: string): InteractiveSessionInfo {
  return {
    sessionId: sessionId ?? "unknown",
    createdAt: new Date().toISOString(),
    isAlive: false,
    commandCount: 0,
    bufferSize: 0,
    uptimeSeconds: null,
    state: null,
    error: message,
  };
}

/**
 * Convenience wrapper around create_interactive_session: builds a vetted
 * `docker run` argv from structured parameters instead of requiring the
 * caller to hand-assemble one, then hands it to the same
 * OpenROADManager/PtyHandler session machinery every other session uses.
 */
export class CreateDockerOrfsSessionTool extends BaseTool {
  constructor(manager: OpenROADManager) {
    super(manager);
  }

  async execute(
    sessionId?: string,
    image?: string,
    flowDir?: string,
    containerFlowPath?: string,
    command?: string[],
    env?: Record<string, string>,
    network?: boolean,
  ): Promise<string> {
    const targetImage = image ?? DEFAULT_ORFS_IMAGE;
    if (!IMAGE_REF_PATTERN.test(targetImage)) {
      return this.formatResult(
        sessionErrorResult(
          sessionId,
          `Invalid image reference: ${JSON.stringify(targetImage)}`,
        ) as unknown as Record<string, unknown>,
      );
    }

    const resolvedFlowDir = flowDir ?? getSettings().flowPath;
    if (!path.isAbsolute(resolvedFlowDir)) {
      return this.formatResult(
        sessionErrorResult(
          sessionId,
          `flow_dir must be an absolute path, got: ${JSON.stringify(resolvedFlowDir)}`,
        ) as unknown as Record<string, unknown>,
      );
    }
    let stat;
    try {
      stat = fs.statSync(resolvedFlowDir);
    } catch {
      return this.formatResult(
        sessionErrorResult(
          sessionId,
          `flow_dir does not exist: ${resolvedFlowDir}`,
        ) as unknown as Record<string, unknown>,
      );
    }
    if (!stat.isDirectory()) {
      return this.formatResult(
        sessionErrorResult(
          sessionId,
          `flow_dir is not a directory: ${resolvedFlowDir}`,
        ) as unknown as Record<string, unknown>,
      );
    }

    if (env) {
      for (const key of Object.keys(env)) {
        if (!ENV_KEY_PATTERN.test(key)) {
          return this.formatResult(
            sessionErrorResult(
              sessionId,
              `Invalid environment variable name: ${JSON.stringify(key)}`,
            ) as unknown as Record<string, unknown>,
          );
        }
      }
    }

    const targetContainerFlowPath = containerFlowPath ?? DEFAULT_CONTAINER_FLOW_PATH;
    const envArgs = Object.entries(env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    const networkArgs = network === true ? [] : ["--network", "none"];

    const argv = [
      "docker",
      "run",
      "--rm",
      "-i",
      "-v",
      `${resolvedFlowDir}:${targetContainerFlowPath}`,
      ...networkArgs,
      ...envArgs,
      targetImage,
      ...(command ?? DEFAULT_CONTAINER_COMMAND),
    ];

    try {
      const opts = { ...(sessionId !== undefined && { sessionId }), command: argv };
      const id = await this.manager.createSession(opts);
      const info = await this.manager.getSessionInfo(id);
      return this.formatResult(info as unknown as Record<string, unknown>);
    } catch (e) {
      return this.formatResult(
        sessionErrorResult(sessionId, String(e)) as unknown as Record<string, unknown>,
      );
    }
  }
}
