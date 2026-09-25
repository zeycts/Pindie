import { readdir, lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  FileStrategyCandidateStore, STRATEGY_CANDIDATE_DIRECTORY_NAME, validateStrategyRevisionCandidateArtifact,
} from "./strategy-candidates.ts";
import {
  FileStrategyDecisionStore, STRATEGY_DECISION_DIRECTORY_NAME, validateStrategyRevisionDecisionArtifact,
  validateStrategyRevisionDecisionBinding,
} from "./strategy-decisions.ts";
import {
  FileStrategyDerivationCandidateStore, STRATEGY_DERIVATION_CANDIDATE_DIRECTORY_NAME,
  validateStrategyDerivationCandidateArtifact, validateStrategyDerivationCandidateProjectIdBinding,
} from "./strategy-derivation-candidates.ts";
import {
  FileStrategyDerivationDecisionStore, STRATEGY_DERIVATION_DECISION_DIRECTORY_NAME,
  validateStrategyDerivationDecisionArtifact, validateStrategyDerivationDecisionProjectIdBinding, validateStrategyDerivationDecisionBinding,
} from "./strategy-derivation-decisions.ts";
import {
  FileStrategyTrustScopeCandidateStore, STRATEGY_SCOPE_CANDIDATE_DIRECTORY_NAME,
  validateStrategyTrustScopeCandidateArtifact,
} from "./strategy-trust-scope-candidates.ts";
import {
  FileStrategyTrustScopeDecisionStore, STRATEGY_SCOPE_DECISION_DIRECTORY_NAME,
  validateStrategyTrustScopeDecisionArtifact, validateStrategyTrustScopeDecisionBinding,
} from "./strategy-trust-scope-decisions.ts";
import {
  FileStrategySynthesisCandidateReader, FileStrategySynthesisCandidateStore, STRATEGY_SYNTHESIS_CANDIDATE_DIRECTORY_NAME,
  validateStrategySynthesisCandidateArtifact,
} from "./strategy-synthesis-candidates.ts";
import {
  FileStrategySynthesisDecisionReader, FileStrategySynthesisDecisionStore, STRATEGY_SYNTHESIS_DECISION_DIRECTORY_NAME,
  validateStrategySynthesisDecisionArtifact, validateStrategySynthesisDecisionBinding,
} from "./strategy-synthesis-decisions.ts";
import { FileStrategyTrustScopeSourceResolver } from "./strategy-trust-scope-resolution.ts";
import { FileProjectTrustedStrategyPortfolioReader } from "./strategy-trust-safety.ts";
import type { StrategyKnowledgeAccess, StrategyKnowledgeSnapshotV1 } from "./strategy-knowledge.ts";

const PROJECT_ID = /^[0-9a-f]{64}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("|") !== [...keys].sort().join("|")) {
    throw new Error("Invalid Strategy knowledge snapshot shape.");
  }
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Invalid Strategy knowledge snapshot artifact list.");
  return value;
}
function unique<T>(values: unknown, validate: (item: unknown) => T, id: (item: T) => string): T[] {
  const seen = new Set<string>();
  return array(values).map((raw) => {
    const item = validate(raw);
    const key = id(item);
    if (seen.has(key)) throw new Error(`Duplicate immutable Strategy identity '${key}'.`);
    seen.add(key);
    return item;
  });
}
function pair<C extends { candidateId: string }, D extends { candidateId: string }>(
  candidates: readonly C[], decisions: readonly D[], bind: (decision: D, candidate: C) => unknown,
): void {
  const byId = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  for (const decision of decisions) {
    const candidate = byId.get(decision.candidateId);
    if (!candidate) throw new Error(`Decision '${decision.candidateId}' has no Candidate.`);
    bind(decision, candidate);
  }
}

/** Validate before any write, including rejected and inactive artifacts. */
export function validateStrategyKnowledgeSnapshot(input: unknown): StrategyKnowledgeSnapshotV1 {
  const snapshot = record(input, ["schema", "version", "projects", "global"]);
  if (snapshot.schema !== "pindie.strategy-knowledge" || snapshot.version !== 1) {
    throw new Error("Unsupported Strategy knowledge snapshot version.");
  }
  const seenProjects = new Set<string>();
  const projects = array(snapshot.projects).map((raw) => {
    const p = record(raw, ["projectId", "revisionCandidates", "revisionDecisions", "derivationCandidates", "derivationDecisions"]);
    if (typeof p.projectId !== "string" || !PROJECT_ID.test(p.projectId) || seenProjects.has(p.projectId)) {
      throw new Error("Invalid or duplicate Strategy project identity.");
    }
    const projectId = p.projectId;
    seenProjects.add(projectId);
    const revisionCandidates = unique(p.revisionCandidates, (item) => validateStrategyRevisionCandidateArtifact(item), (c) => c.candidateId);
    const revisionDecisions = unique(p.revisionDecisions, (item) => validateStrategyRevisionDecisionArtifact(item), (d) => d.candidateId);
    const derivationCandidates = unique(p.derivationCandidates, (item) => validateStrategyDerivationCandidateProjectIdBinding(validateStrategyDerivationCandidateArtifact(item), projectId), (c) => c.candidateId);
    const derivationDecisions = unique(p.derivationDecisions, (item) => validateStrategyDerivationDecisionProjectIdBinding(validateStrategyDerivationDecisionArtifact(item), projectId), (d) => d.candidateId);
    for (const candidate of derivationCandidates) {
      if (revisionCandidates.some((revision) => revision.candidateId === candidate.candidateId)) {
        throw new Error(`Ambiguous project-local Candidate identity '${candidate.candidateId}'.`);
      }
    }
    pair(revisionCandidates, revisionDecisions, validateStrategyRevisionDecisionBinding);
    pair(derivationCandidates, derivationDecisions, validateStrategyDerivationDecisionBinding);
    return { projectId, revisionCandidates, revisionDecisions, derivationCandidates, derivationDecisions };
  });
  const g = record(snapshot.global, ["scopeCandidates", "scopeDecisions", "synthesisCandidates", "synthesisDecisions"]);
  const scopeCandidates = unique(g.scopeCandidates, (item) => validateStrategyTrustScopeCandidateArtifact(item), (c) => c.candidateId);
  const scopeDecisions = unique(g.scopeDecisions, (item) => validateStrategyTrustScopeDecisionArtifact(item), (d) => d.candidateId);
  const synthesisCandidates = unique(g.synthesisCandidates, (item) => validateStrategySynthesisCandidateArtifact(item), (c) => c.candidateId);
  const synthesisDecisions = unique(g.synthesisDecisions, (item) => validateStrategySynthesisDecisionArtifact(item), (d) => d.candidateId);
  pair(scopeCandidates, scopeDecisions, validateStrategyTrustScopeDecisionBinding);
  pair(synthesisCandidates, synthesisDecisions, validateStrategySynthesisDecisionBinding);
  if (scopeCandidates.some((c) => synthesisCandidates.some((s) => s.candidateId === c.candidateId))) {
    throw new Error("Ambiguous user-global Candidate identity.");
  }
  return { schema: "pindie.strategy-knowledge", version: 1, projects,
    global: { scopeCandidates, scopeDecisions, synthesisCandidates, synthesisDecisions } };
}

/** First adapter. Path layout is confined here; the semantic bundle is typed in strategy-knowledge.ts. */
export class FileStrategyKnowledge implements StrategyKnowledgeAccess {
  readonly revisionCandidates: FileStrategyCandidateStore;
  readonly revisionDecisions: FileStrategyDecisionStore;
  readonly derivationCandidates: FileStrategyDerivationCandidateStore;
  readonly derivationDecisions: FileStrategyDerivationDecisionStore;
  readonly scopeCandidates: FileStrategyTrustScopeCandidateStore;
  readonly scopeDecisions: FileStrategyTrustScopeDecisionStore;
  readonly synthesisCandidates: FileStrategySynthesisCandidateStore;
  readonly synthesisDecisions: FileStrategySynthesisDecisionStore;
  readonly synthesisCandidateReader: FileStrategySynthesisCandidateReader;
  readonly synthesisDecisionReader: FileStrategySynthesisDecisionReader;
  readonly sourceResolver: FileStrategyTrustScopeSourceResolver;
  readonly projectTrust: FileProjectTrustedStrategyPortfolioReader;
  private readonly projectsBaseDir: string;
  private readonly globalBaseDir: string;

  constructor(options: { projectsBaseDir?: string; globalBaseDir?: string } = {}) {
    this.projectsBaseDir = options.projectsBaseDir ?? join(homedir(), ".pindie", "projects");
    this.globalBaseDir = options.globalBaseDir ?? join(homedir(), ".pindie", "global");
    const baseDir = this.projectsBaseDir;
    this.revisionCandidates = new FileStrategyCandidateStore({ baseDir });
    this.revisionDecisions = new FileStrategyDecisionStore({ baseDir });
    this.derivationCandidates = new FileStrategyDerivationCandidateStore({ baseDir });
    this.derivationDecisions = new FileStrategyDerivationDecisionStore({ baseDir });
    this.scopeCandidates = new FileStrategyTrustScopeCandidateStore({ baseDir: this.globalBaseDir });
    this.scopeDecisions = new FileStrategyTrustScopeDecisionStore({ baseDir: this.globalBaseDir });
    this.synthesisCandidates = new FileStrategySynthesisCandidateStore({ baseDir: this.globalBaseDir });
    this.synthesisDecisions = new FileStrategySynthesisDecisionStore({ baseDir: this.globalBaseDir });
    this.synthesisCandidateReader = new FileStrategySynthesisCandidateReader({ baseDir: this.globalBaseDir });
    this.synthesisDecisionReader = new FileStrategySynthesisDecisionReader({ baseDir: this.globalBaseDir });
    this.sourceResolver = new FileStrategyTrustScopeSourceResolver({ projectsBaseDir: baseDir });
    this.projectTrust = new FileProjectTrustedStrategyPortfolioReader({ projectsBaseDir: baseDir, globalBaseDir: this.globalBaseDir });
  }

  async exportSnapshot(): Promise<StrategyKnowledgeSnapshotV1> {
    const entries = await readdir(this.projectsBaseDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const projects = await Promise.all(entries.filter((entry) => entry.isDirectory() && PROJECT_ID.test(entry.name)).map(async (entry) => ({
      projectId: entry.name,
      revisionCandidates: await this.revisionCandidates.readAllProjectId(entry.name),
      revisionDecisions: await this.revisionDecisions.readAllProjectId(entry.name),
      derivationCandidates: await this.derivationCandidates.readAllProjectId(entry.name),
      derivationDecisions: await this.derivationDecisions.readAllProjectId(entry.name),
    })));
    return validateStrategyKnowledgeSnapshot({ schema: "pindie.strategy-knowledge", version: 1, projects,
      global: {
        scopeCandidates: await this.scopeCandidates.readAll(), scopeDecisions: await this.scopeDecisions.readAll(),
        synthesisCandidates: await this.synthesisCandidates.readAll(), synthesisDecisions: await this.synthesisDecisions.readAll(),
      },
    });
  }

  /** Only empty, absent roots can be imported. Stage and validate the full trust projection
   * before publishing; never merge into live cognition or overwrite an identity. */
  async importSnapshot(input: unknown): Promise<void> {
    const snapshot = validateStrategyKnowledgeSnapshot(input);
    if (dirname(this.projectsBaseDir) !== dirname(this.globalBaseDir)) {
      throw new Error("Import requires Strategy roots under one parent for safe staging.");
    }
    const parent = dirname(this.projectsBaseDir);
    if (this.projectsBaseDir !== join(parent, "projects") || this.globalBaseDir !== join(parent, "global")) {
      throw new Error("Import requires isolated projects and global roots.");
    }
    const exists = async (path: string) => lstat(path).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    if (await exists(parent)) {
      throw new Error("Strategy knowledge import requires an absent, isolated destination namespace.");
    }
    await mkdir(dirname(parent), { recursive: true });
    const stage = await mkdtemp(join(dirname(parent), `.strategy-import-${randomUUID()}-`));
    const projectsRoot = join(stage, "projects");
    const globalRoot = join(stage, "global");
    let published = false;
    try {
      const write = async (directory: string, candidateId: string, value: unknown) => {
        if (!ID.test(candidateId)) throw new Error("Invalid artifact identity.");
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, `${candidateId}.json`), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
      };
      for (const p of snapshot.projects) {
        const root = join(projectsRoot, p.projectId);
        for (const c of p.revisionCandidates) await write(join(root, STRATEGY_CANDIDATE_DIRECTORY_NAME), c.candidateId, c);
        for (const d of p.revisionDecisions) await write(join(root, STRATEGY_DECISION_DIRECTORY_NAME), d.candidateId, d);
        for (const c of p.derivationCandidates) await write(join(root, STRATEGY_DERIVATION_CANDIDATE_DIRECTORY_NAME), c.candidateId, c);
        for (const d of p.derivationDecisions) await write(join(root, STRATEGY_DERIVATION_DECISION_DIRECTORY_NAME), d.candidateId, d);
      }
      for (const c of snapshot.global.scopeCandidates) await write(join(globalRoot, STRATEGY_SCOPE_CANDIDATE_DIRECTORY_NAME), c.candidateId, c);
      for (const d of snapshot.global.scopeDecisions) await write(join(globalRoot, STRATEGY_SCOPE_DECISION_DIRECTORY_NAME), d.candidateId, d);
      for (const c of snapshot.global.synthesisCandidates) await write(join(globalRoot, STRATEGY_SYNTHESIS_CANDIDATE_DIRECTORY_NAME), c.candidateId, c);
      for (const d of snapshot.global.synthesisDecisions) await write(join(globalRoot, STRATEGY_SYNTHESIS_DECISION_DIRECTORY_NAME), d.candidateId, d);
      await mkdir(projectsRoot, { recursive: true });
      await mkdir(globalRoot, { recursive: true });
      const staged = new FileStrategyKnowledge({ projectsBaseDir: projectsRoot, globalBaseDir: globalRoot });
      await Promise.all(snapshot.projects.map((p) => staged.projectTrust.readProjectId(p.projectId)));
      // Global decisions must also be checked when no project is present.
      const { loadUserGlobalTrustedDerivedStrategyProjection } = await import("./strategy-trust-scope-global.ts");
      await loadUserGlobalTrustedDerivedStrategyProjection({ candidateReader: staged.scopeCandidates,
        decisionReader: staged.scopeDecisions, sourceResolver: staged.sourceResolver,
        synthesisCandidateReader: staged.synthesisCandidates, synthesisDecisionReader: staged.synthesisDecisions });
      if (await exists(parent)) throw new Error("Strategy destination appeared during import.");
      await rename(stage, parent);
      published = true;
    } finally {
      if (!published) await rm(stage, { recursive: true, force: true });
    }
  }
}
