import { createHash } from "node:crypto";
import { readFile, mkdir, open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { LearningSignal } from "./learning-signal.ts";
import type { SelfImprovementIntegration } from "./self-improvement-integration.ts";
import type { CrossProjectLearningIntegration } from "./cross-project-learning-integration.ts";
import { MAX_PROMOTED_DERIVED_STRATEGIES } from "./strategy-portfolio.ts";
import { MAX_USER_GLOBAL_DERIVED_STRATEGIES } from "./strategy-trust-scope-constants.ts";
import { FileGlobalWriterLock, getProjectId, type GlobalWriterLock } from "./store.ts";

/** Terminal receipts are operational metadata, never Strategy knowledge. Slice C reads only. */
export interface LearningAssessmentReceiptReader {
  hasTerminal(identity: string): Promise<boolean>;
  writeTerminal?(identity: string, outcome: "candidate-created" | "no-candidate"): Promise<void>;
}

const HASH = /^sha256:[0-9a-f]{64}$/;
export const MAX_LEARNING_ASSESSMENT_RECEIPTS = 128;

export class FileLearningAssessmentReceiptReader implements LearningAssessmentReceiptReader {
  private readonly globalBaseDir: string;
  private readonly writerLock: GlobalWriterLock;
  constructor(globalBaseDir: string, writerLock: GlobalWriterLock = new FileGlobalWriterLock({ baseDir: globalBaseDir })) {
    this.globalBaseDir = globalBaseDir;
    this.writerLock = writerLock;
  }

  private async readReceipts(): Promise<Array<{ identity: string; outcome: "candidate-created" | "no-candidate" }>> {
    let raw: string;
    try {
      raw = await readFile(join(this.globalBaseDir, "learning-assessment-receipts-v1.json"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (raw.length > 65536) throw new Error("Assessment receipts exceed the bounded read limit.");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length > MAX_LEARNING_ASSESSMENT_RECEIPTS) {
      throw new Error("Malformed assessment receipts.");
    }
    const seen = new Set<string>();
    for (const receipt of parsed) {
      if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt) ||
          Object.keys(receipt).sort().join("|") !== "identity|outcome") {
        throw new Error("Malformed assessment receipt.");
      }
      const item = receipt as { identity?: unknown; outcome?: unknown };
      if (typeof item.identity !== "string" || !HASH.test(item.identity) ||
          (item.outcome !== "candidate-created" && item.outcome !== "no-candidate") ||
          seen.has(item.identity)) throw new Error("Invalid or duplicate terminal assessment receipt.");
      seen.add(item.identity);
    }
    return parsed as Array<{ identity: string; outcome: "candidate-created" | "no-candidate" }>;
  }

  async hasTerminal(identity: string): Promise<boolean> {
    if (!HASH.test(identity)) throw new Error("Invalid assessment identity.");
    return (await this.readReceipts()).some((item) => item.identity === identity);
  }

  async writeTerminal(identity: string, outcome: "candidate-created" | "no-candidate"): Promise<void> {
    if (!HASH.test(identity) || (outcome !== "candidate-created" && outcome !== "no-candidate")) {
      throw new Error("Invalid terminal assessment receipt.");
    }
    await this.writerLock.withLock(async () => {
      await mkdir(this.globalBaseDir, { recursive: true });
      const file = join(this.globalBaseDir, "learning-assessment-receipts-v1.json");
      const temp = `${file}.${randomUUID()}.tmp`;
      const entries = await this.readReceipts();
      const existing = entries.find((entry) => entry.identity === identity);
      if (existing) {
        if (existing.outcome !== outcome) throw new Error("Conflicting terminal assessment receipt.");
        return;
      }
      const next = [...entries, { identity, outcome }].slice(-MAX_LEARNING_ASSESSMENT_RECEIPTS);
      try {
        const output = await open(temp, "wx", 0o600);
        try { await output.writeFile(JSON.stringify(next)); await output.sync(); }
        finally { await output.close(); }
        await rename(temp, file);
      } finally { await rm(temp, { force: true }); }
    });
  }
}

export type LearningOpportunityAssessment =
  | Readonly<{ status: "admitted"; identity: string }>
  | Readonly<{ status: "rejected"; reason: string }>;

function hash(parts: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
}

/** No lease, Candidate writer or Pi invocation occurs along this read-only path. */
export async function assessLearningOpportunity(input: {
  signal: LearningSignal;
  projectRoot: string;
  selfImprovement: SelfImprovementIntegration;
  crossProjectLearning: CrossProjectLearningIntegration | null;
  receipts: LearningAssessmentReceiptReader;
  isCurrent: () => boolean;
  now: () => number;
}): Promise<LearningOpportunityAssessment> {
  try {
    if (!input.isCurrent() || input.selfImprovement.hasConflictingLearningPath) {
      throw new Error("Source authority or learning lease is no longer coherent.");
    }
    const { signal, projectRoot, selfImprovement } = input;
    let identity: string;
    if (signal.intent === "revise-existing") {
      if (!signal.targetStrategyId) throw new Error("Seed target is required.");
      const { packet } = await selfImprovement.prepareAdaptationEvidence(projectRoot, signal.targetStrategyId);
      // Reconstruct current trusted portfolio even for Seed adaptation: trust corruption fails closed.
      const portfolio = await selfImprovement.prepareTrustedLearningPortfolio(projectRoot);
      identity = hash([signal.intent, getProjectId(projectRoot), packet.target,
        packet.evidence.runs, portfolio.fingerprint]);
    } else if (signal.intent === "derive-local") {
      const { portfolio, packet } = await selfImprovement.prepareDerivationEvidence(projectRoot);
      if (portfolio.resolvedEntries.some((entry) => entry.manifest.origin === "promoted-derived" && !entry.trust)) {
        throw new Error("Derived Strategy trust provenance is unavailable.");
      }
      if (portfolio.resolvedEntries.filter((entry) => entry.manifest.origin === "promoted-derived" && entry.trust?.origins.includes("project-local") === true).length >= MAX_PROMOTED_DERIVED_STRATEGIES) {
        throw new Error("Local Derived Strategy capacity is full.");
      }
      identity = hash([signal.intent, packet.projectId, packet.sourceRecordIds,
        packet.evidence.runs, portfolio.fingerprint]);
    } else {
      if (input.crossProjectLearning === null) throw new Error("Cross-Project Learning is disabled.");
      const packet = await input.crossProjectLearning.prepareGlobalDerivationEvidence(new Date(input.now()).toISOString());
      const portfolio = await selfImprovement.prepareTrustedLearningPortfolio(projectRoot);
      if (portfolio.resolvedEntries.some((entry) => entry.manifest.origin === "promoted-derived" && !entry.trust)) {
        throw new Error("Derived Strategy trust provenance is unavailable.");
      }
      const globalIds = new Set(portfolio.resolvedEntries.filter((entry) =>
        entry.manifest.origin === "promoted-derived" && entry.trust?.origins.includes("user-global") === true)
        .map((entry) => entry.manifest.strategyId));
      if (globalIds.size >= MAX_USER_GLOBAL_DERIVED_STRATEGIES) throw new Error("Global Derived Strategy capacity is full.");
      // Packet fingerprint includes capturedAt: omit that volatile timestamp from the assessment identity.
      identity = hash([signal.intent, packet.sourceRefs, packet.evidence.runs,
        packet.trustedStrategyComparison, packet.selection, portfolio.fingerprint]);
    }
    if (!input.isCurrent() || selfImprovement.hasConflictingLearningPath) {
      throw new Error("Source authority or learning lease changed while reading evidence.");
    }
    if (await input.receipts.hasTerminal(identity)) throw new Error("Exact assessment already settled.");
    if (!input.isCurrent()) throw new Error("Source authority changed while checking receipts.");
    return { status: "admitted", identity };
  } catch (error) {
    return { status: "rejected", reason: error instanceof Error ? error.message : "Learning evidence unavailable." };
  }
}
