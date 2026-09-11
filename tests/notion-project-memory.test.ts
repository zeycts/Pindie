import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  NOTION_PROJECT_MEMORY_API_VERSION,
  NotionProjectMemorySink,
  notionProjectMemoryConfig,
  type NotionProjectMemoryClient,
} from "../src/notion-project-memory.ts";
import {
  createProjectMemoryCapture,
  type ProjectMemoryCapture,
  type ProjectMemorySemanticInput,
} from "../src/project-memory.ts";

interface FakePageOptions {
  readonly id?: string;
  readonly memory?: string;
  readonly scope?: string;
  readonly type?: string;
  readonly status?: string;
  readonly date?: string;
  readonly source?: readonly string[];
  readonly evidence?: string;
  readonly body?: string;
}

interface FakeCall {
  readonly method: string;
  readonly args: Record<string, any>;
}

class FakeNotionClient {
  readonly calls: FakeCall[] = [];
  readonly queryResults: unknown[] = [];
  readonly bodies = new Map<string, string>();
  readonly failures = new Set<string>();
  readonly gates = new Map<string, Promise<void>>();
  readonly afterCalls = new Map<string, () => void>();
  #created = 0;

  readonly dataSources = {
    query: async (args: Record<string, any>) => {
      this.calls.push({ method: "query", args });
      const gate = this.#gate("query");
      if (gate !== undefined) await gate;
      this.#fail("query");
      const result = {
        object: "list",
        type: "page_or_data_source",
        page_or_data_source: {},
        results: this.queryResults,
        has_more: false,
        next_cursor: null,
      };
      this.#afterCall("query");
      return result;
    },
  };

  readonly pages = {
    create: async (args: Record<string, any>) => {
      this.calls.push({ method: "create", args });
      const gate = this.#gate("create");
      if (gate !== undefined) await gate;
      this.#fail("create");
      this.#created += 1;
      const result = { object: "page", id: `created-${this.#created}` };
      this.#afterCall("create");
      return result;
    },
    update: async (args: Record<string, any>) => {
      const superseding = args.properties?.Status?.select?.name === "Superseded";
      const method = superseding ? "supersede" : "updateProperties";
      this.calls.push({ method, args });
      const gate = this.#gate(method);
      if (gate !== undefined) await gate;
      this.#fail(method);
      const result = { object: "page", id: args.page_id };
      this.#afterCall(method);
      return result;
    },
    retrieveMarkdown: async (args: Record<string, any>) => {
      this.calls.push({ method: "retrieveMarkdown", args });
      const gate = this.#gate("retrieveMarkdown");
      if (gate !== undefined) await gate;
      this.#fail("retrieveMarkdown");
      const result = {
        object: "page_markdown",
        id: args.page_id,
        markdown: this.bodies.get(args.page_id) ?? "",
        truncated: false,
        unknown_block_ids: [],
      };
      this.#afterCall("retrieveMarkdown");
      return result;
    },

    updateMarkdown: async (args: Record<string, any>) => {
      this.calls.push({ method: "updateMarkdown", args });
      const gate = this.#gate("updateMarkdown");
      if (gate !== undefined) await gate;
      this.#fail("updateMarkdown");
      const result = {
        object: "page_markdown",
        id: args.page_id,
        markdown: args.replace_content.new_str,
        truncated: false,
        unknown_block_ids: [],
      };
      this.#afterCall("updateMarkdown");
      return result;
    },
  };

  asClient(): NotionProjectMemoryClient {
    return this as unknown as NotionProjectMemoryClient;
  }

  addPage(options: FakePageOptions = {}): void {
    const id = options.id ?? `page-${this.queryResults.length + 1}`;
    this.queryResults.push({
      object: "page",
      id,
      properties: {
        Memory: titleProperty(options.memory ?? "Use the domain port"),
        Scope: richTextProperty(options.scope ?? "Pindie"),
        Type: selectProperty(options.type ?? "Decision"),
        Status: selectProperty(options.status ?? "Active"),
        Date: { type: "date", date: { start: options.date ?? "2026-08-01" } },
        Source: {
          type: "multi_select",
          multi_select: (options.source ?? ["Pindie"]).map((name) => ({ name })),
        },
        Evidence: richTextProperty(options.evidence ?? "Architecture approval"),
      },
    });
    this.bodies.set(id, options.body ?? controlledBody());
  }

  #gate(method: string): Promise<void> | undefined {
    return this.gates.get(method);
  }

  #afterCall(method: string): void {
    this.afterCalls.get(method)?.();
  }

  #fail(method: string): void {
    if (this.failures.has(method)) throw new Error(`secret raw ${method} response`);
  }
}

function titleProperty(value: string) {
  return { type: "title", title: [{ plain_text: value }] };
}

function richTextProperty(value: string) {
  return { type: "rich_text", rich_text: [{ plain_text: value }] };
}

function selectProperty(value: string) {
  return { type: "select", select: { name: value } };
}

function controlledBody(options: {
  readonly summary?: string;
  readonly whyItMatters?: string;
  readonly consequence?: string;
} = {}): string {
  const sections = [
    `## Summary\n${options.summary ?? "A narrow sink is approved."}`,
    `## Why it matters\n${options.whyItMatters ?? "Persistence stays outside Pindie State."}`,
  ];
  if (options.consequence !== undefined) {
    sections.push(`## Consequence\n${options.consequence}`);
  }
  return sections.join("\n\n");
}

function capture(
  overrides: Partial<ProjectMemorySemanticInput> = {},
  evidence = "Architecture approval",
): ProjectMemoryCapture {
  return createProjectMemoryCapture({
    type: "decision",
    memory: "Use the domain port",
    summary: "A narrow sink is approved.",
    whyItMatters: "Persistence stays outside Pindie State.",
    ...overrides,
  }, {
    scope: "Pindie",
    source: "Pindie",
    date: "2026-09-05",
    evidence,
  });
}

function sink(fake: FakeNotionClient): NotionProjectMemorySink {
  return new NotionProjectMemorySink({
    client: fake.asClient(),
    dataSourceId: "data-source-1",
  });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function call(fake: FakeNotionClient, method: string): FakeCall {
  const found = fake.calls.find((entry) => entry.method === method);
  assert.ok(found, `Expected ${method} call`);
  return found;
}

test("Work Memory configuration is disabled without either environment variable", () => {
  assert.deepEqual(notionProjectMemoryConfig({}), { enabled: false });
});

test("incomplete Work Memory configuration is disabled with a bounded warning", () => {
  const token = "notion-token-secret";
  for (const env of [
    { PINDIE_NOTION_TOKEN: token },
    { PINDIE_WORK_MEMORY_DATA_SOURCE_ID: "data-source-1" },
    { PINDIE_NOTION_TOKEN: "  ", PINDIE_WORK_MEMORY_DATA_SOURCE_ID: "data-source-1" },
    { PINDIE_NOTION_TOKEN: token, PINDIE_WORK_MEMORY_DATA_SOURCE_ID: "  " },
  ]) {
    const result = notionProjectMemoryConfig(env);
    assert.equal(result.enabled, false);
    assert.equal(result.warning, "Pindie Work Memory is disabled: Notion configuration is incomplete.");
    assert.doesNotMatch(JSON.stringify(result), /notion-token-secret|data-source-1/);
  }
});

test("complete Work Memory configuration is enabled with trimmed values", () => {
  assert.deepEqual(
    notionProjectMemoryConfig({
      PINDIE_NOTION_TOKEN: "  notion-token-secret  ",
      PINDIE_WORK_MEMORY_DATA_SOURCE_ID: "  data-source-1  ",
    }),
    {
      enabled: true,
      config: { token: "notion-token-secret", dataSourceId: "data-source-1" },
    },
  );
});

test("no match creates one Active page in the data source", async () => {
  const fake = new FakeNotionClient();
  const result = await sink(fake).capture(capture());

  assert.deepEqual(result, { ok: true, outcome: "created" });
  assert.deepEqual(fake.calls.map(({ method }) => method), ["query", "create"]);
  assert.deepEqual(call(fake, "query").args.filter, {
    and: [
      { property: "Scope", rich_text: { equals: "Pindie" } },
      { property: "Status", select: { equals: "Active" } },
    ],
  });
  const created = call(fake, "create").args;
  assert.deepEqual(created.parent, { type: "data_source_id", data_source_id: "data-source-1" });
  assert.equal(created.properties.Status.select.name, "Active");
  assert.deepEqual(created.properties.Source.multi_select, [{ name: "Pindie" }]);
  assert.equal(created.markdown, controlledBody());
});

test("exact match with identical controlled content is a no-write duplicate", async () => {
  const fake = new FakeNotionClient();
  fake.addPage({ memory: "  Use the domain port  " });

  assert.deepEqual(await sink(fake).capture(capture()), { ok: true, outcome: "duplicate" });
  assert.deepEqual(fake.calls.map(({ method }) => method), ["query", "retrieveMarkdown"]);
});

test("provenance-only updates preserve shared Sources and identical Evidence", async () => {
  const fake = new FakeNotionClient();
  fake.addPage({ source: ["ChatGPT"] });

  assert.deepEqual(await sink(fake).capture(capture()), { ok: true, outcome: "updated" });
  assert.deepEqual(
    call(fake, "updateProperties").args.properties.Source.multi_select,
    [{ name: "ChatGPT" }, { name: "Pindie" }],
  );
  assert.equal(
    call(fake, "updateProperties").args.properties.Evidence.rich_text[0].text.content,
    "Architecture approval",
  );
  assert.equal(fake.calls.some(({ method }) => method === "updateMarkdown"), false);
});

test("provenance merge preserves and deduplicates every existing Source", async () => {
  const fake = new FakeNotionClient();
  fake.addPage({ source: ["Manual", "ChatGPT", "Manual"] });

  assert.deepEqual(await sink(fake).capture(capture()), { ok: true, outcome: "updated" });
  assert.deepEqual(
    call(fake, "updateProperties").args.properties.Source.multi_select,
    [{ name: "Manual" }, { name: "ChatGPT" }, { name: "Pindie" }],
  );
});

test("different Evidence appends provenance while an existing merged entry stays duplicate", async () => {
  const changed = new FakeNotionClient();
  changed.addPage({ source: ["Pindie"], evidence: "ChatGPT design record" });

  assert.deepEqual(
    await sink(changed).capture(capture({}, "Pindie verification")),
    { ok: true, outcome: "updated" },
  );
  assert.equal(
    call(changed, "updateProperties").args.properties.Evidence.rich_text[0].text.content,
    "ChatGPT design record\n\n---\n\nPindie verification",
  );

  const alreadyMerged = new FakeNotionClient();
  alreadyMerged.addPage({
    source: ["Pindie"],
    evidence: "ChatGPT design record\n\n---\n\nPindie verification",
  });
  assert.deepEqual(
    await sink(alreadyMerged).capture(capture({}, "Pindie verification")),
    { ok: true, outcome: "duplicate" },
  );
  assert.deepEqual(
    alreadyMerged.calls.map(({ method }) => method),
    ["query", "retrieveMarkdown"],
  );
});

test("changed settled content updates the same page and preserves its original Date", async () => {
  const fake = new FakeNotionClient();
  fake.addPage({ id: "existing-page", date: "2026-07-10" });
  const changed = capture({
    summary: "The adapter contract is now settled.",
    consequence: "Use the official Data Source API.",
  });

  assert.deepEqual(await sink(fake).capture(changed), { ok: true, outcome: "updated" });
  assert.deepEqual(fake.calls.map(({ method }) => method), [
    "query",
    "retrieveMarkdown",
    "updateProperties",
    "updateMarkdown",
  ]);
  const properties = call(fake, "updateProperties").args;
  assert.equal(properties.page_id, "existing-page");
  assert.equal(properties.properties.Date.date.start, "2026-07-10");
  assert.equal(call(fake, "updateMarkdown").args.page_id, "existing-page");
  const markdownUpdate = call(fake, "updateMarkdown").args;
  assert.equal(
    markdownUpdate.replace_content.new_str,
    controlledBody({
      summary: "The adapter contract is now settled.",
      consequence: "Use the official Data Source API.",
    }),
  );
  assert.equal("allow_deleting_content" in markdownUpdate.replace_content, false);
});

test("unknown H2 content fails safely before either update", async () => {
  const fake = new FakeNotionClient();
  fake.addPage({ body: `${controlledBody()}\n\n## Notes\nManual context` });

  assert.deepEqual(await sink(fake).capture(capture()), {
    ok: false,
    error: "Notion page Markdown does not contain the controlled Work Memory sections.",
  });
  assert.deepEqual(fake.calls.map(({ method }) => method), ["query", "retrieveMarkdown"]);
});

test("all domain Type values map to the fixed Notion Select names", async () => {
  for (const [type, expected] of [
    ["decision", "Decision"],
    ["milestone", "Milestone"],
    ["discovery", "Discovery"],
    ["insight", "Insight"],
  ] as const) {
    const fake = new FakeNotionClient();
    assert.equal((await sink(fake).capture(capture({ type }))).ok, true);
    assert.equal(call(fake, "create").args.properties.Type.select.name, expected);
  }
});

test("body omits Consequence unless the capture contains one", async () => {
  const without = new FakeNotionClient();
  await sink(without).capture(capture());
  assert.doesNotMatch(call(without, "create").args.markdown, /## Consequence/);

  const withConsequence = new FakeNotionClient();
  await sink(withConsequence).capture(capture({ consequence: "Keep this boundary narrow." }));
  assert.match(
    call(withConsequence, "create").args.markdown,
    /## Consequence\nKeep this boundary narrow\.$/,
  );
});

test("explicit supersede creates the new Active page before superseding the old page", async () => {
  const fake = new FakeNotionClient();
  fake.addPage({ id: "old-page", memory: "Old direction" });

  const result = await sink(fake).capture(capture({ supersedes: "Old direction" }));

  assert.deepEqual(result, { ok: true, outcome: "superseded" });
  assert.deepEqual(fake.calls.map(({ method }) => method), ["query", "create", "supersede"]);
  assert.equal(call(fake, "supersede").args.page_id, "old-page");
  assert.deepEqual(call(fake, "supersede").args.properties, {
    Status: { select: { name: "Superseded" } },
  });
});

test("explicit supersede ensures an existing new title before superseding the old page", async () => {
  const fake = new FakeNotionClient();
  fake.addPage({ id: "old-page", memory: "Old direction" });
  fake.addPage({
    id: "new-page",
    memory: "Use the domain port",
    body: controlledBody({ summary: "Earlier summary" }),
  });

  assert.deepEqual(
    await sink(fake).capture(capture({ supersedes: "Old direction" })),
    { ok: true, outcome: "superseded" },
  );
  assert.deepEqual(fake.calls.map(({ method }) => method), [
    "query",
    "retrieveMarkdown",
    "updateProperties",
    "updateMarkdown",
    "supersede",
  ]);
  assert.equal(call(fake, "updateProperties").args.page_id, "new-page");
  assert.equal(call(fake, "supersede").args.page_id, "old-page");
});

test("missing or ambiguous supersede targets fail before any write", async () => {
  const missing = new FakeNotionClient();
  assert.deepEqual(
    await sink(missing).capture(capture({ supersedes: "Missing title" })),
    { ok: false, error: "Notion supersede target was not found." },
  );
  assert.deepEqual(missing.calls.map(({ method }) => method), ["query"]);

  const ambiguous = new FakeNotionClient();
  ambiguous.addPage({ id: "old-1", memory: "Old direction" });
  ambiguous.addPage({ id: "old-2", memory: "Old direction" });
  assert.deepEqual(
    await sink(ambiguous).capture(capture({ supersedes: "Old direction" })),
    { ok: false, error: "Notion supersede target is ambiguous." },
  );
  assert.deepEqual(ambiguous.calls.map(({ method }) => method), ["query"]);
});

test("query and create transport errors become bounded failure results", async () => {
  const queryFailure = new FakeNotionClient();
  queryFailure.failures.add("query");
  assert.deepEqual(await sink(queryFailure).capture(capture()), {
    ok: false,
    error: "Notion data source query failed.",
  });
  assert.doesNotMatch(JSON.stringify(await sink(queryFailure).capture(capture())), /secret raw/);
  assert.equal(queryFailure.calls.filter(({ method }) => method === "query").length, 2);

  const createFailure = new FakeNotionClient();
  createFailure.failures.add("create");
  assert.deepEqual(await sink(createFailure).capture(capture()), {
    ok: false,
    error: "Notion page create failed.",
  });
});

test("property and Markdown update errors become bounded failure results", async () => {
  const propertyFailure = new FakeNotionClient();
  propertyFailure.addPage();
  propertyFailure.failures.add("updateProperties");
  assert.deepEqual(
    await sink(propertyFailure).capture(capture({ summary: "Changed" })),
    { ok: false, error: "Notion page property update failed." },
  );
  assert.equal(propertyFailure.calls.some(({ method }) => method === "updateMarkdown"), false);

  const markdownFailure = new FakeNotionClient();
  markdownFailure.addPage();
  markdownFailure.failures.add("updateMarkdown");
  assert.deepEqual(
    await sink(markdownFailure).capture(capture({ summary: "Changed" })),
    { ok: false, error: "Notion page Markdown update failed." },
  );
});

test("a failed old-page supersede leaves the successfully created replacement Active", async () => {
  const fake = new FakeNotionClient();
  fake.addPage({ id: "old-page", memory: "Old direction" });
  fake.failures.add("supersede");

  assert.deepEqual(
    await sink(fake).capture(capture({ supersedes: "Old direction" })),
    { ok: false, error: "Notion supersede update failed." },
  );
  assert.deepEqual(fake.calls.map(({ method }) => method), ["query", "create", "supersede"]);
});

test("an already-aborted capture stops before the first Notion request", async () => {
  const fake = new FakeNotionClient();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    sink(fake).capture(capture(), { signal: controller.signal }),
    /Notion Work Memory capture was aborted\./,
  );
  assert.deepEqual(fake.calls, []);
});

test("an abort observed after a pending query prevents create or update", async () => {
  const fake = new FakeNotionClient();
  const queryGate = deferred<void>();
  fake.gates.set("query", queryGate.promise);
  const controller = new AbortController();
  const pending = sink(fake).capture(capture(), { signal: controller.signal });

  assert.deepEqual(fake.calls.map(({ method }) => method), ["query"]);
  controller.abort();
  queryGate.resolve();

  await assert.rejects(pending, /Notion Work Memory capture was aborted\./);
  assert.deepEqual(fake.calls.map(({ method }) => method), ["query"]);
});

test("an abort after property update starts prevents the Markdown follow-up", async () => {
  const fake = new FakeNotionClient();
  fake.addPage({ id: "existing-page" });
  const propertyGate = deferred<void>();
  fake.gates.set("updateProperties", propertyGate.promise);
  const controller = new AbortController();
  const pending = sink(fake).capture(
    capture({ summary: "Changed" }),
    { signal: controller.signal },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(fake.calls.map(({ method }) => method), [
    "query",
    "retrieveMarkdown",
    "updateProperties",
  ]);
  controller.abort();
  propertyGate.resolve();

  await assert.rejects(pending, /Notion Work Memory capture was aborted\./);
  assert.equal(fake.calls.some(({ method }) => method === "updateMarkdown"), false);
});

test("an abort after ensuring a replacement prevents the supersede follow-up", async () => {
  const fake = new FakeNotionClient();
  fake.addPage({ id: "old-page", memory: "Old direction" });
  const controller = new AbortController();
  fake.afterCalls.set("create", () => controller.abort());

  await assert.rejects(
    sink(fake).capture(
      capture({ supersedes: "Old direction" }),
      { signal: controller.signal },
    ),
    /Notion Work Memory capture was aborted\./,
  );
  assert.deepEqual(fake.calls.map(({ method }) => method), ["query", "create"]);
});

test("adapter uses the official Markdown API version and has no local persistence or retry", async () => {
  assert.equal(NOTION_PROJECT_MEMORY_API_VERSION, "2026-03-11");
  const source = await readFile(
    new URL("../src/notion-project-memory.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /node:fs|fs\/promises|JSONL|retry queue|setTimeout|setInterval/);

  const fake = new FakeNotionClient();
  fake.failures.add("create");
  await sink(fake).capture(capture());
  assert.equal(fake.calls.filter(({ method }) => method === "create").length, 1);
});
