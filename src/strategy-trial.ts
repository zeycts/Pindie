import {
  strategyCandidateSemanticFingerprint,
  strategyRevisionSelectionFromCandidate,
  validateStrategyRevisionCandidateArtifact,
  type StrategyRevisionCandidate,
} from "./strategy-candidates.ts";
import {
  createStrategyRevisionSelection,
  isStrategyRevisionSelector,
  type StrategyRevisionSelection,
  type StrategyRevisionSelector,
} from "./policy.ts";
import {
  strategyDerivationCandidateSemanticFingerprint,
  validateStrategyDerivationCandidateArtifact,
  type StrategyDerivationCandidateV1,
} from "./strategy-derivation-candidates.ts";

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

export interface DerivationTrialPacket {
  readonly candidateType: "strategy-derivation";
  readonly candidateId: string;
  readonly candidateFingerprint: string;
  readonly projectId: string;
  readonly basePortfolioFingerprint: string;
  readonly proposal: {
    readonly strategyId: string;
    readonly kind: "approach" | "modifier";
    readonly summary: string;
    readonly useWhen: readonly string[];
    readonly avoidWhen: readonly string[];
    readonly principles: readonly string[];
  };
  readonly provenance: {
    readonly sourceRecordCount: number;
  };
  readonly hypothesis: string;
  readonly selector: StrategyRevisionSelector;
  readonly trustBoundary: string;
}

/** Convert one validated Derivation Candidate into its exact Trial Policy. */
export function strategyRevisionSelectionFromDerivationCandidate(
  candidate: StrategyDerivationCandidateV1,
): StrategyRevisionSelection {
  const validated = validateStrategyDerivationCandidateArtifact(
    candidate,
    candidate.candidateId,
  );
  const fingerprint = strategyDerivationCandidateSemanticFingerprint(validated);
  return createStrategyRevisionSelection({
    strategyId: validated.proposal.strategyId,
    kind: validated.proposal.kind,
    revisionIdentity: validated.candidateId,
    revisionFingerprint: fingerprint,
    revisionStatusAtRun: "trial",
    semantics: {
      summary: validated.proposal.summary,
      useWhen: [...validated.proposal.useWhen],
      avoidWhen: [...validated.proposal.avoidWhen],
      principles: [...validated.proposal.principles],
    },
  });
}

/** Build the bounded model-facing packet for an explicit Derivation Trial. */
export function buildDerivationTrialPacket(
  candidate: StrategyDerivationCandidateV1,
): DerivationTrialPacket {
  const validated = validateStrategyDerivationCandidateArtifact(
    candidate,
    candidate.candidateId,
  );
  const candidateFingerprint = strategyDerivationCandidateSemanticFingerprint(validated);
  // Constructing the selection here proves that the exact candidate semantics
  // can be represented, without activating the Candidate outside a lease.
  strategyRevisionSelectionFromDerivationCandidate(validated);
  return Object.freeze({
    candidateType: "strategy-derivation" as const,
    candidateId: validated.candidateId,
    candidateFingerprint,
    projectId: validated.projectId,
    basePortfolioFingerprint: validated.basePortfolio.fingerprint,
    proposal: Object.freeze({
      strategyId: validated.proposal.strategyId,
      kind: validated.proposal.kind,
      summary: validated.proposal.summary,
      useWhen: Object.freeze([...validated.proposal.useWhen]),
      avoidWhen: Object.freeze([...validated.proposal.avoidWhen]),
      principles: Object.freeze([...validated.proposal.principles]),
    }),
    provenance: Object.freeze({
      sourceRecordCount: validated.evidence.sourceRecordIds.length,
    }),
    hypothesis: validated.hypothesis,
    selector: Object.freeze({
      strategyId: validated.proposal.strategyId,
      revisionIdentity: validated.candidateId,
      revisionFingerprint: candidateFingerprint,
    }),
    trustBoundary: "This Candidate is an inactive hypothesis; Trial does not make it trusted.",
  });
}

export const createDerivationTrialPacket = buildDerivationTrialPacket;

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

/** Render one bounded, advisory Derivation Candidate Trial Packet. */
export function formatDerivationTrialPacket(
  packet: DerivationTrialPacket,
): string {
  const lines = [
    "<PINDIE_DERIVATION_TRIAL_PACKET>",
    "This is an explicitly requested Strategy Derivation Candidate Trial.",
    "This is not new user Task intent and does not start an Agent Run.",
    "The normal Pindie Task / Gateway / Verification authority is unchanged.",
    "",
    "Candidate:",
    "- Candidate type: Strategy Derivation",
    `- Candidate ID: ${packet.candidateId}`,
    `- Candidate semantic fingerprint: ${packet.candidateFingerprint}`,
    `- Project ID: ${packet.projectId}`,
    `- Base trusted-portfolio fingerprint: ${packet.basePortfolioFingerprint}`,
    "",
    "Proposed logical Strategy:",
    `- Strategy ID: ${packet.proposal.strategyId}`,
    `- Kind: ${packet.proposal.kind}`,
    `- Summary: ${packet.proposal.summary}`,
  ];
  renderList(lines, "- Use when", packet.proposal.useWhen);
  renderList(lines, "- Avoid when", packet.proposal.avoidWhen);
  renderList(lines, "- Principles", packet.proposal.principles);
  lines.push(
    "",
    "Bounded hypothesis/provenance context:",
    `- Cited source Experience records: ${packet.provenance.sourceRecordCount}`,
    `- Hypothesis: ${packet.hypothesis}`,
    "",
    "Controlled-Trial boundary:",
    `- ${packet.trustBoundary}`,
    "- Candidate use is optional; do not select it merely to create evidence.",
    "- The model must explicitly declare the exact Candidate Policy if it materially fits the Task.",
    "- Merely receiving this packet does NOT create Candidate attribution.",
    "- It is valid to use a normal trusted Policy instead.",
    "- This Trial is one Agent Run only; it does not carry through Session replacement or Long Task rollover.",
    "- Candidate Trial status is Harness-resolved as revisionStatusAtRun = trial; do not author status, trust, or semantics.",
    "- Do not infer or claim novelty, usefulness, superiority, or causality from this Trial.",
    "",
    "Exact Policy selector allowed for this Run:",
    `- Declare it under ${packet.proposal.kind === "approach" ? "approach" : "modifiers"} exactly as this object:`,
    JSON.stringify(packet.selector, null, 2),
    "- The Harness resolves this exact selector to the immutable Candidate proposal; do not add Candidate semantics or other revision data.",
    "</PINDIE_DERIVATION_TRIAL_PACKET>",
  );
  return lines.join("\n");
}

export const renderDerivationTrialPacket = formatDerivationTrialPacket;

export interface TrialLease {
  readonly sessionId: string;
  readonly candidate: StrategyRevisionCandidate;
  readonly candidateFingerprint: string;
  readonly revisionSelection: StrategyRevisionSelection;
  readonly renderedPacket: string;
  readonly agentRunGeneration: number | null;
}

export interface DerivationTrialLease {
  readonly candidateType: "strategy-derivation";
  readonly sessionId: string;
  readonly candidate: StrategyDerivationCandidateV1;
  readonly candidateFingerprint: string;
  readonly revisionSelection: StrategyRevisionSelection;
  readonly renderedPacket: string;
  readonly agentRunGeneration: number | null;
}

type StoredTrialLease = TrialLease | DerivationTrialLease;

function isDerivationTrialLease(
  lease: StoredTrialLease,
): lease is DerivationTrialLease {
  return "candidateType" in lease && lease.candidateType === "strategy-derivation";
}

function sameDerivationCandidate(
  left: StrategyDerivationCandidateV1,
  right: StrategyDerivationCandidateV1,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Runtime-only pending/active Candidate Trial lease; nothing is persisted. */
export class TrialRuntime {
  // Revision and Derivation leases share these two slots. Keeping one pair of
  // slots preserves the v0.6 mutual exclusion invariant without a parallel
  // Trial runtime or a durable union wrapper.
  private pending: StoredTrialLease | null = null;
  private active: StoredTrialLease | null = null;

  get hasTrial(): boolean {
    return this.pending !== null || this.active !== null;
  }

  get hasPendingTrial(): boolean {
    return this.pending !== null;
  }

  get hasActiveTrial(): boolean {
    return this.active !== null;
  }

  get hasPendingDerivationTrial(): boolean {
    return this.pending !== null && isDerivationTrialLease(this.pending);
  }

  get hasActiveDerivationTrial(): boolean {
    return this.active !== null && isDerivationTrialLease(this.active);
  }

  /** Existing v0.6 view; null when the shared lease is a Derivation Trial. */
  get pendingTrial(): TrialLease | null {
    return this.pending !== null && !isDerivationTrialLease(this.pending)
      ? this.pending
      : null;
  }

  /** Existing v0.6 view; null when the shared lease is a Derivation Trial. */
  get activeTrial(): TrialLease | null {
    return this.active !== null && !isDerivationTrialLease(this.active)
      ? this.active
      : null;
  }

  get pendingDerivationTrial(): DerivationTrialLease | null {
    return this.pending !== null && isDerivationTrialLease(this.pending)
      ? this.pending
      : null;
  }

  get activeDerivationTrial(): DerivationTrialLease | null {
    return this.active !== null && isDerivationTrialLease(this.active)
      ? this.active
      : null;
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

  establishDerivation(
    sessionId: string,
    candidate: StrategyDerivationCandidateV1,
  ): boolean {
    if (sessionId.trim() === "" || this.hasTrial) return false;
    const validated = validateStrategyDerivationCandidateArtifact(
      candidate,
      candidate.candidateId,
    );
    const candidateFingerprint = strategyDerivationCandidateSemanticFingerprint(validated);
    const revisionSelection = strategyRevisionSelectionFromDerivationCandidate(validated);
    const packet = buildDerivationTrialPacket(validated);
    this.pending = Object.freeze({
      candidateType: "strategy-derivation" as const,
      sessionId,
      candidate: validated,
      candidateFingerprint,
      revisionSelection,
      renderedPacket: formatDerivationTrialPacket(packet),
      agentRunGeneration: null,
    });
    return true;
  }

  /** Bind an existing v0.6 Revision Trial without changing its lease shape. */
  bind(sessionId: string, agentRunGeneration: number): TrialLease | null {
    if (
      this.pending === null ||
      isDerivationTrialLease(this.pending) ||
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

  /** Bind the shared pending lease when it contains a Derivation Candidate. */
  bindDerivation(
    sessionId: string,
    agentRunGeneration: number,
  ): DerivationTrialLease | null {
    if (
      this.pending === null ||
      !isDerivationTrialLease(this.pending) ||
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
      isDerivationTrialLease(this.active) ||
      sessionId === null ||
      agentRunGeneration === null ||
      this.active.sessionId !== sessionId ||
      this.active.agentRunGeneration !== agentRunGeneration
    ) return null;
    return this.active;
  }

  activeDerivationFor(
    sessionId: string | null,
    agentRunGeneration: number | null,
  ): DerivationTrialLease | null {
    if (
      this.active === null ||
      !isDerivationTrialLease(this.active) ||
      sessionId === null ||
      agentRunGeneration === null ||
      this.active.sessionId !== sessionId ||
      this.active.agentRunGeneration !== agentRunGeneration
    ) return null;
    return this.active;
  }

  /** Resolve only the exact active v0.6 Candidate selector. */
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

  /**
   * Resolve an exact Derivation Candidate selector. An optional freshly-read
   * artifact is checked byte-for-byte against the lease before its semantics
   * are converted into the trial selection.
   */
  resolveDerivationSelector(
    sessionId: string | null,
    agentRunGeneration: number | null,
    selector: unknown,
    kind: "approach" | "modifier",
    currentCandidate?: StrategyDerivationCandidateV1,
  ): StrategyRevisionSelection {
    const lease = this.activeDerivationFor(sessionId, agentRunGeneration);
    if (lease === null) {
      throw new Error("Derivation Candidate selector is unavailable without its active Derivation Trial for this Agent Run.");
    }
    if (!isStrategyRevisionSelector(selector)) {
      throw new Error("Derivation Candidate selector is malformed or not the exact selector from the active Trial Packet.");
    }
    const candidate = validateStrategyDerivationCandidateArtifact(
      currentCandidate ?? lease.candidate,
      lease.candidate.candidateId,
    );
    if (!sameDerivationCandidate(candidate, lease.candidate)) {
      throw new Error("Derivation Candidate artifact changed after the Trial lease was armed.");
    }
    const candidateFingerprint = strategyDerivationCandidateSemanticFingerprint(candidate);
    if (
      candidate.proposal.kind !== kind ||
      selector.strategyId !== candidate.proposal.strategyId ||
      selector.revisionIdentity !== candidate.candidateId ||
      selector.revisionFingerprint !== candidateFingerprint
    ) {
      if (candidate.proposal.kind !== kind) {
        throw new Error(`Derivation Candidate selector has the wrong ${kind} role for the active Candidate.`);
      }
      throw new Error("Derivation Candidate selector does not match the active Candidate Trial.");
    }
    return strategyRevisionSelectionFromDerivationCandidate(candidate);
  }

  clear(): void {
    this.pending = null;
    this.active = null;
  }
}
