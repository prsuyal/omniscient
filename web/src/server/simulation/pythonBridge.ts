import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { env } from "~/env";

const resolveMaybeRelative = (value: string): string => {
  if (path.isAbsolute(value)) return value;
  return path.resolve(process.cwd(), value);
};

const pickPythonBinary = async (): Promise<string> => {
  const configured = resolveMaybeRelative(env.PYTHON_BIN);
  try {
    await access(configured);
    return configured;
  } catch {
    return "python3";
  }
};

const ensureMplConfigDir = async (): Promise<string> => {
  const dir = path.resolve(process.cwd(), ".mplconfig");
  await mkdir(dir, { recursive: true });
  return dir;
};

export const runPythonBridge = async <T = unknown>(payload: Record<string, unknown>): Promise<T> => {
  const pythonBin = await pickPythonBinary();
  const bridgePath = resolveMaybeRelative(env.PYTHON_BRIDGE_PATH);
  const mplConfigDir = await ensureMplConfigDir();
  const timeoutMs = env.PYTHON_BRIDGE_TIMEOUT_MS;

  return await new Promise<T>((resolve, reject) => {
    const child = spawn(pythonBin, [bridgePath], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: process.cwd(),
      env: {
        ...process.env,
        MPLCONFIGDIR: process.env.MPLCONFIGDIR ?? mplConfigDir,
      },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `Python bridge timed out after ${timeoutMs}ms. This request was aborted to avoid indefinite hangs.`,
        ),
      );
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`Python bridge failed with code ${code}. stderr=${stderr || "<empty>"}`));
        return;
      }

      if (!stdout.trim()) {
        reject(new Error(`Python bridge returned empty output. stderr=${stderr || "<empty>"}`));
        return;
      }

      try {
        const parsed = JSON.parse(stdout) as T;
        resolve(parsed);
      } catch (error) {
        reject(new Error(`Failed to parse python bridge JSON output: ${(error as Error).message}; raw=${stdout.slice(0, 400)}`));
      }
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
};
