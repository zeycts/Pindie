import type { StrategyRevisionCandidate } from "./strategy-candidates.ts";
import type { StrategyRevisionDecision } from "./strategy-decisions.ts";
import type { StrategyDerivationCandidateV1 } from "./strategy-derivation-candidates.ts";
import type { StrategyDerivationDecisionV1 } from "./strategy-derivation-decisions.ts";
import type { StrategyTrustScopeCandidateV1 } from "./strategy-trust-scope-candidates.ts";
import type { StrategyTrustScopeDecisionV1 } from "./strategy-trust-scope-decisions.ts";
import type { StrategySynthesisCandidateV1 } from "./strategy-synthesis-candidates.ts";
import type { StrategySynthesisDecisionV1 } from "./strategy-synthesis-decisions.ts";
import type { ProjectTrustedStrategyPortfolioReader } from "./strategy-trust-safety.ts";
import type { StrategyTrustScopeSourceResolver } from "./strategy-trust-scope-resolution.ts";
import type { StrategyCandidateReader, StrategyCandidateStore } from "./strategy-candidates.ts";
import type { StrategyRevisionDecisionReader, StrategyRevisionDecisionStore } from "./strategy-decisions.ts";
import type { StrategyDerivationCandidateReader, StrategyDerivationCandidateStore } from "./strategy-derivation-candidates.ts";
import type { StrategyDerivationDecisionReader, StrategyDerivationDecisionStore } from "./strategy-derivation-decisions.ts";
import type { StrategyTrustScopeCandidateStore } from "./strategy-trust-scope-candidates.ts";
import type { StrategyTrustScopeDecisionStore } from "./strategy-trust-scope-decisions.ts";
import type { StrategySynthesisCandidateReader, StrategySynthesisCandidateStore } from "./strategy-synthesis-candidates.ts";
import type { StrategySynthesisDecisionReader, StrategySynthesisDecisionStore } from "./strategy-synthesis-decisions.ts";

/** Artifact families remain distinct. This bundle is the Harness's persistence capability,
 * not a new Candidate schema or a second trust projection. */
export interface StrategyKnowledgeAccess {
  revisionCandidates: StrategyCandidateReader & StrategyCandidateStore;
  revisionDecisions: StrategyRevisionDecisionReader & StrategyRevisionDecisionStore;
  derivationCandidates: StrategyDerivationCandidateReader & StrategyDerivationCandidateStore;
  derivationDecisions: StrategyDerivationDecisionReader & StrategyDerivationDecisionStore;
  scopeCandidates: StrategyTrustScopeCandidateStore;
  scopeDecisions: StrategyTrustScopeDecisionStore;
  synthesisCandidates: StrategySynthesisCandidateReader;
  synthesisDecisions: StrategySynthesisDecisionReader;
  sourceResolver: StrategyTrustScopeSourceResolver;
  projectTrust: ProjectTrustedStrategyPortfolioReader;
}

/** Portable, exact immutable cognition. No Experience, runtime state or receipts. */
export interface StrategyKnowledgeSnapshotV1 {
  readonly schema: "pindie.strategy-knowledge";
  readonly version: 1;
  readonly projects: readonly {
    readonly projectId: string;
    readonly revisionCandidates: readonly StrategyRevisionCandidate[];
    readonly revisionDecisions: readonly StrategyRevisionDecision[];
    readonly derivationCandidates: readonly StrategyDerivationCandidateV1[];
    readonly derivationDecisions: readonly StrategyDerivationDecisionV1[];
  }[];
  readonly global: {
    readonly scopeCandidates: readonly StrategyTrustScopeCandidateV1[];
    readonly scopeDecisions: readonly StrategyTrustScopeDecisionV1[];
    readonly synthesisCandidates: readonly StrategySynthesisCandidateV1[];
    readonly synthesisDecisions: readonly StrategySynthesisDecisionV1[];
  };
}
