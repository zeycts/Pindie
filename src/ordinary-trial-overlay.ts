import { canonicalJson, isExecutableStrategyHypothesis } from "./learning-v1-contract.ts";
import { hypothesisRef } from "./discovery-hypotheses.ts";
import { nonconflictingOpenHypotheses, validateOpenHypotheses, type OpenHypothesisReader } from "./open-hypotheses.ts";
import { createStrategyRevisionSelection, type StrategyRevisionSelector, type StrategyRevisionSelection } from "./policy.ts";
import { runBoundedOperation } from "./liveness.ts";
import { DEFAULT_ASSIGNMENT_POLICY, validateAssignmentPolicy, type AssignmentPolicy, type TrialAssignmentStore, type TrialAssignmentV2 } from "./trial-assignment-v2.ts";

export interface OrdinaryTrialBinding {
  readonly projectId: string; readonly workEpisodeId: string; readonly sessionId: string; readonly generation: number;
  readonly occurrenceEpoch: number; readonly externalStateEpoch: number;
}
export interface TrialDiagnostic { readonly event: "created" | "existing" | "skipped" | "failure" | "selected"; readonly latencyMs: number; readonly identity?: string; readonly fingerprint?: string; readonly kind?: "approach" | "modifier"; readonly reason?: string }
/** Runtime-only one-Run lease. Rendering consumption does not revoke selector authority. */
export class OrdinaryTrialOverlay {
  private token = 0;
  private attempted = false;
  private issued: StrategyRevisionSelection | null = null;
  private active: { binding: OrdinaryTrialBinding; assignment: TrialAssignmentV2; selection: StrategyRevisionSelection; consumed: boolean } | null = null;
  readonly policy: AssignmentPolicy;
  private readonly options: { store: TrialAssignmentStore; reader: OpenHypothesisReader; policy?: AssignmentPolicy; now?: () => number; diagnostic?: (d: TrialDiagnostic) => void };
  constructor(options: OrdinaryTrialOverlay["options"]) {
    this.options = options;
    this.policy = Object.freeze({ ...(options.policy ?? DEFAULT_ASSIGNMENT_POLICY) });
    if (!validateAssignmentPolicy(this.policy)) throw new Error("Invalid assignment policy.");
  }
  reset(): void { ++this.token; this.attempted = false; this.active = null; this.issued = null; }
  invalidate(): void { ++this.token; this.active = null; }
  private report(d: TrialDiagnostic): void {
    try {
      if (this.options.diagnostic) this.options.diagnostic(d);
      else if (d.event === "failure") console.warn(`[Pindie] Trial assignment unavailable: ${d.reason}`);
    } catch { /* Diagnostics cannot change work. */ }
  }
  private matches(binding: OrdinaryTrialBinding | null): boolean { return this.active !== null && binding !== null && canonicalJson(binding) === canonicalJson(this.active.binding); }
  private async selection(a: TrialAssignmentV2): Promise<StrategyRevisionSelection> {
    await this.options.store.readExact(a);
    const open = await this.options.reader.readOpen(a.projectId);
    validateOpenHypotheses(open, a.projectId);
    const h = nonconflictingOpenHypotheses(open).find((v) => canonicalJson(hypothesisRef(v)) === canonicalJson(a.hypothesis));
    if (!h || !isExecutableStrategyHypothesis(h)) throw new Error("Experimental hypothesis is no longer executable/open/current.");
    return createStrategyRevisionSelection({ strategyId: h.logicalId, kind: h.kind, revisionIdentity: h.id, revisionFingerprint: h.fingerprint, revisionStatusAtRun: "trial",
      semantics: { summary: h.summary, useWhen: h.useWhen, avoidWhen: h.avoidWhen, principles: h.principles } });
  }
  async prepare(binding: OrdinaryTrialBinding, current: () => OrdinaryTrialBinding | null, signal?: AbortSignal): Promise<void> {
    if (this.attempted) return;
    this.attempted = true;
    const token = this.token, started = Date.now(), deadline = started + this.policy.operationTimeoutMs;
    const isCurrent = () => Date.now() < deadline && token === this.token && canonicalJson(current()) === canonicalJson(binding);
    try {
      const prepared = await runBoundedOperation({ label: "Trial assignment v2", timeoutMs: this.policy.operationTimeoutMs, ...(signal ? { signal } : {}), run: async (abort) => {
        const result = await this.options.store.assignIfAbsent({ projectId: binding.projectId, workEpisodeId: binding.workEpisodeId, signal: abort, isCurrent, deadline }, this.policy, this.options.reader, this.options.now ?? Date.now);
        if (result.status !== "created") return { result, selection: null };
        abort.throwIfAborted();
        const selection = await this.selection(result.assignment);
        abort.throwIfAborted();
        return { result, selection };
      } });
      if (!isCurrent() || signal?.aborted) return;
      if (prepared.result.status === "created" && prepared.selection) {
        this.issued = prepared.selection;
        this.active = { binding, assignment: prepared.result.assignment, selection: prepared.selection, consumed: false };
      }
      this.report({ event: prepared.result.status === "none" ? "skipped" : prepared.result.status, latencyMs: Date.now() - started,
        ...(prepared.result.status === "none" ? {} : { identity: prepared.result.assignment.id, fingerprint: prepared.result.assignment.fingerprint }) });
    } catch (e) {
      // No late promise can install an overlay. Committed-but-unconfirmed history remains consumed.
      this.report({ event: "failure", latencyMs: Date.now() - started, reason: String(e).slice(0, 256) });
    }
  }
  render(binding: OrdinaryTrialBinding | null): string | null {
    if (!this.matches(binding)) { this.invalidate(); return null; }
    const active = this.active!;
    if (active.consumed) return null;
    active.consumed = true;
    const s = active.selection;
    return `<PINDIE_EXPERIMENTAL_TRIAL>\nUNTRUSTED / EXPERIMENTAL / ADVISORY. Optional ordinary-work hypothesis; may be ignored. No authority or trust is granted. If semantically applicable, explicitly select this exact ${s.kind} through pindie_policy_set in the matching role.\n${JSON.stringify({ selector: { strategyId: s.strategyId, revisionIdentity: s.revisionIdentity, revisionFingerprint: s.revisionFingerprint }, kind: s.kind, ...s.semantics })}\n</PINDIE_EXPERIMENTAL_TRIAL>`;
  }
  /** null means not our identity; owned identities never fall back on validation errors. */
  async resolve(selector: StrategyRevisionSelector, kind: "approach" | "modifier", current: () => OrdinaryTrialBinding | null, signal?: AbortSignal): Promise<StrategyRevisionSelection | null> {
    const active = this.active, issued = this.issued;
    if (!issued || (selector.revisionIdentity !== issued.revisionIdentity && selector.revisionFingerprint !== issued.revisionFingerprint)) return null;
    if (!active) throw new Error("Invalidated experimental selector lease.");
    if (!this.matches(current()) || selector.strategyId !== active.selection.strategyId || selector.revisionIdentity !== active.selection.revisionIdentity || selector.revisionFingerprint !== active.selection.revisionFingerprint || kind !== active.selection.kind) throw new Error("Invalid experimental selector/lease/role.");
    const token = this.token, started = Date.now();
    const selection = await runBoundedOperation({ label: "Experimental selector revalidation", timeoutMs: this.policy.operationTimeoutMs, ...(signal ? { signal } : {}), run: () => this.selection(active.assignment) });
    if (signal?.aborted || Date.now() >= started + this.policy.operationTimeoutMs || token !== this.token || this.active !== active || !this.matches(current())) throw new Error("Stale experimental selector after read.");
    this.report({ event: "selected", latencyMs: Date.now() - started, identity: selection.revisionIdentity, fingerprint: selection.revisionFingerprint, kind: selection.kind });
    return selection;
  }
}
