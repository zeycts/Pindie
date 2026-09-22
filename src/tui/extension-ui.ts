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

  constructor(capability: string) {
    super(`Extension UI capability ${capability} is not yet supported by Pindie TUI v0.1.`);
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
  setTerminalTitle(title: string): void;
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

  private unsupported(capability: string): never {
    throw new UnsupportedExtensionUICapabilityError(capability);
  }

  setWidget(_key: string, _content: string[] | ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined, _options?: ExtensionWidgetOptions): void { this.unsupported("setWidget"); }
  setFooter(_factory: ((tui: TUI, theme: Theme, footerData: never) => Component & { dispose?(): void }) | undefined): void { this.unsupported("setFooter"); }
  setHeader(_factory: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined): void { this.unsupported("setHeader"); }
  custom: ExtensionUIContext["custom"] = async () => this.unsupported("custom");
  addAutocompleteProvider(_factory: AutocompleteProviderFactory): void { this.unsupported("addAutocompleteProvider"); }
  setEditorComponent: ExtensionUIContext["setEditorComponent"] = () => this.unsupported("setEditorComponent");
  getEditorComponent(): undefined { return this.unsupported("getEditorComponent"); }
  get theme(): Theme { return this.unsupported("theme"); }
  getAllThemes(): { name: string; path: string | undefined }[] { return this.unsupported("getAllThemes"); }
  getTheme(_name: string): Theme | undefined { return this.unsupported("getTheme"); }
  setTheme(_theme: string | Theme): { success: boolean; error?: string } { return this.unsupported("setTheme"); }
  getToolsExpanded(): boolean { return this.unsupported("getToolsExpanded"); }
  setToolsExpanded(_expanded: boolean): void { this.unsupported("setToolsExpanded"); }
}
