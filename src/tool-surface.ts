import { classifyToolEffect } from "./execution-semantics.ts";
import type { PindieCapability } from "./semantics.ts";

export function deriveEffectiveToolNames(
  baselineToolNames: readonly string[],
  capabilities: ReadonlySet<PindieCapability>,
): string[] {
  return baselineToolNames.filter((toolName) =>
    capabilities.has(classifyToolEffect(toolName).requiredCapability)
  );
}
