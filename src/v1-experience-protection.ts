import type { ExactEvidenceRef } from "./learning-v1-contract.ts";
import { FileDiscoveryHypothesisStore } from "./discovery-hypotheses.ts";

/** Read-only, exact live source dependencies. No Task State or Experience schema changes. */
export interface V1ExperienceProtectionReader {
  requiredSourceRefs(projectId: string): Promise<readonly ExactEvidenceRef[]>;
}

/** Until a v1 Evaluation/Decision or evidence snapshot exists, every published hypothesis remains unresolved. */
export class FileV1HypothesisExperienceProtectionReader implements V1ExperienceProtectionReader {
  private readonly hypotheses: FileDiscoveryHypothesisStore;
  constructor(options: { projectsBaseDir?: string } = {}) {
    this.hypotheses = new FileDiscoveryHypothesisStore(options);
  }
  async requiredSourceRefs(projectId: string): Promise<readonly ExactEvidenceRef[]> {
    const hypotheses = await this.hypotheses.list(projectId); // full strict read or throw; never a partial projection
    const sources = hypotheses.flatMap((h) => h.sources);
    if (sources.some((ref) => ref.projectId !== projectId)) throw new Error("Cross-project v1 hypothesis source; pruning refused.");
    return sources;
  }
}
