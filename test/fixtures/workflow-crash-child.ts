import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

const [path, checkpoint, timestamp] = process.argv.slice(2);
if (!path || !checkpoint || !timestamp) throw new Error("Missing crash fixture arguments");
const pause = () => {
  fs.writeSync(1, `${JSON.stringify({ checkpoint, pid: process.pid })}\n`);
  // Keep the real process/lock alive until the parent has observed and killed it.
  // A bounded wait prevents an abandoned fixture from hanging indefinitely.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
  throw new Error("Crash checkpoint was not killed within its fixture budget");
};
const link = fs.linkSync;
const rename = fs.renameSync;
fs.linkSync = (source, target) => {
  link(source, target);
  if (checkpoint === "owner" && String(target).startsWith(join(`${path}.lock`, "owner-"))) pause();
};
fs.renameSync = (source, target) => {
  rename(source, target);
  if ((checkpoint === "previous" && String(target) === `${path}.prev`) || (checkpoint === "current" && String(target) === path)) pause();
};
syncBuiltinESMExports();
Date.now = () => Number(timestamp);
const { LoopStore } = await import("../../src/store.js");
const store = new LoopStore(path);
store.claimWorkflowExecution("1", { sessionId: "killed-child-session", runtimeId: "child-owner" }, 60);
throw new Error("Requested persistence checkpoint was not reached");
