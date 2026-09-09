export const NOTION_PROJECT_MEMORY_API_VERSION = "2026-03-11";

export interface NotionProjectMemoryConfig {
  readonly token: string;
  readonly dataSourceId: string;
}

export type NotionProjectMemoryConfigResult =
  | {
      readonly enabled: true;
      readonly config: NotionProjectMemoryConfig;
    }
  | {
      readonly enabled: false;
      readonly warning?: string;
    };

const INCOMPLETE_NOTION_PROJECT_MEMORY_WARNING =
  "Pindie Work Memory is disabled: Notion configuration is incomplete.";

/** Environment-only configuration; secrets are never included in warnings. */
export function notionProjectMemoryConfig(
  env: Record<string, string | undefined> = process.env,
): NotionProjectMemoryConfigResult {
  const token = env.PINDIE_NOTION_TOKEN?.trim();
  const dataSourceId = env.PINDIE_WORK_MEMORY_DATA_SOURCE_ID?.trim();
  if (token === undefined && dataSourceId === undefined) return { enabled: false };
  if (!token || !dataSourceId) {
    return { enabled: false, warning: INCOMPLETE_NOTION_PROJECT_MEMORY_WARNING };
  }
  return { enabled: true, config: { token, dataSourceId } };
}
