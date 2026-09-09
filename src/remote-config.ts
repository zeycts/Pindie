export interface DiscordRemoteConfig {
  token: string;
  userId: string;
  guildId: string;
  proxyUrl?: string;
}

export type DiscordRemoteConfigResult =
  | { enabled: true; config: DiscordRemoteConfig }
  | { enabled: false; warning?: string };

/** Environment-only configuration. The token deliberately never appears in a result or warning. */
export function discordRemoteConfig(
  env: Record<string, string | undefined> = process.env,
): DiscordRemoteConfigResult {
  const token = env.PINDIE_DISCORD_TOKEN?.trim();
  const userId = env.PINDIE_DISCORD_USER_ID?.trim();
  const guildId = env.PINDIE_DISCORD_GUILD_ID?.trim();
  if (!token && !userId && !guildId) return { enabled: false };
  if (
    !token ||
    !userId ||
    !guildId ||
    !/^\d{17,20}$/.test(userId) ||
    !/^\d{17,20}$/.test(guildId)
  ) {
    return {
      enabled: false,
      warning: "Pindie Discord Remote is disabled: configuration is incomplete or invalid.",
    };
  }
  const proxyUrl =
    env.PINDIE_DISCORD_PROXY?.trim() ||
    env.HTTPS_PROXY?.trim() ||
    env.https_proxy?.trim();
  if (proxyUrl) {
    try {
      const parsed = new URL(proxyUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("unsupported proxy protocol");
      }
    } catch {
      return {
        enabled: false,
        warning: "Pindie Discord Remote is disabled: proxy configuration is invalid.",
      };
    }
  }
  return {
    enabled: true,
    config: { token, userId, guildId, ...(proxyUrl ? { proxyUrl } : {}) },
  };
}
