import { spawn } from "node:child_process";

export interface VerificationResult {
  code: number | null;
  killed: boolean;
  signal?: NodeJS.Signals | null;
}

export interface VerificationOptions {
  cwd: string;
  timeout: number;
  signal: AbortSignal;
}

// shortcut: cleanup uses POSIX process groups; require tested Windows tree cleanup before enabling it there.
export const VERIFICATION_SUPPORTED = process.platform !== "win32";
const KILL_GRACE_MS = 250;

/** Pi 1.2.0 exec loses signal exits and cannot reliably escalate a resistant child. */
export function verifyCompletion(command: string, args: string[], options: VerificationOptions): Promise<VerificationResult> {
  if (!VERIFICATION_SUPPORTED) return Promise.reject(new Error("JEV verification currently requires POSIX process-group cleanup."));
  if (options.signal.aborted) return Promise.resolve({ code: null, killed: true, signal: null });
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, detached: true, stdio: "ignore" });
    let killed = false;
    let settled = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const signalGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
      }
    };
    const cancel = () => {
      if (settled || killed) return;
      killed = true;
      signalGroup("SIGTERM");
      escalation = setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS);
    };
    const timeout = setTimeout(cancel, options.timeout);
    const cleanup = () => {
      settled = true;
      clearTimeout(timeout);
      clearTimeout(escalation);
      options.signal.removeEventListener("abort", cancel);
      // A verifier must not leave children behind after its leader exits.
      signalGroup("SIGKILL");
    };
    child.once("error", () => {
      cleanup();
      reject(new Error("Verifier could not start; inspect the fixed command locally."));
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      cleanup();
      resolve({ code, signal, killed });
    });
    options.signal.addEventListener("abort", cancel, { once: true });
    if (options.signal.aborted) cancel();
  });
}
