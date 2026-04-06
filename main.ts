import {
  Plugin,
  FileView,
  FileSystemAdapter,
  WorkspaceLeaf,
  TFile,
  PluginSettingTab,
  App,
  Setting,
  Notice,
  setIcon,
} from "obsidian";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type { AddressInfo } from "net";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import { html } from "@codemirror/lang-html";
import { syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching, foldGutter } from "@codemirror/language";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MIME Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm":  "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".mjs":  "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml":  "application/xml; charset=utf-8",
  ".svg":  "image/svg+xml; charset=utf-8",
  ".txt":  "text/plain; charset=utf-8",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif":  "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico":  "image/x-icon",
  ".woff": "font/woff",
  ".woff2":"font/woff2",
  ".ttf":  "font/ttf",
  ".otf":  "font/otf",
  ".eot":  "application/vnd.ms-fontobject",
  ".mp3":  "audio/mpeg",
  ".wav":  "audio/wav",
  ".ogg":  "audio/ogg",
  ".mp4":  "video/mp4",
  ".webm": "video/webm",
  ".pdf":  "application/pdf",
  ".wasm": "application/wasm",
  ".map":  "application/json",
};

const WATCHED_EXTENSIONS = new Set([
  ".html", ".htm", ".css", ".js", ".mjs", ".json", ".svg", ".xml",
]);

const CSS_EXTENSIONS = new Set([".css"]);

const VIEW_TYPE = "html-live-preview";
const EXTENSIONS = ["html", "htm"];
const SSE_PATH = "__hlp_events";
const ZOOM_STEP = 10;
const ZOOM_MIN = 30;
const ZOOM_MAX = 300;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Settings
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface HtmlPreviewSettings {
  allowScripts: boolean;
  showToolbar: boolean;
  autoReload: boolean;
  defaultZoom: number;
}

const DEFAULT_SETTINGS: HtmlPreviewSettings = {
  allowScripts: true,
  showToolbar: true,
  autoReload: true,
  defaultZoom: 100,
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SSE client script — injected into served HTML
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function buildInjectedScript(port: number, token: string): string {
  return `<script data-hlp-live>
(function(){
  var es=new EventSource("http://127.0.0.1:${port}/${token}/${SSE_PATH}");
  es.onmessage=function(e){
    if(e.data==="css"){
      document.querySelectorAll('link[rel="stylesheet"]').forEach(function(l){
        var h=l.getAttribute("href");
        if(h){var u=new URL(h,location.href);u.searchParams.set("_t",Date.now());l.setAttribute("href",u.toString())}
      });
    }else if(e.data==="full"){
      location.reload();
    }
  };
})();
</script>`;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// StaticServer — with SSE support
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class StaticServer {
  private server: http.Server | null = null;
  private port = 0;
  private vaultRoot: string;
  private token: string;
  private sseClients: Set<http.ServerResponse> = new Set();

  constructor(vaultRoot: string) {
    this.vaultRoot = path.resolve(vaultRoot);
    this.token = crypto.randomBytes(32).toString("hex");
  }

  getPort(): number { return this.port; }
  getToken(): string { return this.token; }

  getFileUrl(vaultRelativePath: string): string {
    const urlPath = vaultRelativePath.split(path.sep).join("/");
    return `http://127.0.0.1:${this.port}/${this.token}/${encodeURI(urlPath)}`;
  }

  broadcastReload(type: "css" | "full"): void {
    const msg = `data: ${type}\n\n`;
    for (const client of this.sseClients) {
      try { client.write(msg); } catch { /* client gone */ }
    }
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(this.handleRequest.bind(this));
      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server!.address() as AddressInfo;
        this.port = addr.port;
        console.log(`[HTML Live Preview] Server on port ${this.port}`);
        resolve(this.port);
      });
      this.server.on("error", reject);
    });
  }

  stop(): void {
    // Close all SSE connections
    for (const client of this.sseClients) {
      try { client.end(); } catch { /* ignore */ }
    }
    this.sseClients.clear();
    if (this.server) {
      this.server.close();
      this.server = null;
      console.log("[HTML Live Preview] Server stopped");
    }
  }

  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    const rawUrl = (req.url || "/").split("?")[0];
    const segments = rawUrl.split("/").filter(Boolean);

    // Token check
    if (segments.length === 0 || segments[0] !== this.token) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }

    // SSE endpoint
    if (segments.length === 2 && segments[1] === SSE_PATH) {
      this.handleSSE(res);
      return;
    }

    const fileParts = segments.slice(1).map(decodeURIComponent);
    const filePath = path.resolve(this.vaultRoot, ...fileParts);

    // Path traversal check
    if (!filePath.startsWith(this.vaultRoot + path.sep) && filePath !== this.vaultRoot) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden: path traversal detected");
      return;
    }

    let targetPath = filePath;
    try {
      const stat = fs.statSync(targetPath);
      if (stat.isDirectory()) {
        targetPath = path.join(targetPath, "index.html");
      }
    } catch { /* handled below */ }

    const ext = path.extname(targetPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    const isHtml = ext === ".html" || ext === ".htm";

    if (isHtml) {
      // For HTML: read file, inject SSE script, send
      this.serveHtmlWithInjection(targetPath, contentType, res);
    } else {
      // For other files: stream directly
      this.serveFileStream(targetPath, contentType, ext, res);
    }
  }

  private handleSSE(res: http.ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write("data: connected\n\n");
    this.sseClients.add(res);
    res.on("close", () => this.sseClients.delete(res));
  }

  private serveHtmlWithInjection(
    filePath: string,
    contentType: string,
    res: http.ServerResponse
  ): void {
    fs.readFile(filePath, "utf-8", (err, data) => {
      if (err) {
        this.sendError(res, err);
        return;
      }
      // Inject live reload script before </body> or at end
      const script = buildInjectedScript(this.port, this.token);
      let html: string;
      if (data.includes("</body>")) {
        html = data.replace("</body>", script + "</body>");
      } else if (data.includes("</html>")) {
        html = data.replace("</html>", script + "</html>");
      } else {
        html = data + script;
      }

      const buf = Buffer.from(html, "utf-8");
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": buf.length,
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache, no-store, must-revalidate",
      });
      res.end(buf);
    });
  }

  private serveFileStream(
    filePath: string,
    contentType: string,
    ext: string,
    res: http.ServerResponse
  ): void {
    const stream = fs.createReadStream(filePath);
    stream.on("open", () => {
      res.writeHead(200, {
        "Content-Type": contentType,
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=300",
      });
      stream.pipe(res);
    });
    stream.on("error", (err: NodeJS.ErrnoException) => this.sendError(res, err));
  }

  private sendError(res: http.ServerResponse, err: NodeJS.ErrnoException): void {
    if (err.code === "ENOENT") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("404 Not Found");
    } else {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("500 Internal Server Error");
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HtmlPreviewView
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

type ViewMode = "preview" | "source";

class HtmlPreviewView extends FileView {
  private server: StaticServer;
  private settings: HtmlPreviewSettings;

  // DOM refs
  private iframeEl: HTMLIFrameElement | null = null;
  private iframeWrapEl: HTMLElement | null = null;
  private toolbarEl: HTMLElement | null = null;
  private urlEl: HTMLElement | null = null;
  private zoomLabelEl: HTMLElement | null = null;
  private loadingEl: HTMLElement | null = null;
  private reloadIndicatorEl: HTMLElement | null = null;
  private autoReloadBtn: HTMLElement | null = null;
  private backBtn: HTMLElement | null = null;
  private forwardBtn: HTMLElement | null = null;
  private modeToggleBtn: HTMLElement | null = null;
  private sourceWrapEl: HTMLElement | null = null;
  private cmView: EditorView | null = null;

  // Directory watcher
  private dirWatcher: fs.FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Navigation history
  private navHistory: string[] = [];
  private navIndex = -1;
  private isNavigating = false;

  // State
  private zoom = 100;
  private autoReload = true;
  private viewMode: ViewMode = "preview";
  private sourceModified = false;

  constructor(leaf: WorkspaceLeaf, server: StaticServer, settings: HtmlPreviewSettings) {
    super(leaf);
    this.server = server;
    this.settings = settings;
    this.zoom = settings.defaultZoom;
    this.autoReload = settings.autoReload;
  }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return this.file?.name ?? "HTML Preview"; }
  getIcon(): string { return "globe"; }
  canAcceptExtension(extension: string): boolean { return EXTENSIONS.includes(extension); }

  async onLoadFile(file: TFile): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass("html-preview-container");

    this.navHistory = [];
    this.navIndex = -1;
    this.viewMode = "preview";
    this.sourceModified = false;

    const fileUrl = this.server.getFileUrl(file.path);

    // ── Toolbar ──
    if (this.settings.showToolbar) {
      this.toolbarEl = container.createDiv({ cls: "html-preview-toolbar" });
      this.buildToolbar(this.toolbarEl, file, fileUrl);
    }

    // ── Source editor (hidden by default) ──
    this.sourceWrapEl = container.createDiv({ cls: "html-preview-source-wrap" });
    this.sourceWrapEl.style.display = "none";

    const editorHeader = this.sourceWrapEl.createDiv({ cls: "html-preview-source-header" });
    const fileLabel = editorHeader.createSpan({ cls: "html-preview-source-label" });
    fileLabel.textContent = file.name;
    const modifiedBadge = editorHeader.createSpan({ cls: "html-preview-source-modified" });
    modifiedBadge.textContent = "Modified";
    const saveHint = editorHeader.createSpan({ cls: "html-preview-source-hint" });
    saveHint.textContent = "Cmd+S to save";

    const editorContainer = this.sourceWrapEl.createDiv({ cls: "html-preview-cm-wrap" });

    // Read file content
    const adapter = this.app.vault.adapter as FileSystemAdapter;
    const fullPath = adapter.getFullPath(file.path);
    let initialContent = "";
    try {
      initialContent = fs.readFileSync(fullPath, "utf-8");
    } catch { /* empty */ }

    // Save command for CM6 keymap
    const saveKeymap = keymap.of([{
      key: "Mod-s",
      run: () => { this.saveSource(); return true; },
    }]);

    // Track modifications via CM6 update listener
    const trackChanges = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        this.sourceModified = true;
        modifiedBadge.addClass("is-visible");
      }
    });

    // Create CodeMirror 6 editor
    this.cmView = new EditorView({
      parent: editorContainer,
      state: EditorState.create({
        doc: initialContent,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          foldGutter(),
          indentOnInput(),
          bracketMatching(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          html(),
          keymap.of([...defaultKeymap, indentWithTab]),
          saveKeymap,
          trackChanges,
          EditorView.lineWrapping,
          EditorView.theme({
            "&": { height: "100%", fontSize: "13px" },
            ".cm-scroller": { overflow: "auto", fontFamily: "var(--font-monospace)" },
            ".cm-content": { padding: "8px 0" },
            ".cm-gutters": {
              backgroundColor: "var(--background-secondary)",
              color: "var(--text-faint)",
              border: "none",
              borderRight: "1px solid var(--background-modifier-border)",
            },
            ".cm-activeLineGutter": { backgroundColor: "var(--background-modifier-hover)" },
            ".cm-activeLine": { backgroundColor: "var(--background-modifier-hover)" },
            "&.cm-focused .cm-cursor": { borderLeftColor: "var(--text-normal)" },
            "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
              backgroundColor: "var(--text-selection) !important",
            },
          }),
        ],
      }),
    });

    // ── Iframe wrapper ──
    this.iframeWrapEl = container.createDiv({ cls: "html-preview-iframe-wrap" });

    this.loadingEl = this.iframeWrapEl.createDiv({ cls: "html-preview-loading" });
    const spinner = this.loadingEl.createDiv({ cls: "html-preview-spinner" });
    setIcon(spinner, "loader");

    const sandboxValue = this.settings.allowScripts
      ? "allow-scripts allow-same-origin allow-popups allow-forms allow-modals"
      : "allow-same-origin";

    this.iframeEl = this.iframeWrapEl.createEl("iframe", {
      cls: "html-preview-iframe",
      attr: { sandbox: sandboxValue, src: fileUrl },
    });

    this.applyZoom();
    this.pushHistory(fileUrl);

    this.iframeEl.addEventListener("load", () => {
      this.loadingEl?.removeClass("is-active");
      try {
        const currentSrc = this.iframeEl?.contentWindow?.location.href;
        if (currentSrc && !this.isNavigating && currentSrc !== "about:blank") {
          this.pushHistory(currentSrc);
          this.updateUrlDisplay(currentSrc);
        }
      } catch { /* cross-origin */ }
      this.isNavigating = false;
      this.updateNavButtons();
    });

    this.loadingEl.addClass("is-active");

    // Smart directory watcher (sends SSE events instead of iframe.src swap)
    this.startDirectoryWatch(file);
  }

  async onUnloadFile(file: TFile): Promise<void> {
    this.stopDirectoryWatch();
    if (this.iframeEl) this.iframeEl.src = "about:blank";
    this.contentEl.empty();
    this.iframeEl = null;
    this.iframeWrapEl = null;
    this.toolbarEl = null;
    this.urlEl = null;
    this.zoomLabelEl = null;
    this.loadingEl = null;
    this.reloadIndicatorEl = null;
    this.autoReloadBtn = null;
    this.backBtn = null;
    this.forwardBtn = null;
    this.modeToggleBtn = null;
    this.sourceWrapEl = null;
    if (this.cmView) { this.cmView.destroy(); this.cmView = null; }
  }

  // ── Toolbar ──

  private buildToolbar(toolbar: HTMLElement, file: TFile, fileUrl: string): void {
    const navGroup = toolbar.createDiv({ cls: "html-preview-toolbar-group" });

    this.backBtn = this.createToolbarBtn(navGroup, "arrow-left", "Back", () => this.goBack());
    this.forwardBtn = this.createToolbarBtn(navGroup, "arrow-right", "Forward", () => this.goForward());
    this.backBtn.addClass("is-disabled");
    this.forwardBtn.addClass("is-disabled");

    this.createToolbarBtn(navGroup, "refresh-cw", "Reload", () => this.refreshIframe());

    // URL bar
    this.urlEl = toolbar.createDiv({ cls: "html-preview-url" });
    const urlIcon = this.urlEl.createSpan({ cls: "html-preview-url-icon" });
    setIcon(urlIcon, "globe");
    const urlText = this.urlEl.createSpan({ cls: "html-preview-url-text" });
    urlText.textContent = file.path;
    this.urlEl.addEventListener("click", () => {
      navigator.clipboard.writeText(fileUrl).then(() => new Notice("URL copied"));
    });
    this.urlEl.setAttribute("aria-label", "Click to copy URL");

    // Right group
    const rightGroup = toolbar.createDiv({ cls: "html-preview-toolbar-group" });

    // Mode toggle: preview ↔ source
    this.modeToggleBtn = this.createToolbarBtn(
      rightGroup, "code", "View source",
      () => this.toggleViewMode()
    );

    rightGroup.createDiv({ cls: "html-preview-separator" });

    // Auto-reload
    this.autoReloadBtn = this.createToolbarBtn(
      rightGroup, "zap",
      `Auto-reload: ${this.autoReload ? "ON" : "OFF"}`,
      () => this.toggleAutoReload()
    );
    if (this.autoReload) this.autoReloadBtn.addClass("is-active");

    this.reloadIndicatorEl = rightGroup.createDiv({ cls: "html-preview-reload-indicator" });
    this.reloadIndicatorEl.textContent = "reloaded";

    rightGroup.createDiv({ cls: "html-preview-separator" });

    // Zoom
    this.createToolbarBtn(rightGroup, "minus", "Zoom out", () => this.zoomOut());
    this.zoomLabelEl = rightGroup.createSpan({ cls: "html-preview-zoom-label" });
    this.zoomLabelEl.textContent = `${this.zoom}%`;
    this.zoomLabelEl.addEventListener("click", () => this.zoomReset());
    this.zoomLabelEl.setAttribute("aria-label", "Reset zoom");
    this.createToolbarBtn(rightGroup, "plus", "Zoom in", () => this.zoomIn());

    rightGroup.createDiv({ cls: "html-preview-separator" });

    this.createToolbarBtn(rightGroup, "external-link", "Open in browser", () => {
      if (this.file) window.open(this.server.getFileUrl(this.file.path));
    });
  }

  private createToolbarBtn(
    parent: HTMLElement, icon: string, label: string, onClick: () => void
  ): HTMLElement {
    const btn = parent.createEl("button", {
      cls: "html-preview-toolbar-btn clickable-icon",
      attr: { "aria-label": label },
    });
    setIcon(btn, icon);
    btn.addEventListener("click", onClick);
    return btn;
  }

  // ── View Mode Toggle ──

  private toggleViewMode(): void {
    if (this.viewMode === "preview") {
      this.switchToSource();
    } else {
      this.switchToPreview();
    }
  }

  private switchToSource(): void {
    this.viewMode = "source";
    if (this.iframeWrapEl) this.iframeWrapEl.style.display = "none";
    if (this.sourceWrapEl) this.sourceWrapEl.style.display = "flex";

    // Reload source content from disk
    if (this.cmView && this.file) {
      const adapter = this.app.vault.adapter as FileSystemAdapter;
      const fullPath = adapter.getFullPath(this.file.path);
      try {
        const content = fs.readFileSync(fullPath, "utf-8");
        this.cmView.dispatch({
          changes: { from: 0, to: this.cmView.state.doc.length, insert: content },
        });
        this.sourceModified = false;
        this.sourceWrapEl?.querySelector(".html-preview-source-modified")
          ?.removeClass("is-visible");
      } catch { /* keep current */ }
    }

    // Update toggle button icon
    if (this.modeToggleBtn) {
      this.modeToggleBtn.empty();
      setIcon(this.modeToggleBtn, "eye");
      this.modeToggleBtn.setAttribute("aria-label", "View preview");
      this.modeToggleBtn.addClass("is-active");
    }
  }

  private switchToPreview(): void {
    this.viewMode = "preview";
    if (this.sourceWrapEl) this.sourceWrapEl.style.display = "none";
    if (this.iframeWrapEl) this.iframeWrapEl.style.display = "";

    // If source was modified and saved, refresh iframe
    this.refreshIframe();

    if (this.modeToggleBtn) {
      this.modeToggleBtn.empty();
      setIcon(this.modeToggleBtn, "code");
      this.modeToggleBtn.setAttribute("aria-label", "View source");
      this.modeToggleBtn.removeClass("is-active");
    }
  }

  private async saveSource(): Promise<void> {
    if (!this.cmView || !this.file) return;
    const adapter = this.app.vault.adapter as FileSystemAdapter;
    const fullPath = adapter.getFullPath(this.file.path);
    try {
      fs.writeFileSync(fullPath, this.cmView.state.doc.toString(), "utf-8");
      this.sourceModified = false;
      this.sourceWrapEl?.querySelector(".html-preview-source-modified")
        ?.removeClass("is-visible");
      new Notice("Saved");
    } catch (err) {
      new Notice("Failed to save file");
      console.error("[HTML Live Preview] Save error:", err);
    }
  }

  // ── Navigation ──

  private pushHistory(url: string): void {
    if (this.navHistory[this.navIndex] === url) return;
    this.navHistory = this.navHistory.slice(0, this.navIndex + 1);
    this.navHistory.push(url);
    this.navIndex = this.navHistory.length - 1;
    this.updateNavButtons();
  }

  private goBack(): void {
    if (this.navIndex <= 0) return;
    this.isNavigating = true;
    this.navIndex--;
    this.navigateTo(this.navHistory[this.navIndex]);
  }

  private goForward(): void {
    if (this.navIndex >= this.navHistory.length - 1) return;
    this.isNavigating = true;
    this.navIndex++;
    this.navigateTo(this.navHistory[this.navIndex]);
  }

  private navigateTo(url: string): void {
    if (this.iframeEl) {
      this.loadingEl?.addClass("is-active");
      this.iframeEl.src = url;
      this.updateUrlDisplay(url);
      this.updateNavButtons();
    }
  }

  private updateNavButtons(): void {
    this.backBtn?.toggleClass("is-disabled", this.navIndex <= 0);
    this.forwardBtn?.toggleClass("is-disabled", this.navIndex >= this.navHistory.length - 1);
  }

  private updateUrlDisplay(url: string): void {
    if (!this.urlEl) return;
    const textEl = this.urlEl.querySelector(".html-preview-url-text");
    if (!textEl) return;
    const token = this.server.getToken();
    const stripped = url.replace(`/${token}/`, "/").replace(/^http:\/\/127\.0\.0\.1:\d+\//, "");
    textEl.textContent = decodeURIComponent(stripped) || "/";
  }

  // ── Zoom ──

  private applyZoom(): void {
    if (!this.iframeEl) return;
    if (this.zoom === 100) {
      this.iframeEl.style.transform = "";
      this.iframeEl.style.width = "100%";
      this.iframeEl.style.height = "100%";
    } else {
      const scale = this.zoom / 100;
      this.iframeEl.style.transform = `scale(${scale})`;
      this.iframeEl.style.transformOrigin = "0 0";
      this.iframeEl.style.width = `${100 / scale}%`;
      this.iframeEl.style.height = `${100 / scale}%`;
    }
    if (this.zoomLabelEl) this.zoomLabelEl.textContent = `${this.zoom}%`;
  }

  private zoomIn(): void { this.zoom = Math.min(ZOOM_MAX, this.zoom + ZOOM_STEP); this.applyZoom(); }
  private zoomOut(): void { this.zoom = Math.max(ZOOM_MIN, this.zoom - ZOOM_STEP); this.applyZoom(); }
  private zoomReset(): void { this.zoom = 100; this.applyZoom(); }

  // ── Auto Reload ──

  private toggleAutoReload(): void {
    this.autoReload = !this.autoReload;
    this.autoReloadBtn?.toggleClass("is-active", this.autoReload);
    this.autoReloadBtn?.setAttribute("aria-label", `Auto-reload: ${this.autoReload ? "ON" : "OFF"}`);
    if (this.autoReload && this.file) {
      this.startDirectoryWatch(this.file);
    } else {
      this.stopDirectoryWatch();
    }
  }

  // ── Refresh ──

  refreshIframe(): void {
    if (this.iframeEl && this.file) {
      this.loadingEl?.addClass("is-active");
      this.iframeEl.src = this.server.getFileUrl(this.file.path) + "?t=" + Date.now();
    }
  }

  private flashReloadIndicator(): void {
    if (!this.reloadIndicatorEl) return;
    this.reloadIndicatorEl.addClass("is-visible");
    setTimeout(() => this.reloadIndicatorEl?.removeClass("is-visible"), 1200);
  }

  // ── Smart Directory Watch — sends SSE events ──

  private startDirectoryWatch(file: TFile): void {
    this.stopDirectoryWatch();
    if (!this.autoReload) return;

    try {
      const adapter = this.app.vault.adapter as FileSystemAdapter;
      const fullPath = adapter.getFullPath(file.path);
      const dirPath = path.dirname(fullPath);

      this.dirWatcher = fs.watch(
        dirPath,
        { recursive: true, persistent: false },
        (_eventType, filename) => {
          if (!filename) return;
          const ext = path.extname(filename).toLowerCase();
          if (!WATCHED_EXTENSIONS.has(ext)) return;

          if (this.debounceTimer) clearTimeout(this.debounceTimer);
          this.debounceTimer = setTimeout(() => {
            const reloadType = CSS_EXTENSIONS.has(ext) ? "css" : "full";
            this.server.broadcastReload(reloadType as "css" | "full");
            this.flashReloadIndicator();
          }, 300);
        }
      );
    } catch { /* non-critical */ }
  }

  private stopDirectoryWatch(): void {
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    if (this.dirWatcher) { this.dirWatcher.close(); this.dirWatcher = null; }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SettingTab
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class HtmlPreviewSettingTab extends PluginSettingTab {
  plugin: HtmlLivePreviewPlugin;

  constructor(app: App, plugin: HtmlLivePreviewPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "HTML Live Preview" });

    new Setting(containerEl).setHeading().setName("Preview");

    new Setting(containerEl)
      .setName("Allow scripts")
      .setDesc("Allow JavaScript execution in HTML previews. Disable for untrusted content.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.allowScripts).onChange(async (v) => {
          this.plugin.settings.allowScripts = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Default zoom")
      .setDesc("Default zoom level for new preview tabs (30%–300%).")
      .addSlider((s) =>
        s.setLimits(30, 300, 10)
          .setValue(this.plugin.settings.defaultZoom)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.defaultZoom = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl).setHeading().setName("Toolbar");

    new Setting(containerEl)
      .setName("Show toolbar")
      .setDesc("Show the navigation bar and controls above the preview.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showToolbar).onChange(async (v) => {
          this.plugin.settings.showToolbar = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl).setHeading().setName("Live reload");

    new Setting(containerEl)
      .setName("Auto-reload on file changes")
      .setDesc(
        "Automatically refresh when HTML, CSS, or JS files change. " +
        "CSS changes are hot-swapped without losing page state."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoReload).onChange(async (v) => {
          this.plugin.settings.autoReload = v;
          await this.plugin.saveSettings();
        })
      );
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Plugin
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export default class HtmlLivePreviewPlugin extends Plugin {
  private server: StaticServer | null = null;
  settings: HtmlPreviewSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    await this.loadSettings();

    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      new Notice("HTML Live Preview requires the desktop app.");
      return;
    }

    this.server = new StaticServer(adapter.getBasePath());
    try {
      const port = await this.server.start();
      new Notice(`HTML Live Preview ready (port ${port})`);
    } catch (err) {
      console.error("[HTML Live Preview] Server start failed:", err);
      new Notice("HTML Live Preview: Failed to start local server.");
      return;
    }

    this.registerView(VIEW_TYPE, (leaf) =>
      new HtmlPreviewView(leaf, this.server!, this.settings)
    );
    this.registerExtensions(EXTENSIONS, VIEW_TYPE);

    this.addCommand({
      id: "reload-html-preview",
      name: "Reload HTML preview",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(HtmlPreviewView);
        if (view) {
          if (!checking) view.refreshIframe();
          return true;
        }
        return false;
      },
    });

    this.addSettingTab(new HtmlPreviewSettingTab(this.app, this));
  }

  async onunload(): Promise<void> {
    this.server?.stop();
  }

  async loadSettings(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
