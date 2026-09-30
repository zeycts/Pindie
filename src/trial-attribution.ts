import { canonicalJson, validateTrialAssignment, type TrialAssignment } from "./learning-v1-contract.ts";
import type { ToolEffect } from "./execution-semantics.ts";
import { RunExperienceTracker, type RunExperienceExecution } from "./run-experience.ts";
import type { ClaimedTrialOffer } from "./trial-offers.ts";
import { validateTrialOfferCommit, type TrialOfferCommit } from "./trial-offer-store.ts";

export interface TrialRunBinding {
  readonly sessionId: string;
  readonly agentRunGeneration: number;
  readonly occurrenceEpoch: number;
}
/** Frozen v6 shape; historical exposure came from rendering, not final delivery. */
export interface TrialRunAttribution {
  readonly assignment: TrialAssignment;
  readonly exposure: TrialRunBinding & { readonly at: number; readonly order: number };
  readonly declaration: "none" | "select" | "decline";
  readonly declaredAt: number | null;
  readonly declarationFrontier: RunExperienceExecution | null;
  readonly postSelection: RunExperienceExecution;
  readonly authorityCurrent: boolean;
}

/** Conservative T2 fallback: rendering and model declaration are observable;
 * final provider delivery is not observable through Pi 0.99.1 public hooks. */
export interface TrialRunAttempt {
  readonly assignmentProposal: TrialAssignment;
  readonly rendered: TrialRunBinding & { readonly at: number; readonly order: number };
  readonly delivery: "unknown";
  readonly publication: "confirmed" | "unconfirmed";
  readonly declaration: "none" | "select" | "decline";
  readonly declaredAt: number | null;
  /** Run-level chronological counters, never assignment-episode or causal use. */
  readonly counterScope: "run";
  readonly declarationFrontier: RunExperienceExecution | null;
  readonly postSelection: RunExperienceExecution;
  readonly authorityCurrent: boolean;
}

type Resolve = (claim: ClaimedTrialOffer) => Promise<TrialOfferCommit | null>;

/** One bounded runtime-only record owned by one Run. No State, policy or persistence. */
export class TrialAttributionHolder {
  private exposure: { claim: ClaimedTrialOffer; binding: TrialRunBinding; at: number; order: number } | null = null;
  private declaration: "none" | "select" | "decline" = "none";
  private declaredAt: number | null = null;
  private frontier: RunExperienceExecution | null = null;
  private enabled = false;
  private publicationConfirmed = false;
  private epoch = 0;
  private readonly subsequent = new RunExperienceTracker();

  reset(): void {
    ++this.epoch;
    this.exposure = null;
    this.declaration = "none";
    this.declaredAt = null;
    this.frontier = null;
    this.enabled = false;
    this.publicationConfirmed = false;
    this.subsequent.reset();
  }

  /** Preserve partial historical facts, but never restore declaration authority. */
  invalidate(): void { ++this.epoch; this.enabled = false; }

  /** Records only a proposed render; later public Pi handlers can remove it. */
  render(claim: ClaimedTrialOffer, binding: TrialRunBinding, at: number, order: number): boolean {
    const assignment = claim.commit.assignment;
    if (!assignment || !validateTrialAssignment(assignment) || assignment.sessionId !== binding.sessionId ||
      !Number.isSafeInteger(binding.agentRunGeneration) || binding.agentRunGeneration < 0 ||
      !Number.isSafeInteger(binding.occurrenceEpoch) || binding.occurrenceEpoch < 0 ||
      !Number.isSafeInteger(order) || order < 0 || !Number.isFinite(at) || at < assignment.createdAt || at >= assignment.expiresAt) return false;
    if (this.exposure) {
      return this.enabled && canonicalJson(this.exposure.binding) === canonicalJson(binding) &&
        canonicalJson(this.exposure.claim.commit) === canonicalJson(claim.commit);
    }
    this.exposure = { claim, binding: Object.freeze({ ...binding }), at, order };
    this.enabled = true;
    return true;
  }

  /** Publication I/O is confined to recorder/settlement, never Task dispatch/context. */
  async declare(assignmentId: string, decision: "select" | "decline", resolve: Resolve,
    isCurrent: () => boolean, execution: () => RunExperienceExecution, now: () => number): Promise<boolean> {
    const exposure = this.exposure, epoch = this.epoch;
    if (!exposure || !this.enabled || !isCurrent() || exposure.claim.commit.assignment?.id !== assignmentId ||
      (decision !== "select" && decision !== "decline")) return false;
    let published: TrialOfferCommit | null;
    try { published = await resolve(exposure.claim); } catch { return false; }
    const at = now();
    // Every await may cross preemption, expiry or an entirely new Run. Recheck all
    // authority, not just the immutable assignment identity, before recording.
    if (!published || !validateTrialOfferCommit(published) || canonicalJson(published) !== canonicalJson(exposure.claim.commit) ||
      this.exposure !== exposure || epoch !== this.epoch || !this.enabled || !isCurrent() ||
      !Number.isFinite(at) || at < exposure.at || at >= exposure.claim.expiresAt) return false;
    this.publicationConfirmed = true;
    if (this.declaration !== "none") return this.declaration === decision;
    this.declaration = decision;
    this.declaredAt = at;
    this.frontier = Object.freeze({ ...execution() });
    return true;
  }

  recordAuthorizedCall(id: string, effect: ToolEffect): void {
    if (this.enabled && this.declaration === "select") this.subsequent.recordAuthorizedCall(id, effect);
  }
  recordDeniedCall(effect: ToolEffect): void {
    if (this.enabled && this.declaration === "select") this.subsequent.recordDeniedCall(effect);
  }
  recordToolResult(id: string, isError: boolean): void {
    // Results are credited only to IDs admitted after selection, even if a call
    // finishes after invalidation. Pre-selection in-flight errors never count.
    this.subsequent.recordToolResult(id, isError);
  }

  async settle(binding: TrialRunBinding, resolve: Resolve, isCurrent: () => boolean): Promise<TrialRunAttempt | null> {
    const exposure = this.exposure;
    // Settlement may follow Task replacement. The original occurrence remains an
    // exact historical binding; never assign the mixed aggregate Run to it.
    if (!exposure || binding.sessionId !== exposure.binding.sessionId ||
      binding.agentRunGeneration !== exposure.binding.agentRunGeneration) return null;
    let published: TrialOfferCommit | null = null;
    try { published = await resolve(exposure.claim); } catch { /* retain partial rendering */ }
    if (this.exposure !== exposure) return null;
    const confirmedNow = published !== null && validateTrialOfferCommit(published) &&
      canonicalJson(published) === canonicalJson(exposure.claim.commit);
    return Object.freeze({
      assignmentProposal: Object.freeze(structuredClone(exposure.claim.commit.assignment!)),
      rendered: Object.freeze({ ...exposure.binding, at: exposure.at, order: exposure.order }),
      delivery: "unknown",
      publication: confirmedNow || this.publicationConfirmed ? "confirmed" : "unconfirmed",
      counterScope: "run",
      declaration: this.declaration,
      declaredAt: this.declaredAt,
      declarationFrontier: this.frontier,
      postSelection: this.subsequent.execution,
      authorityCurrent: confirmedNow && this.enabled && isCurrent(),
    });
  }
}
