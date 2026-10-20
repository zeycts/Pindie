import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve, relative } from "node:path";
import ts from "typescript";

// Physically deleted in PR2; retain the names as an import-regression denylist.
export const RETIRED_CPL_MODULES = new Set([
  "cross-project-experience.ts", "cross-project-synthesis.ts", "cross-project-trial-validation.ts",
  "strategy-synthesis-candidates.ts", "strategy-synthesis-decisions.ts", "strategy-trust-safety.ts", "strategy-trust-scope-artifacts.ts",
  "strategy-trust-scope-candidates.ts", "strategy-trust-scope-decisions.ts", "strategy-trust-scope-global.ts",
  "strategy-trust-scope-resolution.ts", "strategy-trust-scope-review.ts",
].map((name) => `src/${name}`));

// Full historical denylist, including the 17 artifacts still on disk for PR3.
export const RETIRED_MODULES = new Set([
  ...RETIRED_CPL_MODULES,
  ...[
    "exact-identity.ts", "experience-evaluation.ts", "experience-store.ts", "learning-v1-contract.ts", "policy.ts",
    "run-experience-fingerprint.ts", "run-experience.ts", "strategies.ts", "strategy-candidates.ts", "strategy-decisions.ts",
    "strategy-derivation-candidates.ts", "strategy-derivation-decisions.ts", "strategy-derivation.ts", "strategy-portfolio.ts",
    "strategy-trust-scope-constants.ts", "work-episode-attribution.ts", "work-episode.ts",
  ].map((name) => `src/${name}`),
]);

export function moduleSpecifiers(source: string): string[] {
  const file = ts.createSourceFile("audit.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specifiers = new Set<string>();
  const add = (node: ts.Node | undefined) => { if (node && ts.isStringLiteralLike(node)) specifiers.add(node.text); };
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require"))) add(node.arguments[0]);
    ts.forEachChild(node, visit);
  }
  visit(file);
  return [...specifiers].sort();
}

export async function importEdges(root: string, directories = ["src", "tests"]): Promise<Array<{ from: string; to: string }>> {
  const edges: Array<{ from: string; to: string }> = [];
  for (const directory of directories) {
    for (const name of (await readdir(resolve(root, directory), { recursive: true })).sort()) {
      if (!name.endsWith(".ts") || name.startsWith("archive/")) continue;
      const from = `${directory}/${name}`;
      for (const specifier of moduleSpecifiers(await readFile(resolve(root, from), "utf8"))) {
        if (!specifier.startsWith(".")) continue;
        const to = relative(root, resolve(dirname(resolve(root, from)), specifier));
        edges.push({ from, to });
      }
    }
  }
  return edges;
}
