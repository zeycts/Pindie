import { VERSION } from "@earendil-works/pi-coding-agent";

// Deliberately pinned: these are native UI implementation details, not a Pi API.
// Only this mode instance is instrumented; no prototypes, Sessions or globals.
const pendingMethods = [
  "showExtensionSelector", "showExtensionInput", "showExtensionEditor", "showExtensionCustom",
  "handleOpenExternalEditor", "showOAuthSelector", "showAuthPrompt", "showApiKeyLoginDialog",
  "showLoginDialog", "loginProvider", "startProviderLogin", "handleLoginCommand",
  "handleModelCommand", "handleResumeSession", "handleCloneCommand", "handleReloadCommand",
] as const;
const fields = [
  "isInitialized", "shutdownRequested", "pendingUserInputs", "activeSelectorToken",
  "extensionSelector", "extensionInput", "extensionEditor", "editorContainer", "editor", "renderer",
] as const;

/** Unknown versions/shapes or replaced instrumentation never authorize release. */
export function observeNativeUiIdle(mode: unknown, version = VERSION): () => boolean {
  if (version !== "1.3.0" || typeof mode !== "object" || mode === null) return () => false;
  const target = mode as Record<string, unknown>;
  try {
    if (fields.some((key) => !Object.hasOwn(target, key)) ||
        pendingMethods.some((key) => typeof target[key] !== "function")) return () => false;
  } catch { return () => false; }
  let pending = 0;
  let valid = true;
  const installed = new Map<string, unknown>();
  try {
    for (const key of pendingMethods) {
      const original = target[key] as (...args: unknown[]) => unknown;
      const wrapped = function (this: unknown, ...args: unknown[]): unknown {
        pending++;
        try {
          const result = Reflect.apply(original, this, args);
          if (result && typeof (result as PromiseLike<unknown>).then === "function") {
            return Promise.resolve(result).finally(() => { pending--; });
          }
          pending--;
          return result;
        } catch (error) { pending--; throw error; }
      };
      Object.defineProperty(target, key, { value: wrapped, writable: true, configurable: true });
      installed.set(key, wrapped);
    }
  } catch { valid = false; }
  return () => {
    try {
      if (!valid || pending !== 0 || fields.some((key) => !Object.hasOwn(target, key)) ||
          [...installed].some(([key, value]) => target[key] !== value) ||
          target.isInitialized !== true || target.shutdownRequested !== false ||
          !Array.isArray(target.pendingUserInputs) || target.pendingUserInputs.length !== 0 ||
          target.activeSelectorToken !== undefined || target.extensionSelector !== undefined ||
          target.extensionInput !== undefined || target.extensionEditor !== undefined) return false;
      const renderer = target.renderer as { hasOverlayEntries?: unknown } | undefined;
      const container = target.editorContainer as { children?: unknown } | undefined;
      // Synchronous native selectors/auth dialogs replace the composer. Custom
      // overlays can be hidden without settling; their promises remain counted.
      return renderer?.hasOverlayEntries === false && Array.isArray(container?.children) &&
        container.children.length === 1 && target.editor !== undefined && container.children[0] === target.editor;
    } catch { return false; }
  };
}
