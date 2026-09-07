import type { Client } from "@notionhq/client";

import type {
  ProjectMemoryCapture,
  ProjectMemoryCaptureResult,
  ProjectMemorySink,
  ProjectMemoryType,
} from "./project-memory.ts";

export const NOTION_PROJECT_MEMORY_API_VERSION = "2026-03-11";

export interface NotionProjectMemoryClient {
  readonly dataSources: Pick<Client["dataSources"], "query">;
  readonly pages: Pick<
    Client["pages"],
    "create" | "update" | "retrieveMarkdown" | "updateMarkdown"
  >;
}

export interface NotionProjectMemorySinkOptions {
  readonly client: NotionProjectMemoryClient;
  readonly dataSourceId: string;
}

type SinkFailure = Extract<ProjectMemoryCaptureResult, { readonly ok: false }>;
type OperationResult<T> = { readonly ok: true; readonly value: T } | SinkFailure;
type CreatePageArguments = Parameters<Client["pages"]["create"]>[0];
type PageProperties = NonNullable<CreatePageArguments["properties"]>;

interface ExistingMemoryPage {
  readonly id: string;
  readonly memory: string;
  readonly scope: string;
  readonly type: string;
  readonly status: string;
  readonly date: string;
  readonly source: readonly string[];
  readonly evidence: string;
}

interface ControlledBody {
  readonly summary: string;
  readonly whyItMatters: string;
  readonly consequence?: string;
}

const TYPE_NAMES: Readonly<Record<ProjectMemoryType, string>> = {
  decision: "Decision",
  milestone: "Milestone",
  discovery: "Discovery",
  insight: "Insight",
};

function failure(error: string): SinkFailure {
  return { ok: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function callNotion<T>(
  operation: string,
  invoke: () => Promise<T>,
): Promise<OperationResult<T>> {
  try {
    return { ok: true, value: await invoke() };
  } catch {
    return failure(`Notion ${operation} failed.`);
  }
}

function plainTextProperty(
  properties: Record<string, unknown>,
  name: string,
  type: "title" | "rich_text",
): string | null {
  const property = properties[name];
  if (!isRecord(property) || property.type !== type || !Array.isArray(property[type])) {
    return null;
  }

  const parts: string[] = [];
  for (const item of property[type]) {
    if (!isRecord(item) || typeof item.plain_text !== "string") return null;
    parts.push(item.plain_text);
  }
  return parts.join("");
}

function selectProperty(properties: Record<string, unknown>, name: string): string | null {
  const property = properties[name];
  if (!isRecord(property) || property.type !== "select" || !isRecord(property.select)) {
    return null;
  }
  return typeof property.select.name === "string" ? property.select.name : null;
}

function dateProperty(properties: Record<string, unknown>, name: string): string | null {
  const property = properties[name];
  if (!isRecord(property) || property.type !== "date" || !isRecord(property.date)) {
    return null;
  }
  return typeof property.date.start === "string" && property.date.start !== ""
    ? property.date.start
    : null;
}

function multiSelectProperty(
  properties: Record<string, unknown>,
  name: string,
): readonly string[] | null {
  const property = properties[name];
  if (!isRecord(property) || property.type !== "multi_select" || !Array.isArray(property.multi_select)) {
    return null;
  }

  const names: string[] = [];
  for (const option of property.multi_select) {
    if (!isRecord(option) || typeof option.name !== "string") return null;
    names.push(option.name);
  }
  return names;
}

function parseExistingPage(value: unknown): ExistingMemoryPage | null {
  if (!isRecord(value) || value.object !== "page" || typeof value.id !== "string") return null;
  if (!isRecord(value.properties)) return null;

  const properties = value.properties;
  const memory = plainTextProperty(properties, "Memory", "title");
  const scope = plainTextProperty(properties, "Scope", "rich_text");
  const type = selectProperty(properties, "Type");
  const status = selectProperty(properties, "Status");
  const date = dateProperty(properties, "Date");
  const source = multiSelectProperty(properties, "Source");
  const evidence = plainTextProperty(properties, "Evidence", "rich_text");

  if (
    memory === null ||
    scope === null ||
    type === null ||
    status === null ||
    date === null ||
    source === null ||
    evidence === null
  ) {
    return null;
  }

  return { id: value.id, memory, scope, type, status, date, source, evidence };
}

function buildBody(memory: ProjectMemoryCapture): string {
  const sections = [
    `## Summary\n${memory.summary}`,
    `## Why it matters\n${memory.whyItMatters}`,
  ];
  if (memory.consequence !== undefined) {
    sections.push(`## Consequence\n${memory.consequence}`);
  }
  return sections.join("\n\n");
}

function parseControlledBody(markdown: string): ControlledBody | null {
  const normalized = markdown.replaceAll("\r\n", "\n");
  const headings: Array<{ readonly name: string; readonly start: number; readonly contentStart: number }> = [];
  const pattern = /^## ([^\n]+)\s*$/gm;
  for (let match = pattern.exec(normalized); match !== null; match = pattern.exec(normalized)) {
    headings.push({
      name: match[1]!.trim(),
      start: match.index,
      contentStart: pattern.lastIndex,
    });
  }

  const controlled = new Map<string, string>();
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]!;
    if (!["Summary", "Why it matters", "Consequence"].includes(heading.name)) continue;
    if (controlled.has(heading.name)) return null;
    const end = headings[index + 1]?.start ?? normalized.length;
    controlled.set(heading.name, normalized.slice(heading.contentStart, end).trim());
  }

  if (!controlled.has("Summary") || !controlled.has("Why it matters")) return null;
  const consequence = controlled.get("Consequence");
  return {
    summary: controlled.get("Summary")!,
    whyItMatters: controlled.get("Why it matters")!,
    ...(consequence === undefined ? {} : { consequence }),
  };
}

function memoryProperties(memory: ProjectMemoryCapture, date: string): PageProperties {
  return {
    Memory: { title: [{ type: "text", text: { content: memory.memory } }] },
    Scope: { rich_text: [{ type: "text", text: { content: memory.scope } }] },
    Type: { select: { name: TYPE_NAMES[memory.type] } },
    Status: { select: { name: "Active" } },
    Date: { date: { start: date } },
    Source: { multi_select: [{ name: "Pindie" }] },
    Evidence: { rich_text: [{ type: "text", text: { content: memory.evidence } }] },
  };
}

function pageResponseHasId(value: unknown, expectedId?: string): boolean {
  return isRecord(value) &&
    value.object === "page" &&
    typeof value.id === "string" &&
    (expectedId === undefined || value.id === expectedId);
}

function markdownResponseIsComplete(value: unknown, expectedId: string): value is {
  readonly id: string;
  readonly markdown: string;
  readonly truncated: false;
} {
  return isRecord(value) &&
    value.object === "page_markdown" &&
    value.id === expectedId &&
    typeof value.markdown === "string" &&
    value.truncated === false;
}

export class NotionProjectMemorySink implements ProjectMemorySink {
  readonly #client: NotionProjectMemoryClient;
  readonly #dataSourceId: string;

  constructor(options: NotionProjectMemorySinkOptions) {
    if (options.dataSourceId.trim() === "") {
      throw new Error("dataSourceId must be a non-empty string.");
    }
    this.#client = options.client;
    this.#dataSourceId = options.dataSourceId.trim();
  }

  async capture(memory: ProjectMemoryCapture): Promise<ProjectMemoryCaptureResult> {
    const queried = await this.#queryActive(memory.scope);
    if (!queried.ok) return queried;

    const title = memory.memory.trim();
    const activePages = queried.value.filter(
      (page) => page.scope === memory.scope && page.status === "Active",
    );
    const newMatches = activePages.filter((page) => page.memory.trim() === title);
    if (newMatches.length > 1) {
      return failure("Notion Active Memory title is ambiguous.");
    }

    if (memory.supersedes === undefined) {
      return this.#ensureActive(memory, newMatches[0]);
    }

    const supersedes = memory.supersedes.trim();
    if (supersedes === title) {
      return failure("Notion supersede target must differ from the new Memory title.");
    }
    const oldMatches = activePages.filter((page) => page.memory.trim() === supersedes);
    if (oldMatches.length === 0) {
      return failure("Notion supersede target was not found.");
    }
    if (oldMatches.length > 1) {
      return failure("Notion supersede target is ambiguous.");
    }

    const ensured = await this.#ensureActive(memory, newMatches[0]);
    if (!ensured.ok) return ensured;

    const superseded = await callNotion("supersede update", () => this.#client.pages.update({
      page_id: oldMatches[0]!.id,
      properties: { Status: { select: { name: "Superseded" } } },
    }));
    if (!superseded.ok) return superseded;
    if (!pageResponseHasId(superseded.value, oldMatches[0]!.id)) {
      return failure("Notion supersede update returned a malformed response.");
    }
    return { ok: true, outcome: "superseded" };
  }

  async #queryActive(scope: string): Promise<OperationResult<readonly ExistingMemoryPage[]>> {
    const pages: ExistingMemoryPage[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    do {
      const queried = await callNotion("data source query", () => this.#client.dataSources.query({
        data_source_id: this.#dataSourceId,
        filter: {
          and: [
            { property: "Scope", rich_text: { equals: scope } },
            { property: "Status", select: { equals: "Active" } },
          ],
        },
        page_size: 100,
        result_type: "page",
        ...(cursor === undefined ? {} : { start_cursor: cursor }),
      }));
      if (!queried.ok) return queried;
      if (
        !isRecord(queried.value) ||
        queried.value.object !== "list" ||
        !Array.isArray(queried.value.results) ||
        typeof queried.value.has_more !== "boolean" ||
        !(queried.value.next_cursor === null || typeof queried.value.next_cursor === "string")
      ) {
        return failure("Notion data source query returned a malformed response.");
      }
      if (
        isRecord(queried.value.request_status) &&
        queried.value.request_status.type === "incomplete"
      ) {
        return failure("Notion data source query returned incomplete results.");
      }

      for (const result of queried.value.results) {
        const page = parseExistingPage(result);
        if (page === null) {
          return failure("Notion data source query returned malformed page properties.");
        }
        pages.push(page);
      }

      if (!queried.value.has_more) break;
      const nextCursor = queried.value.next_cursor;
      if (nextCursor === null || seenCursors.has(nextCursor)) {
        return failure("Notion data source query returned invalid pagination.");
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (true);

    return { ok: true, value: pages };
  }

  async #ensureActive(
    memory: ProjectMemoryCapture,
    existing: ExistingMemoryPage | undefined,
  ): Promise<ProjectMemoryCaptureResult> {
    if (existing === undefined) {
      const created = await callNotion("page create", () => this.#client.pages.create({
        parent: { type: "data_source_id", data_source_id: this.#dataSourceId },
        properties: memoryProperties(memory, memory.date),
        markdown: buildBody(memory),
      }));
      if (!created.ok) return created;
      if (!pageResponseHasId(created.value)) {
        return failure("Notion page create returned a malformed response.");
      }
      return { ok: true, outcome: "created" };
    }

    const retrieved = await callNotion("page Markdown retrieval", () =>
      this.#client.pages.retrieveMarkdown({ page_id: existing.id })
    );
    if (!retrieved.ok) return retrieved;
    if (!markdownResponseIsComplete(retrieved.value, existing.id)) {
      return failure("Notion page Markdown retrieval returned a malformed or truncated response.");
    }

    const existingBody = parseControlledBody(retrieved.value.markdown);
    if (existingBody === null) {
      return failure("Notion page Markdown does not contain the controlled Work Memory sections.");
    }

    const propertiesMatch =
      existing.type === TYPE_NAMES[memory.type] &&
      existing.scope === memory.scope &&
      existing.memory.trim() === memory.memory.trim() &&
      existing.evidence === memory.evidence &&
      existing.source.length === 1 &&
      existing.source[0] === "Pindie" &&
      existing.status === "Active";
    const bodyMatches =
      existingBody.summary === memory.summary &&
      existingBody.whyItMatters === memory.whyItMatters &&
      existingBody.consequence === memory.consequence;

    if (propertiesMatch && bodyMatches) {
      return { ok: true, outcome: "duplicate" };
    }

    const updated = await callNotion("page property update", () => this.#client.pages.update({
      page_id: existing.id,
      properties: memoryProperties(memory, existing.date),
    }));
    if (!updated.ok) return updated;
    if (!pageResponseHasId(updated.value, existing.id)) {
      return failure("Notion page property update returned a malformed response.");
    }

    const bodyUpdated = await callNotion("page Markdown update", () => this.#client.pages.updateMarkdown({
      page_id: existing.id,
      type: "replace_content",
      replace_content: {
        new_str: buildBody(memory),
        allow_deleting_content: true,
      },
    }));
    if (!bodyUpdated.ok) return bodyUpdated;
    if (!markdownResponseIsComplete(bodyUpdated.value, existing.id)) {
      return failure("Notion page Markdown update returned a malformed or truncated response.");
    }
    return { ok: true, outcome: "updated" };
  }
}
