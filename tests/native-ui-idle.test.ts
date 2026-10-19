import assert from "node:assert/strict";
import test from "node:test";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { observeNativeUiIdle } from "../src/native-ui-idle.ts";

function fixture() {
  // Real pinned prototype proves every instrumented method exists. No terminal,
  // Session or model is started; only UI facts are supplied by the fixture.
  const mode = Object.assign(Object.create(InteractiveMode.prototype), {
    isInitialized: true, shutdownRequested: false, pendingUserInputs: [],
    activeSelectorToken: undefined, extensionSelector: undefined, extensionInput: undefined,
    extensionEditor: undefined, editor: {}, editorContainer: { children: [] as unknown[] },
    renderer: { hasOverlayEntries: false },
  });
  mode.editorContainer.children = [mode.editor];
  return mode;
}

test("native UI authority is pinned, instance-local, and fail closed on unknown shapes", () => {
  const mode = fixture();
  const original = mode.showExtensionCustom;
  assert.equal(observeNativeUiIdle(mode, "future")(), false);
  assert.equal(mode.showExtensionCustom, original);
  assert.equal(observeNativeUiIdle({})(), false);
  assert.equal(observeNativeUiIdle(new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("unknown shape"); } }))(), false);
  const idle = observeNativeUiIdle(mode);
  assert.equal(idle(), true);
  assert.notEqual(mode.showExtensionCustom, original);
  assert.equal(InteractiveMode.prototype["showExtensionCustom" as keyof InteractiveMode], original);
  mode.showExtensionCustom = original;
  assert.equal(idle(), false);
});

test("native selectors, overlays, queued input, initialization and shutdown block release", () => {
  for (const mutate of [
    (m: ReturnType<typeof fixture>) => { m.renderer.hasOverlayEntries = true; },
    (m: ReturnType<typeof fixture>) => { m.editorContainer.children = [{}]; },
    (m: ReturnType<typeof fixture>) => { m.pendingUserInputs.push("queued"); },
    (m: ReturnType<typeof fixture>) => { m.activeSelectorToken = Symbol(); },
    (m: ReturnType<typeof fixture>) => { m.extensionSelector = {}; },
    (m: ReturnType<typeof fixture>) => { m.extensionInput = {}; },
    (m: ReturnType<typeof fixture>) => { m.extensionEditor = {}; },
    (m: ReturnType<typeof fixture>) => { m.isInitialized = false; },
    (m: ReturnType<typeof fixture>) => { m.shutdownRequested = true; },
    (m: ReturnType<typeof fixture>) => { m.renderer = {}; },
    (m: ReturnType<typeof fixture>) => { m.editor = null; m.editorContainer.children = [null]; },
    (m: ReturnType<typeof fixture>) => { m.editor = "unknown"; m.editorContainer.children = [m.editor]; },
    (m: ReturnType<typeof fixture>) => { m.editor = () => {}; m.editorContainer.children = [m.editor]; },
    (m: ReturnType<typeof fixture>) => { m.renderer = Object.assign(() => {}, { hasOverlayEntries: false }); },
    (m: ReturnType<typeof fixture>) => { delete m.extensionInput; },
    (m: ReturnType<typeof fixture>) => { Object.defineProperty(m.renderer, "hasOverlayEntries", { get() { throw new Error("unknown"); } }); },
  ]) {
    const mode = fixture();
    const idle = observeNativeUiIdle(mode);
    assert.equal(idle(), true);
    mutate(mode);
    assert.equal(idle(), false);
  }
});

test("async custom factories and overlapping native interactions stay protected until settlement", async () => {
  const mode = fixture();
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  mode.showExtensionCustom = function () { assert.equal(this, mode); return pending; };
  mode.showExtensionInput = () => pending;
  const idle = observeNativeUiIdle(mode);
  const first = mode.showExtensionCustom();
  const second = mode.showExtensionInput();
  assert.equal(idle(), false); // No component has mounted and no status was set.
  finish();
  await Promise.all([first, second]);
  assert.equal(idle(), true);
});

test("actual pinned custom UI protects the pre-mount factory gap and mounted lifetime", async () => {
  const mode = fixture();
  mode.editor = { getText: () => "draft", setText: () => {} };
  mode.editorContainer = {
    children: [mode.editor],
    clear() { this.children = []; },
    addChild(child: unknown) { this.children.push(child); },
  };
  mode.ui = { setFocus: () => {}, requestRender: () => {} };
  const idle = observeNativeUiIdle(mode);
  let factoryReady!: (component: object) => void;
  let done!: () => void;
  const waiting = mode.showExtensionCustom((_ui: unknown, _theme: unknown, _keys: unknown, close: () => void) => {
    done = close;
    return new Promise((resolve) => { factoryReady = resolve; });
  });
  assert.equal(mode.editorContainer.children[0], mode.editor);
  assert.equal(idle(), false);
  factoryReady({});
  await new Promise((resolve) => setImmediate(resolve));
  assert.notEqual(mode.editorContainer.children[0], mode.editor);
  assert.equal(idle(), false);
  done();
  await waiting;
  assert.equal(idle(), true);
});

test("native UI rejection and synchronous exceptions preserve errors and release pending count", async () => {
  const mode = fixture();
  const failure = new Error("UI failed");
  mode.showExtensionCustom = () => Promise.reject(failure);
  mode.showExtensionInput = () => { throw failure; };
  const idle = observeNativeUiIdle(mode);
  await assert.rejects(mode.showExtensionCustom(), (error) => error === failure);
  assert.throws(() => mode.showExtensionInput(), (error) => error === failure);
  assert.equal(idle(), true);
});
