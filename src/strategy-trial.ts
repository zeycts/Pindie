import {
  strategyCandidateSemanticFingerprint,
  strategyRevisionSelectionFromCandidate,
  validateStrategyRevisionCandidateArtifact,
  type StrategyRevisionCandidate,
} from "./strategy-candidates.ts";
import {
  isStrategyRevisionSelector,
  type StrategyRevisionSelection,
  type StrategyRevisionSelector,
} from "./policy.ts";

export interface TrialPacket {
  readonly candidateId: string;
  readonly candidateFingerprint: string;
  readonly target: {
    readonly strategyId: string;
    readonly kind: "approach" | "modifier";
    readonly baseFingerprint: string;
  };
  readonly proposal: {
    readonly summary: string;
    readonly useWhen: readonly string[];
    readonly avoidWhen: readonly string[];
    readonly principles: readonly string[];
  };
  readonly hypothesis: string;
  readonly selector: StrategyRevisionSelector;
}

/** Build the bounded model-facing packet for one validated Candidate. */
export function buildTrialPacket(
  candidate: StrategyRevisionCandidate,
): TrialPacket {
  const validated = validateStrategyRevisionCandidateArtifact(candidate);
  const candidateFingerprint = strategyCandidateSemanticFingerprint(validated);
  // Establishing this conversion also makes the exact Harness-owned revision
  // selection available to the lease without using any model-authored fields.
  strategyRevisionSelectionFromCandidate(validated, "trial");
  return Object.freeze({
    candidateId: validated.candidateId,
    candidateFingerprint,
    target: Object.freeze({
      strategyId: validated.target.strategyId,
      kind: validated.target.kind,
      baseFingerprint: validated.target.baseFingerprint,
    }),
    proposal: Object.freeze({
      summary: validated.proposal.summary,
      useWhen: Object.freeze([...validated.proposal.useWhen]),
      avoidWhen: Object.freeze([...validated.proposal.avoidWhen]),
      principles: Object.freeze([...validated.proposal.principles]),
    }),
    hypothesis: validated.hypothesis,
    selector: Object.freeze({
      strategyId: validated.target.strategyId,
      revisionIdentity: validated.candidateId,
      revisionFingerprint: candidateFingerprint,
    }),
  });
}

/** Alias for callers that name the packet as a constructed artifact. */
export const createTrialPacket = buildTrialPacket;

function renderList(lines: string[], label: string, values: readonly string[]): void {
  lines.push(
    `${label}:`,
    ...(values.length > 0 ? values.map((value) => `  - ${value}`) : ["  - none"]),
  );
}

/** Render one bounded, advisory Candidate Trial Packet without I/O. */
export function formatTrialPacket(packet: TrialPacket): string {
  const lines = [
    "<PINDIE_TRIAL_PACKET>",
    "This is an explicitly requested Candidate Trial.",
    "This is not new user Task intent and does not start an Agent Run.",
    "The normal Pindie Task / Gateway / Verification authority is unchanged.",
    "",
    "Candidate:",
    `- ID: ${packet.candidateId}`,
    `- Derived semantic fingerprint: ${packet.candidateFingerprint}`,
    "",
    "Target Seed revision:",
    `- Strategy ID: ${packet.target.strategyId}`,
    `- Kind: ${packet.target.kind}`,
    `- Seed base fingerprint: ${packet.target.baseFingerprint}`,
    "",
    "Proposed semantics:",
    `- Summary: ${packet.proposal.summary}`,
  ];
  renderList(lines, "- Use when", packet.proposal.useWhen);
  renderList(lines, "- Avoid when", packet.proposal.avoidWhen);
  renderList(lines, "- Principles", packet.proposal.principles);
  lines.push(
    "",
    "Candidate hypothesis:",
    packet.hypothesis,
    "",
    "Controlled-Trial boundary:",
    "- This packet is advisory cognitive Policy for one explicitly requested Candidate Trial and one Agent Run only.",
    "- Candidate is a hypothesis, not proven better.",
    "- The model must explicitly declare the Candidate revision if it actually guides work.",
    "- Merely receiving this packet does NOT create Candidate attribution.",
    "- It is valid not to use the Candidate.",
    "- Task, Gateway, Verification, Human Gate, and completion authority remain normal Pindie authority.",
    "",
    "Exact Policy revision selector allowed for this Run:",
    `- Declare it under ${packet.target.kind === "approach" ? "approach" : "modifiers"} exactly as this object:`,
    JSON.stringify(packet.selector, null, 2),
    "- The Harness resolves this exact selector to the validated Candidate; do not add Candidate semantics or other revision data.",
    "</PINDIE_TRIAL_PACKET>",
  );
  return lines.join("\n");
}

export interface TrialLease {
  readonly sessionId: string;
  readonly candidate: StrategyRevisionCandidate;
  readonly candidateFingerprint: string;
  readonly revisionSelection: StrategyRevisionSelection;
  readonly renderedPacket: string;
  readonly agentRunGeneration: number | null;
}

/** Runtime-only pending/active Candidate Trial lease; nothing is persisted. */
export class TrialRuntime {
  private pending: TrialLease | null = null;
  private active: TrialLease | null = null;

  get hasTrial(): boolean {
    return this.pending !== null || this.active !== null;
  }

  get hasPendingTrial(): boolean {
    return this.pending !== null;
  }

  get hasActiveTrial(): boolean {
    return this.active !== null;
  }

  get pendingTrial(): TrialLease | null {
    return this.pending;
  }

  get activeTrial(): TrialLease | null {
    return this.active;
  }

  establish(
    sessionId: string,
    candidate: StrategyRevisionCandidate,
  ): boolean {
    if (sessionId.trim() === "" || this.hasTrial) return false;
    const validated = validateStrategyRevisionCandidateArtifact(candidate);
    const candidateFingerprint = strategyCandidateSemanticFingerprint(validated);
    const revisionSelection = strategyRevisionSelectionFromCandidate(validated, "trial");
    const packet = buildTrialPacket(validated);
    this.pending = Object.freeze({
      sessionId,
      candidate: validated,
      candidateFingerprint,
      revisionSelection,
      renderedPacket: formatTrialPacket(packet),
      agentRunGeneration: null,
    });
    return true;
  }

  bind(sessionId: string, agentRunGeneration: number): TrialLease | null {
    if (
      this.pending === null ||
      this.active !== null ||
      this.pending.sessionId !== sessionId ||
      !Number.isSafeInteger(agentRunGeneration) ||
      agentRunGeneration < 0
    ) return null;
    this.active = Object.freeze({
      ...this.pending,
      agentRunGeneration,
    });
    this.pending = null;
    return this.active;
  }

  isActiveForGeneration(agentRunGeneration: number | null): boolean {
    return this.active !== null &&
      agentRunGeneration !== null &&
      this.active.agentRunGeneration === agentRunGeneration;
  }

  activeFor(
    sessionId: string | null,
    agentRunGeneration: number | null,
  ): TrialLease | null {
    if (
      this.active === null ||
      sessionId === null ||
      agentRunGeneration === null ||
      this.active.sessionId !== sessionId ||
      this.active.agentRunGeneration !== agentRunGeneration
    ) return null;
    return this.active;
  }

  /** Resolve only the exact active Candidate selector; never fall back to Seed. */
  resolveRevisionSelector(
    sessionId: string | null,
    agentRunGeneration: number | null,
    selector: unknown,
    kind: "approach" | "modifier",
  ): StrategyRevisionSelection {
    const lease = this.activeFor(sessionId, agentRunGeneration);
    if (lease === null) {
      throw new Error("Candidate revision selector is unavailable without an active Candidate Trial for this Agent Run.");
    }
    if (!isStrategyRevisionSelector(selector)) {
      throw new Error("Candidate revision selector is malformed or not the exact selector from the active Trial Packet.");
    }
    if (lease.candidate.target.kind !== kind) {
      throw new Error(`Candidate revision selector has the wrong ${kind} role for the active Candidate.`);
    }
    if (
      selector.strategyId !== lease.candidate.target.strategyId ||
      selector.revisionIdentity !== lease.candidate.candidateId ||
      selector.revisionFingerprint !== lease.candidateFingerprint
    ) {
      throw new Error("Candidate revision selector does not match the active Candidate Trial.");
    }
    // This selection was derived when the lease was established. The model's
    // compact selector contributes identity only and never supplies semantics
    // or Run status.
    return lease.revisionSelection;
  }

  clear(): void {
    this.pending = null;
    this.active = null;
  }
}
