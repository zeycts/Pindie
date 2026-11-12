# S3 P1 stage 1: isolated exception regressions

Baseline: merged P0 (`a8a4347`, PR #319). This stage adds tests, not a new
Control protocol or a recovery mechanism. Production is not a test fixture.

## Coverage inventory and selection

| Risk | Existing evidence | Minimal addition in this stage |
| --- | --- | --- |
| Error / cancellation / missing terminal result mistaken for success | `control-client.test.ts`: terminal error/lost output/abort, unterminated assistant → `no_result`, unconsumed followUp → `cancelled`; controlled Session events | Real HTTP → workspace → Host → pinned Pi continuation first completes a block, then records an error: same Run, final `error`, sanitized diagnostic, unchanged active/pending Task meaning |
| Stop loses queued work or silently replays it | Mocked Control stop clears queues before abort; P0 native happy-path busy steer | Real MCP stop aborts the provider signal, cancels the Run and identical queued steer/followUp, reports both cleared counts, and does not add a provider call |
| Identical steer/followUp text borrows another input's identity | S1/S2 mock FIFO tests for identical steer, identical followUp and cross-queue priority | Real native queue boundary: steer is `running` while identical followUp remains `queued`; each receipt stays distinct through consumption and terminal completion |
| Accepted versus unknown delivery / delayed acknowledgement | S2 mock tests: native delivery followed by acknowledgement failure, rejected execution after output, unconfirmed identical text, acknowledgement after settlement, Gate-answer uncertainty; MCP delegation preserves the receipt | Retain these targeted tests, do not duplicate artificial acknowledgement faults inside native Pi or claim real transport loss was tested |
| Session replacement / stale authority | Control mocks cover replacement with reused native Session ID, invalidation during discovery and failed rebind; native headless tests cover fresh binding | Real HTTP rejects fresh Session while work/queues exist (`unsafe_runtime_state`), allows fresh after cancellation, clears old dispatch epoch, rejects old-lease input/wait/stop with no provider call |
| Human Gate / quota waiting / timeout conflation | Control mocks cover Gate response/preflight, immediate `human_gate`, timeout, quota wait/cancel/abandonment/resume anchors and unrelated errors; headless Presentation tests cover quota status reconciliation | No duplicate quota harness. New native continuation-error test times out without redispatch before settling as `error`; P0 already checks two timeout reads before native settlement |

The three new tests live beside P0 in `tests/control-mcp-p0.test.ts` to reuse its
existing isolated fixture without extracting a second harness. No existing test
is removed, skipped or filtered from the full suite. No product-code change is
justified by these passing additions.

## Evidence boundaries

**Real native events:** HTTP transport, workspace selection, Host, Control,
PiRuntimeAdapter, pinned Pi loop, queue consumption, abort and Session replacement
are real. The tests do not fabricate `agent_start`, `message_end` or
`agent_settled`. The fixture controls faux-provider messages/latency and an
extension `agent_end` barrier. Task/verification State is seeded in fixture-local
storage; auth, preferences and Sessions are isolated. These are local integration
tests, not real-provider failure, authenticated tunnel or public-network E2E.

**Mocked environment:** missing/lost terminal events (`no_result`), uncertain or
late acknowledgement, Gate and quota incident transitions remain the deliberate
mocked scenarios listed above. Those tests establish deterministic projection
and safety contracts, not the probability or transport behavior of a real
incident. Neither a quota exhaustion experiment nor the separate quota
source/freshness workstream is part of this stage.

## Status and safest client action

| Dispatch state | Meaning / client action |
| --- | --- |
| `accepted` | Receipt exists but no Run/queue attachment is observed yet; it is not proof of consumption or completion. Observe/wait on that receipt; do not replay. |
| `queued` | Acknowledged input remains in Pi's queue; do not send a duplicate to make it run sooner. |
| `running` | Attached execution has not settled, including native boundary continuation; a `complete` assistant block does not settle the Run. |
| `complete` | Recorded terminal completion and settled execution; not proof the durable Task is done or verification passed. |
| `error` | Recorded terminal or native execution failure; inspect the sanitized result, do not automatically retry consequential work. `wait.reason=settled` can accompany this state. |
| `cancelled` | Run aborted or input was left unconsumed; no success claim. Decide explicitly whether any new work is needed rather than replaying the old batch. |
| `no_result` | No confirmed recorded terminal completion/delivery; do not infer success or failure of external side effects. Reconcile facts before deciding on another attempt. |
| `waiting` | Current Human Gate/quota protection, not queue consumption or successful completion. Resolve the actual condition, not by dispatching duplicate input. |

A `delivery_uncertain` error can retain a dispatch receipt: use it to reconcile
with observe/wait/timeline. If the full response was lost, there is no idempotency
key or exactly-once guarantee. Repeated text is a new input, not deduplication.
A timeout is a read deadline, not cancellation or permission to resend.

For `stale_control_lease`, stop using the old lease, observe the active binding,
and reconcile Session identity and available timeline first. Old-epoch receipts
are not automatically migrated to a fresh Session; obtaining its new lease is
**not** permission to replay old uncertain or queued work.

`human_gate` is an explicit wait reason; quota protection keeps work `waiting`
and prevents settled success, while a bounded wait can still return `timeout`.
Task status and verification status remain separate from all these execution
states, including error and cancellation.

## Delivery boundary

Run focused Control/MCP/headless tests, typecheck and the unfiltered full check;
record actual results and exact-head CI in the Draft PR. Self-review does not
substitute for the user's later independent review. Do not merge, update the
production checkout, restart services, or remove the retained P0 worktree.
