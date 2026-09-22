import type {
  AutocompleteProviderFactory,
  ExtensionUIContext,
  ExtensionUIDialogOptions,
  ExtensionWidgetOptions,
  TerminalInputHandler,
  WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

export class UnsupportedExtensionUICapabilityError extends Error {
  readonly capability: string;

  constructor(capability: string, reason = "the pinned public Pi API does not expose the primitive required for faithful support") {
    super(`Extension UI capability ${capability} is unsupported: ${reason}.`);
    this.name = "UnsupportedExtensionUICapabilityError";
    this.capability = capability;
  }
}

export interface PindieExtensionUIViewPort {
  selectExtension(title: string, options: readonly string[]): Promise<string | undefined>;
  confirmExtension(title: string, message: string): Promise<boolean>;
  inputExtension(title: string, placeholder?: string): Promise<string | undefined>;
  editorExtension(title: string, prefill?: string): Promise<string | undefined>;
  cancelExtensionDialog(): void;
  showExtensionNotice(message: string, type?: "info" | "warning" | "error"): void;
  addExtensionTerminalInputHandler(handler: TerminalInputHandler): () => void;
  setExtensionStatus(key: string, text: string | undefined): void;
  setExtensionWorkingMessage(message?: string): void;
  setExtensionWorkingVisible(visible: boolean): void;
  setExtensionWorkingIndicator(options?: WorkingIndicatorOptions): void;
  setExtensionHiddenThinkingLabel(label?: string): void;
  setExtensionStringWidget(key: string, content: readonly string[] | undefined, options?: ExtensionWidgetOptions): void;
  addExtensionAutocompleteProvider(factory: AutocompleteProviderFactory): void;
  getExtensionToolsExpanded(): boolean;
  setExtensionToolsExpanded(expanded: boolean): void;
  setTerminalTitle(title: string): void;
  restoreBaseTerminalTitle(): void;
  pasteToComposer(text: string): void;
  setEditorText(text: string): void;
  getEditorText(): string;
  clearExtensionSessionState(): void;
}

type CancelValue = string | boolean | undefined;

interface PendingDialog {
  readonly epoch: number;
  readonly cancelValue: CancelValue;
  readonly opts: ExtensionUIDialogOptions | undefined;
  readonly open: () => Promise<CancelValue>;
  readonly resolve: (value: CancelValue) => void;
  settled: boolean;
  started: boolean;
  cleanup?: () => void;
}

/** Session-scoped Pi ExtensionUIContext backed by the Pindie-owned TUI. */
export class PindieExtensionUIBridge implements ExtensionUIContext {
  /** Owned TUI status is rendered from Projection and does not require Pi's unavailable active Theme singleton. */
  readonly pindieOwnedThemeFormatting = false;
  private readonly view: PindieExtensionUIViewPort;
  private epoch = 1;
  private valid = true;
  private active: PendingDialog | null = null;
  private readonly queue: PendingDialog[] = [];
  private readonly terminalUnsubscribers = new Set<() => void>();

  constructor(view: PindieExtensionUIViewPort) {
    this.view = view;
  }

  select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
    return this.enqueue(undefined, opts, () => this.view.selectExtension(title, options));
  }

  confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean> {
    return this.enqueue(false, opts, () => this.view.confirmExtension(title, message));
  }

  input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
    return this.enqueue(undefined, opts, () => this.view.inputExtension(title, placeholder));
  }

  editor(title: string, prefill?: string): Promise<string | undefined> {
    return this.enqueue(undefined, undefined, () => this.view.editorExtension(title, prefill));
  }

  notify(message: string, type: "info" | "warning" | "error" = "info"): void {
    if (this.valid) this.view.showExtensionNotice(message, type);
  }

  onTerminalInput(handler: TerminalInputHandler): () => void {
    if (!this.valid) return () => undefined;
    const removeFromView = this.view.addExtensionTerminalInputHandler(handler);
    let active = true;
    const unsubscribe = () => {
      if (!active) return;
      active = false;
      this.terminalUnsubscribers.delete(unsubscribe);
      removeFromView();
    };
    this.terminalUnsubscribers.add(unsubscribe);
    return unsubscribe;
  }

  setStatus(key: string, text: string | undefined): void {
    if (this.valid) this.view.setExtensionStatus(key, text);
  }

  setWorkingMessage(message?: string): void {
    if (this.valid) this.view.setExtensionWorkingMessage(message);
  }

  setWorkingVisible(visible: boolean): void {
    if (this.valid) this.view.setExtensionWorkingVisible(visible);
  }

  setWorkingIndicator(options?: WorkingIndicatorOptions): void {
    if (this.valid) this.view.setExtensionWorkingIndicator(options);
  }

  setHiddenThinkingLabel(label?: string): void {
    if (this.valid) this.view.setExtensionHiddenThinkingLabel(label);
  }

  setTitle(title: string): void {
    if (this.valid) this.view.setTerminalTitle(title);
  }

  pasteToEditor(text: string): void {
    if (this.valid) this.view.pasteToComposer(text);
  }

  setEditorText(text: string): void {
    if (this.valid) this.view.setEditorText(text);
  }

  getEditorText(): string {
    return this.valid ? this.view.getEditorText() : "";
  }

  get hasActiveInteraction(): boolean {
    return this.active !== null || this.queue.length > 0;
  }

  invalidate(): void {
    if (!this.valid) return;
    this.valid = false;
    this.epoch += 1;
    this.view.cancelExtensionDialog();
    const pending = [this.active, ...this.queue].filter((item): item is PendingDialog => item !== null);
    this.active = null;
    this.queue.length = 0;
    for (const dialog of pending) this.finish(dialog, dialog.cancelValue);
    for (const unsubscribe of [...this.terminalUnsubscribers]) unsubscribe();
    this.view.clearExtensionSessionState();
  }

  private enqueue<T extends CancelValue>(
    cancelValue: T,
    opts: ExtensionUIDialogOptions | undefined,
    open: () => Promise<T>,
  ): Promise<T> {
    if (!this.valid || opts?.signal?.aborted) return Promise.resolve(cancelValue);
    return new Promise<T>((resolve) => {
      const dialog: PendingDialog = {
        epoch: this.epoch,
        cancelValue,
        opts,
        open,
        resolve: (value) => resolve(value as T),
        settled: false,
        started: false,
      };
      const abort = () => {
        if (dialog.settled) return;
        if (this.active === dialog) this.view.cancelExtensionDialog();
        else {
          const index = this.queue.indexOf(dialog);
          if (index >= 0) this.queue.splice(index, 1);
        }
        this.finish(dialog, cancelValue);
      };
      opts?.signal?.addEventListener("abort", abort, { once: true });
      dialog.cleanup = () => opts?.signal?.removeEventListener("abort", abort);
      this.queue.push(dialog);
      this.pump();
    });
  }

  private pump(): void {
    if (!this.valid || this.active !== null) return;
    const dialog = this.queue.shift();
    if (dialog === undefined) return;
    if (dialog.settled || dialog.epoch !== this.epoch) {
      this.finish(dialog, dialog.cancelValue);
      this.pump();
      return;
    }
    this.active = dialog;
    dialog.started = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (dialog.opts?.timeout !== undefined && dialog.opts.timeout > 0) {
      timer = setTimeout(() => {
        if (this.active === dialog) this.view.cancelExtensionDialog();
        this.finish(dialog, dialog.cancelValue);
      }, dialog.opts.timeout);
    }
    const priorCleanup = dialog.cleanup;
    dialog.cleanup = () => {
      priorCleanup?.();
      if (timer !== undefined) clearTimeout(timer);
    };
    void dialog.open().then(
      (value) => this.finish(dialog, value),
      () => this.finish(dialog, dialog.cancelValue),
    );
  }

  private finish(dialog: PendingDialog, value: CancelValue): void {
    if (dialog.settled) return;
    dialog.settled = true;
    dialog.cleanup?.();
    dialog.resolve(value);
    if (this.active === dialog) {
      this.active = null;
      this.pump();
    }
  }

  private unsupported(capability: string, reason?: string): never {
    throw new UnsupportedExtensionUICapabilityError(capability, reason);
  }

  setWidget(key: string, content: string[] | ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined, options?: ExtensionWidgetOptions): void {
    if (!this.valid) return;
    if (typeof content === "function") this.unsupported("setWidget(component factory)", "Pi 0.86.1 package-root exports no active Theme instance for the required factory argument");
    this.view.setExtensionStringWidget(key, content, options);
  }
  setFooter(_factory: ((tui: TUI, theme: Theme, footerData: never) => Component & { dispose?(): void }) | undefined): void { this.unsupported("setFooter", "Pi 0.86.1 package-root exports neither an active Theme instance nor a public FooterDataProvider constructor"); }
  setHeader(_factory: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined): void { this.unsupported("setHeader", "Pi 0.86.1 package-root exports no active Theme instance for the required factory argument"); }
  custom: ExtensionUIContext["custom"] = async () => this.unsupported("custom", "Pi 0.86.1 package-root exports neither the active Theme nor app KeybindingsManager values required by the factory contract");
  addAutocompleteProvider(factory: AutocompleteProviderFactory): void { if (this.valid) this.view.addExtensionAutocompleteProvider(factory); }
  setEditorComponent: ExtensionUIContext["setEditorComponent"] = () => this.unsupported("setEditorComponent", "Pi 0.86.1 package-root does not export getEditorTheme() or a runtime app KeybindingsManager constructor/value");
  getEditorComponent(): undefined { return this.unsupported("getEditorComponent", "custom editor installation is unavailable for the same public EditorTheme/KeybindingsManager gap"); }
  get theme(): Theme { return this.unsupported("theme", "Pi 0.86.1 package-root exports the Theme class but not its active Theme singleton"); }
  getAllThemes(): { name: string; path: string | undefined }[] { return this.unsupported("getAllThemes", "Pi 0.86.1 package-root does not export theme enumeration"); }
  getTheme(_name: string): Theme | undefined { return this.unsupported("getTheme", "Pi 0.86.1 package-root does not export theme lookup"); }
  setTheme(_theme: string | Theme): { success: boolean; error?: string } { return this.unsupported("setTheme", "Pi 0.86.1 package-root does not export theme switching"); }
  getToolsExpanded(): boolean { return this.valid ? this.view.getExtensionToolsExpanded() : false; }
  setToolsExpanded(expanded: boolean): void { if (this.valid) this.view.setExtensionToolsExpanded(expanded); }
}
