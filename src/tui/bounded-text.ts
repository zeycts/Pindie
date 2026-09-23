import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Width-aware normal Timeline text. Never split a grapheme or let a preview wrap beyond its row budget. */
export function boundedGraphemeText(
  text: string,
  width: number,
  maxGraphemes: number,
  maxRows: number,
): string[] {
  if (width <= 0) return [""];
  const normalized = text.replace(/\r\n?/gu, "\n").replace(/\t/gu, "   ");
  const clusters = Array.from(segmenter.segment(normalized), ({ segment }) => segment);
  const lines = [""];
  let count = 0;
  let truncated = false;
  for (const cluster of clusters) {
    if (count >= maxGraphemes) { truncated = true; break; }
    if (cluster === "\n") {
      if (lines.length >= maxRows) { truncated = true; break; }
      lines.push("");
      count++;
      continue;
    }
    const size = visibleWidth(cluster);
    const last = lines.length - 1;
    if (visibleWidth(lines[last]!) + size > width) {
      if (lines.length >= maxRows) { truncated = true; break; }
      lines.push("");
    }
    // An individual glyph may be wider than a one-column terminal.
    if (size <= width) lines[lines.length - 1] += cluster;
    else { truncated = true; break; }
    count++;
  }
  if (truncated) {
    const last = lines.length - 1;
    let tail = lines[last]!;
    if (count >= maxGraphemes) {
      tail = Array.from(segmenter.segment(tail), ({ segment }) => segment).slice(0, -1).join("");
    }
    lines[last] = truncateToWidth(tail, Math.max(0, width - 1), "") + "…";
  }
  return lines;
}
