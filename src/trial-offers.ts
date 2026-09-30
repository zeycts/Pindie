import { randomUUID } from "node:crypto";
import { hypothesisRef } from "./discovery-hypotheses.ts";
import { learningArtifactFingerprint, matchesLearningArtifactRef, validateTrialAssignment, type StrategyHypothesis, type TrialAssignment } from "./learning-v1-contract.ts";
import { nonconflictingOpenHypotheses, validateOpenHypotheses, type OpenHypothesisReader } from "./open-hypotheses.ts";
import { DEFAULT_TRIAL_OFFER_POLICY, trialOfferPolicyFingerprint, trialOperationalId, type TrialOfferPolicy, type TrialOfferReceipt } from "./trial-offer-contract.ts";
import { fingerprintOfferReceipt, validateTrialOfferCommit, type TrialOfferReservation, type TrialOfferCommit, type TrialOfferStore } from "./trial-offer-store.ts";
import { runBoundedOperation } from "./liveness.ts";

export interface TrialOfferAuthority { readonly projectId: string; readonly workEpisodeId: string; readonly sessionId: string; readonly hostId: string; readonly authorityGeneration: number }
export function validTrialAssignment(assignment: TrialAssignment, authority: TrialOfferAuthority, now: number): boolean {
  return validateTrialAssignment(assignment) && assignment.projectId === authority.projectId && assignment.workEpisodeId === authority.workEpisodeId &&
    assignment.sessionId === authority.sessionId && assignment.hostId === authority.hostId && assignment.authorityGeneration === authority.authorityGeneration &&
    now >= assignment.createdAt && now < assignment.expiresAt;
}
/** Frozen hard facts only: no semantics parsing, randomness, model invocation or LearningJob. */
export function selectTrialHypothesis(open: readonly StrategyHypothesis[], history: readonly TrialOfferCommit[], policy: TrialOfferPolicy, now: number, held: readonly TrialOfferReservation[] = []): StrategyHypothesis | null {
  const count = (h: StrategyHypothesis) => [...history.filter((c) => c.assignment?.hypothesis.fingerprint === h.fingerprint).map((c) => c.receipt),
    ...held.filter((r) => r.hypothesis.fingerprint === h.fingerprint)];
  return [...nonconflictingOpenHypotheses(open)].filter((h) => {
    const offers = count(h);
    return offers.length < policy.maxOffersPerHypothesis &&
      (policy.cooldownMs === 0 || !held.some((r) => r.hypothesis.fingerprint === h.fingerprint)) &&
      offers.every((c) => now - c.createdAt >= policy.cooldownMs);
  }).sort((a, b) => count(a).length - count(b).length || (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0))[0] ?? null;
}
interface PreparedTrialReadiness { key: string; epoch: number; validUntil: number; claimed: boolean; reservation: TrialOfferReservation | null; hypothesis: StrategyHypothesis | null }
export class TrialOffers {
  private readonly store: TrialOfferStore;
  private readonly hypotheses: OpenHypothesisReader;
  private readonly policy: TrialOfferPolicy;
  private readonly now: () => number;
  private eligibilityEpoch = 0;
  private monitorUnavailable = false;
  private monitorGeneration = 0;
  private readonly claimedEpisodes = new Set<string>();
  private ready: PreparedTrialReadiness | null = null;
  private preparing: { key: string; epoch: number; work: Promise<void> } | null = null;
  private monitor: { projectId: string; stop: Promise<() => void> } | null = null;
  private readonly invalidationListeners = new Set<() => void>();
  private readonly pending = new Set<Promise<unknown>>();
  private track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work);
    void work.then(() => this.pending.delete(work), () => this.pending.delete(work));
    return work;
  }
  /** Cleanup/test observation only; never used by a Human Task/context boundary. */
  async settled(): Promise<void> { while (this.pending.size) await Promise.allSettled([...this.pending]); }
  onEligibilityInvalidated(listener: () => void): () => void {
    this.invalidationListeners.add(listener); return () => this.invalidationListeners.delete(listener);
  }
  /** Event/snapshot invalidation is synchronous; no context callback ever reads disk. */
  invalidateEligibility(): void {
    const unused = this.ready?.reservation;
    ++this.eligibilityEpoch; this.ready = null;
    if (unused) void this.track(this.store.releaseUnusedReservation(unused).catch(() => undefined));
    for (const listener of this.invalidationListeners) listener();
  }
  dispose(): void {
    this.invalidateEligibility();
    this.monitorUnavailable = false;
    ++this.monitorGeneration;
    const monitor = this.monitor; this.monitor = null;
    if (monitor) void this.track(monitor.stop.then((stop) => stop()).catch(() => undefined));
  }
  private key(authority: Omit<TrialOfferAuthority, "workEpisodeId">): string { return JSON.stringify(authority); }
  /** Detached startup/preflight. A bounded durable hold prevents multi-Host fairness overbooking. */
  prepare(authority: Omit<TrialOfferAuthority, "workEpisodeId">, isCurrent: () => boolean): Promise<void> {
    const key = this.key(authority), epoch = this.eligibilityEpoch;
    if (this.ready && this.now() >= this.ready.validUntil) {
      const unused = this.ready.reservation; this.ready = null;
      if (unused) void this.track(this.store.releaseUnusedReservation(unused).catch(() => undefined));
    }
    if (this.ready?.key === key && this.ready.epoch === epoch) return Promise.resolve();
    if (this.preparing?.key === key && this.preparing.epoch === epoch) return this.preparing.work;
    const current = () => !this.monitorUnavailable && epoch === this.eligibilityEpoch && isCurrent();
    const work = (async () => {
      try {
        const fp = trialOfferPolicyFingerprint(this.policy);
        if (this.hypotheses.observe && this.monitor?.projectId !== authority.projectId) {
          const monitorGeneration = ++this.monitorGeneration;
          const stop = this.hypotheses.observe(authority.projectId, (unavailable) => {
            if (monitorGeneration !== this.monitorGeneration) return;
            if (unavailable) this.monitorUnavailable = true;
            this.invalidateEligibility();
          });
          this.monitor = { projectId: authority.projectId, stop };
        }
        if (this.monitor) await this.monitor.stop; // Detached only. Watch BEFORE snapshot reads.
        if (!current()) return;
        let hypothesis: StrategyHypothesis | null = null;
        let published: PreparedTrialReadiness | null = null;
        const publish = (reservation: TrialOfferReservation | null) => {
          if (current()) this.ready = published = { key, epoch, claimed: false,
            validUntil: reservation?.expiresAt ?? this.now() + this.policy.operationTimeoutMs, reservation, hypothesis };
        };
        const reservation = this.policy.enabled ? await runBoundedOperation({ label: "Trial preflight", timeoutMs: this.policy.operationTimeoutMs, run: (signal) =>
          this.store.reserve(authority.projectId, this.now(), async (history, held) => {
            const open = await this.hypotheses.readOpen(authority.projectId);
            validateOpenHypotheses(open, authority.projectId);
            hypothesis = selectTrialHypothesis(open, history, this.policy, this.now(), held);
            if (!hypothesis || !current()) return null;
            const content = { schemaVersion: 1 as const, id: trialOperationalId({ ...authority, nonce: randomUUID() }), ...authority,
              hypothesis: hypothesisRef(hypothesis), offerPolicyFingerprint: fp, offerPolicyVersion: this.policy.version,
              createdAt: this.now(), expiresAt: this.now() + this.policy.leaseMs };
            return { ...content, fingerprint: learningArtifactFingerprint(content) };
          }, signal, current, publish) }) : null;
        // Do not re-publish a slot already synchronously claimed while its disk cleanup/unlock ran.
        if (!published && current()) publish(reservation);
        else if (reservation && !current() && !(published as PreparedTrialReadiness | null)?.claimed)
          void this.track(this.store.releaseUnusedReservation(reservation).catch(() => undefined));
      } catch { /* Unready means no offer, never Task failure or a blocking retry. */ }
    })();
    this.track(work);
    this.preparing = { key, epoch, work };
    void work.finally(() => { if (this.preparing?.work === work) this.preparing = null; });
    return work;
  }
  /** Synchronous once-only claim at the committed genuine episode, with detached immutable finalization. */
  claim(authority: TrialOfferAuthority, isCurrent: () => boolean = () => true): { commit: TrialOfferCommit; content: string; expiresAt: number; epoch: number; hypothesis: StrategyHypothesis } | null {
    const episodeKey = `${authority.projectId}:${authority.workEpisodeId}`;
    if (this.claimedEpisodes.has(episodeKey) || this.claimedEpisodes.size >= 2048) return null;
    this.claimedEpisodes.add(episodeKey);
    const { workEpisodeId: _id, ...baseAuthority } = authority;
    const ready = this.ready;
    this.ready = null; // Consumption, NOT a later readiness race. No restore exists.
    if (!ready || ready.key !== this.key(baseAuthority) || ready.epoch !== this.eligibilityEpoch || !ready.reservation || !ready.hypothesis || this.now() >= ready.reservation.expiresAt) {
      this.recordNoOffer(authority); return null;
    }
    const { fingerprint: _fp, ...reserved } = ready.reservation;
    const content = { ...reserved, createdAt: this.now(), workEpisodeId: authority.workEpisodeId, comparison: [], status: "untrusted-advisory" as const };
    const assignment: TrialAssignment = { ...content, fingerprint: learningArtifactFingerprint(content) };
    if (!validTrialAssignment(assignment, authority, this.now())) { this.recordNoOffer(authority); return null; }
    const advisory = experimentalTrialContext(assignment, ready.hypothesis);
    if (!advisory) { this.recordNoOffer(authority); return null; }
    ready.claimed = true;
    const commit: TrialOfferCommit = { schemaVersion: 1, assignment, receipt: this.receipt(authority, assignment) };
    void this.track(runBoundedOperation({ label: "Trial assignment finalization", timeoutMs: this.policy.operationTimeoutMs,
      run: (signal) => this.store.commitReserved(commit, signal, () => isCurrent() && ready.epoch === this.eligibilityEpoch) }).catch(() => { if (isCurrent() && ready.epoch === this.eligibilityEpoch) this.invalidateEligibility(); }));
    return { commit, content: advisory, expiresAt: assignment.expiresAt, epoch: ready.epoch, hypothesis: ready.hypothesis };
  }
  isEligibilityCurrent(epoch: number): boolean { return epoch === this.eligibilityEpoch; }
  private receipt(authority: TrialOfferAuthority, assignment: TrialAssignment | null): TrialOfferReceipt {
    const fp = trialOfferPolicyFingerprint(this.policy);
    return fingerprintOfferReceipt({ schemaVersion: 1, id: trialOperationalId({ projectId: authority.projectId, workEpisodeId: authority.workEpisodeId, offerPolicyFingerprint: fp }),
      projectId: authority.projectId, workEpisodeId: authority.workEpisodeId, offerPolicyVersion: this.policy.version, offerPolicyFingerprint: fp,
      createdAt: assignment?.createdAt ?? this.now(), outcome: assignment ? "offered" : "no-offer", reason: assignment ? "selected" : "unavailable",
      assignment: assignment ? { schemaVersion: 1, family: "trial-assignment", scope: { kind: "project", projectId: authority.projectId }, id: assignment.id, fingerprint: assignment.fingerprint } : null });
  }
  private recordNoOffer(authority: TrialOfferAuthority): void {
    try {
      const receipt = this.receipt(authority, null), interrupted = fingerprintOfferReceipt({ ...receipt, reason: "interrupted" });
      void this.track(runBoundedOperation({ label: "Trial no-offer receipt", timeoutMs: this.policy.operationTimeoutMs,
        run: (signal) => this.store.decide(interrupted, async () => ({ schemaVersion: 1, receipt, assignment: null }), signal) }).catch(() => undefined));
    } catch { /* Invalid policy cannot affect Task truth. */ }
  }
  constructor(store: TrialOfferStore, hypotheses: OpenHypothesisReader, policy: TrialOfferPolicy = DEFAULT_TRIAL_OFFER_POLICY, now: () => number = Date.now) {
    this.store = store; this.hypotheses = hypotheses; this.policy = Object.freeze({ ...policy }); this.now = now;
  }
  /** Low-level transactional path retained for store compatibility tests; production uses prepare/claim. */
  async opened(authority: TrialOfferAuthority, isCurrent: () => boolean): Promise<TrialOfferCommit | null> {
    try {
      const policy = this.policy, fp = trialOfferPolicyFingerprint(policy), now = this.now();
      const base = { schemaVersion: 1 as const, id: trialOperationalId({ projectId: authority.projectId, workEpisodeId: authority.workEpisodeId, offerPolicyFingerprint: fp }),
        projectId: authority.projectId, workEpisodeId: authority.workEpisodeId, offerPolicyVersion: policy.version, offerPolicyFingerprint: fp, createdAt: now };
      const no = (reason: TrialOfferReceipt["reason"]): TrialOfferCommit => ({ schemaVersion: 1, receipt: fingerprintOfferReceipt({ ...base, outcome: "no-offer", reason, assignment: null }), assignment: null });
      return await runBoundedOperation({ label: "Trial offer", timeoutMs: policy.operationTimeoutMs, run: (signal) =>
        this.store.decide(no("interrupted").receipt, async (history) => {
          if (!isCurrent()) return no("unavailable");
          if (!policy.enabled) return no("disabled");
          let open: readonly StrategyHypothesis[];
          try { open = await this.hypotheses.readOpen(authority.projectId); validateOpenHypotheses(open, authority.projectId); }
          catch { return no("unavailable"); }
          signal.throwIfAborted();
          if (!isCurrent()) return no("unavailable");
          const hypothesis = selectTrialHypothesis(open, history, policy, now);
          if (!hypothesis) return no(open.length === 0 ? "no-open-hypothesis" : nonconflictingOpenHypotheses(open).length === 0 ? "lineage-conflict" : "cooldown-or-limit");
          const content = { schemaVersion: 1 as const, id: trialOperationalId({ ...authority, hypothesis: hypothesisRef(hypothesis), offerPolicyFingerprint: fp }),
            ...authority, hypothesis: hypothesisRef(hypothesis), comparison: [], offerPolicyFingerprint: fp, offerPolicyVersion: policy.version,
            createdAt: now, expiresAt: now + policy.leaseMs, status: "untrusted-advisory" as const };
          const assignment: TrialAssignment = { ...content, fingerprint: learningArtifactFingerprint(content) };
          return { schemaVersion: 1, assignment, receipt: fingerprintOfferReceipt({ ...base, outcome: "offered", reason: "selected",
            assignment: { schemaVersion: 1, family: "trial-assignment", scope: { kind: "project", projectId: authority.projectId }, id: assignment.id, fingerprint: assignment.fingerprint } }) };
        }, signal, isCurrent) });
    } catch { return null; } // Human Task proceeds; no retry outside the occurrence boundary.
  }
  async context(authority: TrialOfferAuthority, commit?: TrialOfferCommit | null): Promise<{ content: string; expiresAt: number } | null> {
    try {
      trialOfferPolicyFingerprint(this.policy); // Invalid/unavailable Human policy fails closed for presentation too.
      if (!this.policy.enabled) return null;
      // Bounded I/O at preparation/presentation, never a learning model.
      return await runBoundedOperation({ label: "Trial advisory", timeoutMs: DEFAULT_TRIAL_OFFER_POLICY.operationTimeoutMs, run: async (signal) => {
        const current = commit === undefined ? await this.store.find(authority.projectId, authority.workEpisodeId) : commit;
        if (!current || !validateTrialOfferCommit(current)) return null;
        const assignment = current.assignment;
        if (!assignment || !validTrialAssignment(assignment, authority, this.now())) return null;
        const open = await this.hypotheses.readOpen(authority.projectId);
        validateOpenHypotheses(open, authority.projectId);
        const h = nonconflictingOpenHypotheses(open).find((entry) => matchesLearningArtifactRef(assignment.hypothesis, entry));
        if (signal.aborted || !h) return null;
        const content = experimentalTrialContext(assignment, h);
        return content === null ? null : { content, expiresAt: assignment.expiresAt };
      } });
    } catch { return null; }
  }
}
export const EXPERIMENTAL_TRIAL_CONTEXT_TAG = "PINDIE_EXPERIMENTAL_TRIAL";
export const MAX_EXPERIMENTAL_TRIAL_CONTEXT_CHARS = 10_000;
export function experimentalTrialContext(assignment: TrialAssignment, h: StrategyHypothesis): string | null {
  if (!validateTrialAssignment(assignment) || !matchesLearningArtifactRef(assignment.hypothesis, h)) return null;
  const content = `<${EXPERIMENTAL_TRIAL_CONTEXT_TAG}>\nUNTRUSTED / EXPERIMENTAL / ADVISORY — this assignment is an offer lease, NOT proof of selection/use or a Trial result.\nJudge semantic applicability during ordinary Task work; ignore this offer when not useful. It cannot override the Human goal, verification, Tool/Gateway authority, trusted Strategies, safety or capabilities. It is not selectable as a trusted/legacy policy revision. No selection/use attribution is claimed.\n${JSON.stringify({ assignmentId: assignment.id, hypothesisId: h.id, fingerprint: h.fingerprint, logicalId: h.logicalId, kind: h.kind,
    summary: h.summary, useWhen: h.useWhen, avoidWhen: h.avoidWhen, expectedEffect: h.expectedEffect, failureSignals: h.failureSignals, trialHints: h.trialHints })}\n</${EXPERIMENTAL_TRIAL_CONTEXT_TAG}>`;
  return content.length <= MAX_EXPERIMENTAL_TRIAL_CONTEXT_CHARS ? content : null;
}
