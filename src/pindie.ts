import { runPindieHost } from "./host.ts";

export async function main(): Promise<number> {
  try {
    await runPindieHost();
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`pindie: fatal: ${message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  const exitCode = await main();
  if (exitCode !== 0) process.exitCode = exitCode;
}
