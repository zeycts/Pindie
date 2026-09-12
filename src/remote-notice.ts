import type { CustomEntry, EntryRenderer } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export const PINDIE_REMOTE_NOTICE_TYPE = "pindie-remote-notice";

export interface PindieRemoteNotice {
  message: string;
}

export const renderPindieRemoteNotice: EntryRenderer<PindieRemoteNotice> = (entry, _options, theme) => {
  const rawMessage = typeof entry.data?.message === "string" ? entry.data.message : "";
  const message = rawMessage.replace(/^Pindie\s+/u, "").replace(/[\r\n\t]+/gu, " ").trim() || "Remote warning";
  return new Text(
    `${theme.fg("muted", "Pindie")} ${theme.fg("warning", `· ${message}`)}`,
    0,
    0,
  );
};

export type PindieRemoteNoticeEntry = CustomEntry<PindieRemoteNotice>;
