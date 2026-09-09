# Composable Pindie Architecture v0.1

Status: implemented architecture contract; Composable Pindie Architecture v0.1 and Slices A–F are complete.

This document remains the single architecture source of truth for the implemented v0.1 composition boundary. The final implementation uses startup-time explicit feature selection and supported Session/resource reconstruction boundaries; it is not a generic Plugin System.

Final v0.1 selection rules:

- Core always assembles; Self-Improvement (SI), Cross-Project Learning (CPL), Remote, Work Memory, Presentation, and Bundled Skills are selected explicitly at startup.
- SI, CPL, Bundled Skills, and Presentation preserve their existing defaults; Remote and Work Memory remain conditional on their complete environment or injected transport-independent dependency.
- SI off implies CPL off; explicitly requesting CPL while SI is off is rejected with a clear diagnostic.
- CPL workflow and global presentation are absent when CPL is off, but the shared user-global trust-safety read and writer lock remain available to protect local SI trust writes.
- Feature attach/detach occurs only during startup or an already-supported Session/resource reconstruction boundary; v0.1 has no hot unload.

The compatibility closure verified the final composition matrix, disabled-feature absence, adapter independence, lifecycle boundaries, and final import direction without changing semantic State, Experience, trust artifacts, or schemas.

This contract changes how optional Pindie features are composed. It does **not** redesign Pindie's semantic authority model, Pi ownership, persisted State, Self-Improvement semantics, Cross-Project Learning trust semantics, Remote semantics, Long Task behavior, or Work Memory data contract.

## 1. Goal

Composable Pindie v0.1 establishes one bounded promise:

> Pindie uses startup-time explicit composition; Core does not depend on optional feature implementations; optional features attach through narrow interfaces; disabling or removing a feature does not break the base runtime or weaken persistent authority constraints.

For a new feature that reuses existing semantic primitives, the normal extension cost should be:

```text
new feature implementation + tests
        +
one explicit composition registration point
```

A feature that introduces new semantic authority or a new lifecycle primitive may still require an explicit Core change. v0.1 does not create a permission-extension escape hatch merely to make Core "never change".

## 2. Non-goals

v0.1 does **not** build:

- a generic Plugin System or Plugin SDK;
- runtime module discovery;
- manifests or dependency graphs;
- a DI framework;
- a lifecycle engine;
- a generic event bus;
- hot unload during an active Run;
- third-party untrusted-code isolation;
- package splitting;
- a second Pi runtime, Agent Loop, Session system, Skill runtime, or message queue;
- broad directory restructuring for cosmetic modularity.

Different features do not need to implement one universal `PindiePlugin` or `Module` interface.

## 3. Vocabulary and hard boundaries

### 3.1 Feature capability is not `PindieCapability`

In this document, an **optional feature** is a product/runtime unit such as Self-Improvement or Remote.

The existing `PindieCapability` vocabulary is semantic authorization, for example:

```text
task.start
project.mutate
policy.derive
memory.capture
```

They remain separate concepts:

- feature selection decides what is assembled;
- semantic capability decides whether an action is legal;
- enabling a feature never grants semantic authority by itself;
- disabling a feature never revokes or rewrites existing durable facts.

### 3.2 Attach/detach is a startup boundary operation

v0.1 lifecycle:

```text
selection
  → construct selected features
  → register Pi tools / commands / prompt contributions / lifecycle wiring
  → run
  → Session shutdown or supported resource rebuild
```

Changing the selection takes effect through restart or an already-supported Session/resource reconstruction boundary.

v0.1 does not unload a feature during an active Run and does not migrate in-flight tool calls, Trial leases, or Remote callbacks.

### 3.3 Disable means the feature is actually absent

When an optional feature is disabled:

- its tools and commands are not registered;
- its prompt contribution is absent;
- its background work and external connections do not start;
- its feature-specific stores are not constructed;
- executable stale leases are not retained;
- historical durable data is not deleted or rewritten.

Shared safety/authority validation is not automatically optional merely because a feature UI or workflow is disabled.

### 3.4 Removing code is not deleting historical data

Removing or disabling a feature must not implicitly migrate, delete, or rewrite existing Candidate, Decision, Experience, Remote routing, Memory, or trust artifacts.

## 4. Implemented architecture

```text
                           Pindie Host
                               │
                 ┌─────────────┴─────────────┐
                 ▼                           ▼
          Pi Runtime Adapter          Composition Selection
          InteractiveMode                    │
          Session ownership                  ▼
                                   src/composition.ts
                            explicit construct / inject / wire
                                     │
                 ┌───────────────────┼─────────────────────┐
                 ▼                   ▼                     ▼
            Core Integration     Optional Features     Pi Resources
                 │                   │                     │
      ┌──────────┼──────────┐    ┌───┴──────────────┐      Skills
      ▼          ▼          ▼    ▼                  ▼
    State     Execution    Run   Self-Improvement   Remote
    Runtime   Gateway      Facts ├─ Experience      ├─ RemoteSurface
    Reducer   Freshness           ├─ Adapt/Derive    └─ RemotePi
    Snapshot  Evidence            ├─ Trial
                                 ├─ Local Decisions
      Context / Task / Gate      └─ Strategy Trust Services
      Base Policy / Seeds                 ▲
      Continuation                        │ narrow explicit interfaces
                                          │
                                 Cross-Project Learning

                                 Work Memory → ProjectMemorySink
                                 Presentation → read-only facts
```

Dependency direction:

```text
Composition → Core + feature implementations

Feature → Core ports / stable value types
Core    ✗→ feature implementations

CPL → SI public narrow interfaces
SI  ✗→ CPL implementation
```

The Host and Pi adapter are platform infrastructure. They do not need to pretend to be Core plugins.

## 5. Core boundary

"Core" means the minimum product that still runs correctly with optional features absent. It does not mean the fewest possible files.

### 5.1 Core includes

- durable Task semantics and State invariants: `state.ts`, `transitions.ts`;
- Snapshot and authorization derivation: `semantics.ts`, `run-facts.ts`;
- State load/refresh/locking/save publication responsibilities from `runtime.ts` / `store.ts`;
- Execution Gateway, tool effects, mutation invalidation: `execution-semantics.ts`, `execution-integration.ts`, `project-mutation.ts`;
- verification provenance: `verification-evidence.ts`;
- Task, Gate, Verification, and Git observation tools;
- Run identity/coherence/authoritative settlement bookkeeping;
- base context contract, baseline, causal update, checkpoint behavior;
- Seed Policy and base Policy semantics: `policy.ts`, `strategies.ts`, base `tools/policy.ts` behavior;
- current continuation rules.

### 5.2 Core excludes

- Candidate/Decision file loading;
- Adapt/Derive/Trial business leases;
- global portfolio reconstruction;
- Experience persistence;
- Discord or Notion SDK adapters;
- learning-result queries and learning command presentation;
- bundled Skill content;
- optional feature configuration parsing.

### 5.3 Base Policy remains Core

Seed Policy remains available without Self-Improvement.

With SI disabled:

- Seed shorthand remains usable;
- learned exact selectors are unavailable;
- adaptation/derivation/trial commands are absent;
- historical learned Policy data remains untouched.

An unavailable learned selector must fail explicitly. It must not silently fall back to a Seed.

## 6. Optional features in v0.1

The first selectable features are:

| Feature | Owns | Disabled behavior |
| --- | --- | --- |
| Self-Improvement (SI) | Experience persistence/evaluation, Adapt, Derive, Trial, local promotion, learned queries/selectors | no new learning records, learning commands, or learned selector resolution |
| Cross-Project Learning (CPL) | trust transfer, scope Trial/review/promotion, cross-project Experience review, normal global display | no CPL commands, scope workflow, or normal global display |
| Remote | Remote Companion, Discord transport, Session mirror wiring | no Discord connection or Remote hooks |
| Work Memory | memory tool, Memory prompt contribution, sink construction | no capture tool or Notion work |
| Bundled Skills | Pindie-added Skill paths | Pindie does not append its bundled paths; user/Pi-native Skills are unaffected |
| Presentation | custom status/efficiency/subscription/reasoning UI wiring | Pi base presentation/native thinking remains |

Experience remains owned by SI in v0.1. Do not split it into a seventh product feature without a concrete independent use case.

The following are **not** made optional in v0.1:

- Pi runtime;
- State / Gateway / Verification;
- Task continuity / Long Task rollover;
- Host Task metrics correctness.

Long Task may be separable later, but v0.1 must not opportunistically refactor it.

## 7. Measurements are not Presentation

Current measurement/tracker ownership must become independent of UI ownership:

```text
Run measurements / Host TaskMetrics
       ├→ Task completion summary
       ├→ SI Experience observer
       └→ Presentation
```

Retain the existing trackers where practical; change ownership/injection direction, not metric meaning.

Disabling Presentation must not disable Task measurement or change Task completion semantics.

## 8. Composition root

### 8.1 One explicit production composition owner

The composition root is:

```text
src/composition.ts
```

Existing `extension.ts` entry points remain compatible, but production default construction moves to composition.

Implemented responsibilities:

```text
extension.ts
  → public/compatibility entry points
  → delegates production assembly

composition.ts
  → resolve feature selection
  → construct explicit storage roots and production dependencies
  → construct Core
  → construct only selected feature implementations
  → inject narrow dependencies
  → wire startup registration
```

Extracted Core integration must never import `composition.ts`.

`composition.ts` is a **composition root**, not a business-logic monolith. It selects, constructs, and wires. Feature-specific business construction remains in feature-specific factories/integration code.

### 8.2 Use ordinary factories

Illustrative shape only:

```ts
const core = createCoreIntegration(coreDependencies);

const si = selection.selfImprovement
  ? await createSelfImprovement(siDependencies)
  : undefined;

const cpl = si && selection.crossProjectLearning
  ? await createCrossProjectLearning({
      learning: si.learningAccess,
      trust: si.trustAccess,
      ...cplDependencies,
    })
  : undefined;

wireCore(core, {
  learning: si?.runIntegration,
  policyResolver: si?.policyResolver,
});

if (cpl) si.attachCrossProject(cpl);

if (selection.remote) {
  await attachRemote(remotePorts, remoteDependencies);
}
```

Factories may have different argument shapes. Do not introduce a universal module interface merely for symmetry.

### 8.3 Production defaults belong to composition

Feature factories must not silently manufacture production defaults such as:

```ts
reader ?? new FileReader()
```

Production composition owns default concrete implementations. Tests pass fakes explicitly.

Make storage/dependency ownership explicit, including where relevant:

- project storage base;
- user-global storage base;
- shared writer lock;
- Remote routing store;
- Memory sink.

Do not infer feature storage roots from `stateStore instanceof FileStateStore` or another concrete Store type.

### 8.4 Disabled adapters must not be load requirements

When Remote or Work Memory is disabled, the corresponding adapter must not be loaded as a hidden Core dependency.

Merely skipping `new DiscordRemote()` is insufficient if Core still statically imports a Discord adapter whose package must resolve at startup.

Implementation must respect Pi's actual resource-factory/loading contract; do not assume a hot-unload API exists.

## 9. Dependency rules

### Allowed

Optional features may:

- import stable State/Snapshot/value types;
- read immutable current-fact projections;
- use narrow Pi adapters;
- submit startup tool declarations/effects to the one Core Gateway path;
- own and use their own readers/stores;
- call another feature only through an explicitly declared narrow dependency.

### Forbidden

Optional features must not:

- receive the entire `PindieExtensionIntegration`;
- receive a mutable `PindieRuntime` merely to dispatch/unload arbitrarily;
- write Run authority or evidence generation directly;
- set semantic capabilities directly;
- retain a stale mutable ExtensionContext across authority generations;
- inspect another feature's lease through a shared mega-context;
- cause Core to dynamically import a feature as fallback;
- bypass the Execution Gateway for consequential tools.

These are code-ownership boundaries, not a security sandbox against malicious extension code.

## 10. Shared runtime/state exposure

Do not replace current coupling with a new giant `CapabilityContext`.

Inject per-consumer functions/value projections.

### 10.1 State/Run facts

Where SI needs current authority, prefer narrow operations shaped around facts, for example:

```text
getCurrentRunBinding()
readCurrentAuthority()
refreshCurrentAuthority(binding)
isCurrent(binding)
```

A binding must distinguish at least:

```text
project root + Session identity + Run generation
```

Cross-feature values must be immutable snapshots. TypeScript `Readonly<T>` alone is not runtime isolation; freeze/copy where the boundary requires it.

### 10.2 Remote

Prefer existing narrow surfaces such as:

```text
RemotePi
RemoteStatusFacts
RemoteSurface
```

Remote does not need the Task reducer or Experience store. Inputs continue through the same native Pi Session (`user`, `steer`, `follow-up`, `abort`).

### 10.3 Work Memory

Continue the existing narrow inputs:

```text
getProjectRoot
getState        # read-only projection
now
ProjectMemorySink
```

Do not create a global memory manager for one external capture feature.

### 10.4 Self-Improvement

SI owns:

- `AdaptationRuntime`;
- `DerivationRuntime`;
- `TrialRuntime`;
- Candidate/Decision readers;
- the learned part of Policy selector resolution;
- Experience tracking/persistence.

Core consumes only the narrow results it actually needs:

1. Run control restriction: normal execution vs explicit SI read-only Run;
2. learned exact Policy-selector resolution;
3. a settlement observer that receives frozen facts and does not mutate Core authority.

### 10.5 Settlement order remains explicit

Do not create an event-priority system. Preserve the current transactional order explicitly:

```text
refresh authority
→ freeze State / Run / Policy / measurement facts
→ SI records Experience (non-fatal observer failure)
→ clear Trial lease
→ continuity checkpoint / Host rollover publication
→ clear Core Run bookkeeping
→ Remote/final read-only projection
```

Read-only observer failure may be isolated. SI authorization/selector revalidation failure must reject the relevant action and must not be treated as an ignorable optional callback failure.

## 11. Feature selection

Use startup-time explicit booleans. Do not create a feature configuration database.

Illustrative selection:

```ts
{
  selfImprovement: true,
  crossProjectLearning: true,
  remote: false,
  workMemory: false,
  bundledSkills: true,
  presentation: true,
}
```

Production defaults preserve current behavior:

- SI, CPL, bundled Skills, and Presentation default on;
- Remote and Work Memory follow their existing complete-environment/configuration conditions;
- an explicit off takes precedence over available credentials/configuration.

CLI/host configuration may expose corresponding `PINDIE_*_ENABLED` switches if this fits the existing configuration surface. Do not persist feature enablement as semantic State.

Dependency behavior:

```text
SI off + CPL unspecified
  → CPL off

SI off + CPL explicitly on
  → reject CPL assembly with a clear diagnostic
  → Core remains startable
```

Never silently re-enable SI or pretend CPL is enabled.

Bundled-Skills selection controls only Pindie Host-added Skill paths. It cannot retract Skills already discovered through Pi-native package/resource loading.

## 12. CPL depends on SI, but trust safety is not optional

Express the product dependency directly:

```text
Cross-Project Learning requires Self-Improvement
```

No generic dependency graph is needed.

CPL receives only dedicated SI interfaces, conceptually:

```text
CPL factory
  → SI LearningAccess
  → SI StrategyTrustAccess
```

CPL must not receive the entire SI implementation.

SI retains the unified `/trial`, `/trial-review`, `/promote`, and `/reject` command entry points. CPL provides scope-specific handlers wired once at startup. Do not create duplicate commands or a global command router.

### 12.1 Critical safety boundary

**CPL off does not mean global authority ceases to exist.**

This is an intentional compatibility exception, not accidental CPL business I/O: when CPL is disabled, SI may still read the minimum shared user-global trust authority and use the shared user-level writer lock required to make local trust writes safe. Disabling CPL removes CPL workflow and normal global presentation, but it never relaxes these authority constraints.

Local Derived promotion must continue to:

- check conflicting global identity/ID authority;
- revalidate/write under the shared user-level writer lock;
- fail closed on malformed relevant global authority.

Never implement "CPL off" by injecting an empty global catalog into local promotion.

The minimum cross-scope trust consistency mechanism is a shared SI trust substrate, not CPL product behavior.

The shared trust substrate includes:

- immutable artifact validation;
- identity / manifest / fingerprint rules;
- local/global collision validation;
- strict source binding;
- shared writer lock.

It does **not** include:

- `/trust-transfer`;
- scope Trial Runs;
- cross-project Experience review;
- Scope Candidate/Decision creation workflows;
- normal global selector display.

Therefore, with CPL disabled:

| Behavior | Result |
| --- | --- |
| CPL commands / scope Trial | absent |
| normal global selector display | absent |
| global authority safety constraints on local trust writes | still enforced |
| existing artifacts | unchanged |
| malformed relevant global authority | blocks the related trust action, not ordinary coding |

SI may still perform the minimum global safety read needed for a trust write. Do not claim that `CPL off` implies zero reads of user-global trust data.

If that safety substrate is also intentionally removed, the only safe degradation is to disable trust writes that depend on it; never relax authorization.

### 12.2 Break the existing trust dependency cycle narrowly

Separate pure portfolio identity/manifest rules from storage-loading responsibility.

Move base artifact read/validation currently coupled through scope-Trial code into the trust substrate.

Implemented dependency direction:

```text
Candidate / Decision validators
        ↓
pure trust value rules

local/global trust loaders
        ↓
validators + readers

Trial / Review / Promotion
        ↓
trust loaders
```

Do not change fingerprint algorithms, artifact schemas, or historical identity.

## 13. Preventing a new central monolith

### 13.1 Keep tool declaration facts together at composition time

The final implementation keeps tool registration and classification in the existing Core and feature integration points, assembled only at startup. Each selected integration contributes only its existing semantics:

```text
tool definition
+ required existing semantic capability
+ project-mutation effect
+ existing telemetry category
+ prompt contribution
```

The single Core Execution Gateway authorizes the resulting calls for the current Run.

This is **not** a generic runtime registry:

- built only at startup;
- not persisted;
- no runtime add/remove;
- Core-tool name collisions/overrides are rejected;
- unknown tools retain the current conservative fallback;
- a feature declaration cannot mint semantic capabilities or self-authorize a call;
- the single Execution Gateway remains authoritative.

### 13.2 Keep lifecycle integration small and explicit

- independent Remote projection/input may continue to use Pi-native hooks;
- Run-start, authorization, and settlement behavior that needs deterministic Core ordering uses a small number of fixed call points;
- no arbitrary priority, before/after dependency graph, or dynamic subscription system.

### 13.3 Protect boundaries with dependency tests

Focused checks should prove at least:

- Core imports no SI/CPL/Discord/Notion implementation;
- SI has no reverse dependency on CPL business modules;
- the targeted trust runtime SCC disappears;
- Core-only assembly does not open feature stores;
- removing a feature registration does not prevent Core modules from loading;
- disabled tools/commands/prompt contributions are absent.

## 14. Implemented scope record

This is a bounded migration, not a directory rewrite.

Implemented ownership and wiring boundaries:

| Existing area | Implemented boundary |
| --- | --- |
| `src/extension.ts` | separate Core wiring from feature wiring; preserve compatibility entry points |
| `src/host.ts` | pass selection and explicit storage dependencies; append bundled Skills conditionally |
| `src/run-integration.ts` | separate SI Experience ownership from Run authority |
| `src/presentation-integration.ts` | stop owning base measurements; move learning queries back to SI |
| `src/execution-semantics.ts` | accept startup tool-effect declarations while preserving one Gateway and conservative fallback |
| `src/run-experience.ts` | consume unified telemetry classification; preserve schema-v4/counting semantics |
| `src/context.ts` | separate base contract from optional prompt contributions |
| `src/strategy-portfolio.ts` | separate pure trust value rules from local/global loading |
| derivation Candidate/Decision code | depend on pure trust rules, not business-cycle loaders |
| `src/strategy-trial.ts` / candidate commands | SI keeps unified entry points; CPL injects scope business handlers |
| scope trust modules | separate base artifact validation from scope-Trial business logic |
| `src/tools/policy.ts` | accept an optional learned-selector resolver while preserving Seed behavior |
| Remote implementation | keep behavior; move adapter construction/wiring outward |
| Memory implementation | keep narrow existing interfaces |
| extension/host/integration tests | add composition isolation and compatibility coverage |

The implementation keeps new files few and responsibility-driven:

- `src/composition.ts`;
- Core integration/ports file(s) only where needed;
- SI integration file(s) only where needed;
- CPL integration file(s) only where needed;
- pure trust-rules file(s) only where needed.

Do not pre-create `domain/services/runtime/registry` directory hierarchies for every feature.

## 15. Implemented Slice record

Composable Pindie Architecture v0.1 was implemented strictly Slice by Slice. Slices A–F are complete and were reviewed against this contract; Slice F is the final compatibility closure.

### Slice A — Explicit composition and dependency isolation

Scope:

- introduce feature selection;
- make storage roots and production dependency construction explicit;
- establish one production composition owner;
- preserve current full-feature behavior.

Done when:

- current HOME and isolated-HOME behavior/tests remain equivalent;
- feature factories do not implicitly access real production defaults in the paths Slice A makes explicit;
- default startup behavior is unchanged;
- learning/feature paths are no longer inferred from concrete `StateStore` type checks.

Do not extract the full Core boundary in Slice A.

### Slice B — Extract Core and basic narrow interfaces

Scope:

- make Core independently loadable;
- converge Run facts, measurements, tool effects, prompt contributions, and settlement ports.

Done when:

- Core imports no learning, Discord, or Notion implementation;
- Core-only can perform Task, execution, verification, Gate, and Seed/base Policy behavior;
- base measurement does not depend on Presentation;
- mutation freshness, evidence, and continuation behavior remain unchanged;
- no generic event bus or permission-extension platform appears.

### Slice C — Close the simple optional-feature boundaries

Scope:

- Remote;
- Work Memory;
- Presentation;
- bundled Skills.

Done when:

- disabling each removes its tools/commands/prompt/background/external work as applicable;
- disabled Remote/Notion adapters are not loaded;
- Remote still controls the same native Pi Session and preserves generation/cursor/settlement ordering;
- bundled-Skills selection affects only Host-added paths;
- Session reconstruction does not duplicate registration or leak connections.

### Slice D — Independently assemble Self-Improvement

Scope:

- SI owns learning commands, leases, learned Policy resolution, and Experience;
- Core consumes SI only through narrow ports.

Done when:

- SI off leaves Seed Policy and ordinary coding functional;
- SI off does not read Candidate/Decision/Experience stores;
- SI on preserves Adapt/Derive/Trial exclusion and invalidation rules;
- schema-v4 attribution and counting semantics remain compatible;
- Experience settlement still occurs before continuity/rollover publication;
- learning queries no longer depend on Presentation.

### Slice E — CPL boundary and trust-cycle removal

Scope:

- CPL becomes an optional feature that explicitly requires SI;
- shared trust substrate is separated from CPL workflow behavior;
- the targeted runtime dependency cycle is removed.

Done when:

- SI-only has no scope commands or normal global display;
- CPL on reuses the same Trial lease and unified commands;
- CPL off does not bypass global collision checks or the shared writer lock;
- malformed relevant global authority still blocks only the related trust action;
- fingerprint, artifact schema, and trust identity are unchanged;
- the verified trust runtime dependency cycle is gone.

### Slice F — Composition compatibility closure (complete)

The final verification covered:

```text
Core only
Core + SI
Core + SI + CPL
Core + Remote
Core + Work Memory
default full-feature composition
SI off + CPL explicitly on
Session replacement / reload / shutdown
```

Done when:

- every disabled feature has tests proving absence of registration, prompt injection, and feature business I/O;
- the trust-safety-read exception has dedicated tests/documentation;
- Core-only loads when disabled adapter packages are not required;
- default composition passes `pnpm run check`;
- no State/Experience/trust data migration is introduced;
- current architecture/behavior documentation and `AGENTS.md` are synchronized with the implemented final state.

## 16. Explicitly unchanged semantics

Across all Slices, do not redesign:

- `PindieState` shape or Reducer invariants;
- Task / Gate / Verification legality;
- Pi's Agent Loop, tool execution, Session ownership, or Skill runtime;
- continuation or compaction behavioral contracts;
- Long Task rollover algorithm or Host bridge;
- Experience schema-v4;
- Candidate/Decision schema, fingerprint, or trust identity;
- local/global promotion shared locking and fail-closed behavior;
- Discord routing, cursor, and same-Session control semantics;
- Notion/Work Memory capture data contract;
- historical durable files.

Necessary wiring changes are allowed. They must not become behavior redesigns.

## 17. Primary risks

1. **Treating authority validation as an optional product feature.** CPL off must never bypass global trust constraints.
2. **Changing lifecycle ordering.** Multiple independent Pi callbacks do not automatically preserve current transactional order.
3. **Hiding UI instead of disabling a feature.** Check imports, stores, prompts, completion hooks, external connections, and background queries—not only tool registration.
4. **Replacing one large context with another.** Inject consumer-specific functions/facts, not a mega-context containing runtime, Pi, readers, and trackers.
5. **Turning feature tool declarations into an authorization backdoor.** Declarations cannot grant semantic capability; unknown tools remain conservative; Core tools cannot be overridden.
6. **Silently changing learned Policy behavior when SI is off.** Learned selectors become unavailable explicitly; they do not fall back to Seeds.
7. **Equating green tests with removability.** Also test disabled-adapter absence, Core-only import graph, and real/isolated HOME boundaries.
8. **Overstating configuration scope.** Host feature selection and Pi-native package/resource loading are different layers.

## 18. Review and maintenance rule

For the completed v0.1 implementation:

1. treat this document as the current architecture contract for the composability boundary;
2. preserve the final feature-selection, trust-safety, lifecycle, and dependency-direction invariants;
3. add focused tests for any explicitly approved compatibility change;
4. run `pnpm run check` and the relevant isolated composition checks;
5. do not treat the v0.1 boundary as a Plugin SDK, registry, lifecycle engine, or permission-extension platform.

The purpose of v0.1 is not to make every subsystem look like a plugin. It is to establish a small, testable composition boundary that lets Pindie grow without turning optional features into Core coupling.