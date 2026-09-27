import { spawn } from "node:child_process";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const checks = [
  ["typecheck", ["run", "typecheck"]],
  ["tests", ["test"]],
];

let failed = false;

await Promise.all(checks.map(([name, args]) => new Promise((resolve) => {
  const child = spawn(pnpm, args, { stdio: "inherit" });
  child.on("error", (error) => {
    console.error(`${name} could not start:`, error);
    failed = true;
    resolve();
  });
  child.on("close", (code, signal) => {
    if (code !== 0) {
      console.error(`${name} failed${signal ? ` (signal ${signal})` : ` (exit ${code})`}`);
      failed = true;
    }
    resolve();
  });
})));

if (failed) process.exitCode = 1;
