import {
  Plugin,
  FileView,
  FileSystemAdapter,
  WorkspaceLeaf,
  TFile,
  TAbstractFile,
  PluginSettingTab,
  App,
  Setting,
  Notice,
  Modal,
  Menu,
  EventRef,
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
// Device presets for responsive testing
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface DevicePreset {
  id: string;
  name: string;
  width: number | null;
  height: number | null;
  icon: string;
  category: "responsive" | "desktop" | "tablet" | "mobile";
}

const DEVICE_PRESETS: DevicePreset[] = [
  { id: "full",     name: "Responsive", width: null, height: null, icon: "maximize-2", category: "responsive" },
  { id: "desktop",  name: "Desktop",    width: 1440, height: 900,  icon: "monitor",    category: "desktop"    },
  { id: "laptop",   name: "Laptop",     width: 1366, height: 768,  icon: "laptop",     category: "desktop"    },
  { id: "tablet",   name: "Tablet",     width: 768,  height: 1024, icon: "tablet",     category: "tablet"     },
  { id: "mobilel",  name: "Mobile L",   width: 414,  height: 896,  icon: "smartphone", category: "mobile"     },
  { id: "mobile",   name: "Mobile M",   width: 375,  height: 667,  icon: "smartphone", category: "mobile"     },
  { id: "mobiles",  name: "Mobile S",   width: 320,  height: 568,  icon: "smartphone", category: "mobile"     },
];

function findDevicePreset(id: string): DevicePreset {
  return DEVICE_PRESETS.find((p) => p.id === id) ?? DEVICE_PRESETS[0];
}

function formatPresetLabel(preset: DevicePreset): string {
  if (preset.width === null || preset.height === null) return preset.name;
  return `${preset.name} ${preset.width}×${preset.height}`;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Settings
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface SandboxFlags {
  scripts: boolean;
  popups: boolean;
  forms: boolean;
  modals: boolean;
  downloads: boolean;
  topNavigation: boolean;
  pointerLock: boolean;
}

interface HtmlPreviewSettings {
  sandboxFlags: SandboxFlags;
  showToolbar: boolean;
  autoReload: boolean;
  defaultZoom: number;
  defaultDevice: string;
  warnUnsavedClose: boolean;
  verboseLogging: boolean;
  alwaysOpenInNewTab: boolean;
}

const DEFAULT_SETTINGS: HtmlPreviewSettings = {
  sandboxFlags: {
    scripts: true,
    popups: true,
    forms: true,
    modals: true,
    downloads: false,
    topNavigation: false,
    pointerLock: false,
  },
  showToolbar: true,
  autoReload: true,
  defaultZoom: 100,
  defaultDevice: "full",
  warnUnsavedClose: true,
  verboseLogging: false,
  alwaysOpenInNewTab: false,
};

function buildSandboxValue(flags: SandboxFlags): string {
  const parts = ["allow-same-origin"];
  if (flags.scripts) parts.push("allow-scripts");
  if (flags.popups) parts.push("allow-popups");
  if (flags.forms) parts.push("allow-forms");
  if (flags.modals) parts.push("allow-modals");
  if (flags.downloads) parts.push("allow-downloads");
  if (flags.topNavigation) parts.push("allow-top-navigation");
  if (flags.pointerLock) parts.push("allow-pointer-lock");
  return parts.join(" ");
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Logger
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class Logger {
  private prefix = "[HTML Live Preview]";
  constructor(private getVerbose: () => boolean) {}
  debug(...args: unknown[]): void {
    if (this.getVerbose()) console.log(this.prefix, ...args);
  }
  info(...args: unknown[]): void { console.log(this.prefix, ...args); }
  warn(...args: unknown[]): void { console.warn(this.prefix, ...args); }
  error(...args: unknown[]): void { console.error(this.prefix, ...args); }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Confirm Modal (theme-aware replacement for window.confirm)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class ConfirmModal extends Modal {
  constructor(
    app: App,
    private modalTitle: string,
    private message: string,
    private confirmLabel: string,
    private onConfirm: () => void,
    private confirmIsWarning = true
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText(this.modalTitle);
    contentEl.createEl("p", { text: this.message });
    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    const cancelBtn = buttons.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());
    const confirmBtn = buttons.createEl("button", {
      text: this.confirmLabel,
      cls: this.confirmIsWarning ? "mod-warning" : "mod-cta",
    });
    confirmBtn.addEventListener("click", () => {
      this.close();
      this.onConfirm();
    });
    window.setTimeout(() => confirmBtn.focus(), 0);
  }

  onClose(): void { this.contentEl.empty(); }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SSE client + keyboard + error forwarder script
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function buildInjectedScript(port: number, token: string): string {
  return `<script data-hlp-live>
(function(){
  var TOK="${token}";
  var es=new EventSource("http://127.0.0.1:${port}/"+TOK+"/${SSE_PATH}");
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
  function send(msg){try{window.parent.postMessage(msg,"*")}catch(e){}}
  document.addEventListener("keydown",function(e){
    if(e.metaKey||e.ctrlKey){
      if(e.key==="w"){e.preventDefault();send({hlp:"close",tok:TOK});}
      else if(e.key==="r"){e.preventDefault();send({hlp:"reload",tok:TOK});}
      else if(e.key==="="||e.key==="+"){e.preventDefault();send({hlp:"zoomIn",tok:TOK});}
      else if(e.key==="-"){e.preventDefault();send({hlp:"zoomOut",tok:TOK});}
      else if(e.key==="0"){e.preventDefault();send({hlp:"zoomReset",tok:TOK});}
      else if(e.key==="["){e.preventDefault();send({hlp:"back",tok:TOK});}
      else if(e.key==="]"){e.preventDefault();send({hlp:"forward",tok:TOK});}
    }
  });
  window.addEventListener("error",function(e){
    send({hlp:"error",tok:TOK,msg:e.message||"Script error",src:e.filename||"",line:e.lineno||0,col:e.colno||0});
  });
  window.addEventListener("unhandledrejection",function(e){
    var r=e.reason;
    var msg="Unhandled promise rejection";
    if(r){msg+=": "+(r&&r.message?r.message:String(r))}
    send({hlp:"error",tok:TOK,msg:msg,src:"",line:0,col:0});
  });
})();
</script>`;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Dependency parser (HTML → set of vault-relative paths)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function parseDependencies(htmlContent: string, htmlVaultPath: string): Set<string> {
  const deps = new Set<string>();
  deps.add(htmlVaultPath);

  // Use POSIX paths inside the vault
  const posixPath = htmlVaultPath.split(path.sep).join("/");
  const baseDir = path.posix.dirname(posixPath);

  const patterns = [
    /<link[^>]+href=["']([^"']+)["']/gi,
    /<script[^>]+src=["']([^"']+)["']/gi,
    /<img[^>]+src=["']([^"']+)["']/gi,
    /<source[^>]+src=["']([^"']+)["']/gi,
    /<video[^>]+src=["']([^"']+)["']/gi,
    /<audio[^>]+src=["']([^"']+)["']/gi,
    /<iframe[^>]+src=["']([^"']+)["']/gi,
    /url\(\s*["']?([^"')]+)["']?\s*\)/gi,
    /@import\s+["']([^"']+)["']/gi,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(htmlContent)) !== null) {
      const raw = match[1];
      if (!raw) continue;
      if (/^(https?:|data:|\/\/|file:|blob:|mailto:|tel:|#|javascript:)/i.test(raw)) continue;
      const cleanUrl = raw.split("?")[0].split("#")[0];
      if (!cleanUrl) continue;
      const resolved = cleanUrl.startsWith("/")
        ? path.posix.normalize(cleanUrl.slice(1))
        : path.posix.normalize(path.posix.join(baseDir, cleanUrl));
      if (resolved && !resolved.startsWith("..")) {
        deps.add(resolved);
      }
    }
  }
  return deps;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// StaticServer - with SSE support
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class StaticServer {
  private server: http.Server | null = null;
  private port = 0;
  private vaultRoot: string;
  private realVaultRoot: string;
  private token: string;
  private sseClients: Set<http.ServerResponse> = new Set();
  private logger: Logger;

  constructor(vaultRoot: string, logger: Logger) {
    this.vaultRoot = path.resolve(vaultRoot);
    try {
      this.realVaultRoot = fs.realpathSync(this.vaultRoot);
    } catch {
      this.realVaultRoot = this.vaultRoot;
    }
    this.token = crypto.randomBytes(32).toString("hex");
    this.logger = logger;
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
      try { client.write(msg); } catch { this.sseClients.delete(client); }
    }
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(this.handleRequest.bind(this));
      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server!.address() as AddressInfo;
        this.port = addr.port;
        this.logger.info(`Server listening on port ${this.port}`);
        resolve(this.port);
      });
      this.server.on("error", reject);
    });
  }

  stop(): void {
    for (const client of this.sseClients) {
      try { client.end(); } catch { /* ignore */ }
    }
    this.sseClients.clear();
    if (this.server) {
      this.server.close();
      this.server = null;
      this.logger.info("Server stopped");
    }
  }

  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    const rawUrl = (req.url || "/").split("?")[0];
    const segments = rawUrl.split("/").filter(Boolean);

    if (segments.length === 0 || segments[0] !== this.token) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }

    if (segments.length === 2 && segments[1] === SSE_PATH) {
      this.handleSSE(res);
      return;
    }

    const fileParts = segments.slice(1).map(decodeURIComponent);
    const filePath = path.resolve(this.vaultRoot, ...fileParts);

    let realPath: string;
    try {
      realPath = fs.realpathSync(filePath);
    } catch {
      realPath = filePath;
    }
    if (!realPath.startsWith(this.realVaultRoot + path.sep) && realPath !== this.realVaultRoot) {
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
      this.serveHtmlWithInjection(targetPath, contentType, res);
    } else {
      this.serveFileStream(targetPath, contentType, res);
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
    const cleanup = () => this.sseClients.delete(res);
    res.on("close", cleanup);
    res.on("error", cleanup);
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
      const script = buildInjectedScript(this.port, this.token);
      let result: string;
      const headIdx = data.lastIndexOf("</head>");
      if (headIdx !== -1) {
        result = data.slice(0, headIdx) + script + data.slice(headIdx);
      } else {
        const bodyIdx = data.lastIndexOf("</body>");
        if (bodyIdx !== -1) {
          result = data.slice(0, bodyIdx) + script + data.slice(bodyIdx);
        } else {
          result = data + script;
        }
      }

      const buf = Buffer.from(result, "utf-8");
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
  plugin: HtmlLivePreviewPlugin;
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
  private deviceBtn: HTMLElement | null = null;
  private copyBtn: HTMLElement | null = null;
  private sourceWrapEl: HTMLElement | null = null;
  private cmEditorContainer: HTMLElement | null = null;
  private modifiedBadge: HTMLElement | null = null;

  // CM6 lazy-loaded: only created on first source view
  private cmView: EditorView | null = null;

  // Vault event handler ref for cleanup
  private vaultModifyRef: EventRef | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private messageHandler: ((e: MessageEvent) => void) | null = null;

  // Navigation history
  private navHistory: string[] = [];
  private navIndex = -1;
  private isNavigating = false;

  // State
  private zoom = 100;
  private autoReload = true;
  private viewMode: ViewMode = "preview";
  private sourceModified = false;
  private currentDevice: DevicePreset = DEVICE_PRESETS[0];
  private dependencies: Set<string> = new Set();

  constructor(leaf: WorkspaceLeaf, plugin: HtmlLivePreviewPlugin, server: StaticServer, settings: HtmlPreviewSettings) {
    super(leaf);
    this.plugin = plugin;
    this.server = server;
    this.settings = settings;
    this.zoom = settings.defaultZoom;
    this.autoReload = settings.autoReload;
    this.currentDevice = findDevicePreset(settings.defaultDevice);
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
    this.cmView = null;

    const fileUrl = this.server.getFileUrl(file.path);

    // ── Toolbar ──
    if (this.settings.showToolbar) {
      this.toolbarEl = container.createDiv({ cls: "html-preview-toolbar" });
      this.buildToolbar(this.toolbarEl, file);
    }

    // ── Source editor shell (hidden, CM6 lazy-loaded on first toggle) ──
    this.sourceWrapEl = container.createDiv({ cls: "html-preview-source-wrap" });
    this.sourceWrapEl.style.display = "none";

    const editorHeader = this.sourceWrapEl.createDiv({ cls: "html-preview-source-header" });
    const fileLabel = editorHeader.createSpan({ cls: "html-preview-source-label" });
    fileLabel.textContent = file.name;
    this.modifiedBadge = editorHeader.createSpan({ cls: "html-preview-source-modified" });
    this.modifiedBadge.textContent = "Modified";
    const saveHint = editorHeader.createSpan({ cls: "html-preview-source-hint" });
    saveHint.textContent = "Cmd+S to save";

    this.cmEditorContainer = this.sourceWrapEl.createDiv({ cls: "html-preview-cm-wrap" });

    // ── Iframe wrapper ──
    this.iframeWrapEl = container.createDiv({ cls: "html-preview-iframe-wrap" });

    this.loadingEl = this.iframeWrapEl.createDiv({ cls: "html-preview-loading" });
    const spinner = this.loadingEl.createDiv({ cls: "html-preview-spinner" });
    setIcon(spinner, "loader");

    const sandboxValue = buildSandboxValue(this.settings.sandboxFlags);

    this.iframeEl = this.iframeWrapEl.createEl("iframe", {
      cls: "html-preview-iframe",
      attr: { sandbox: sandboxValue, src: fileUrl },
    });

    this.applyDimensions();
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

    // Message handler: only respond to OUR iframe
    this.messageHandler = (e: MessageEvent) => {
      if (!this.iframeEl) return;
      if (e.source !== this.iframeEl.contentWindow) return;
      const data = e.data as { hlp?: string; tok?: string; msg?: string; src?: string; line?: number; col?: number };
      if (!data || data.tok !== this.server.getToken()) return;

      switch (data.hlp) {
        case "close":     this.closeTab(); break;
        case "reload":    this.refreshIframe(); break;
        case "zoomIn":    this.zoomIn(); break;
        case "zoomOut":   this.zoomOut(); break;
        case "zoomReset": this.zoomReset(); break;
        case "back":      this.goBack(); break;
        case "forward":   this.goForward(); break;
        case "error": {
          const loc = data.src ? ` (${data.src}:${data.line}:${data.col})` : "";
          this.plugin.logger.error(`iframe: ${data.msg}${loc}`);
          break;
        }
      }
    };
    window.addEventListener("message", this.messageHandler);

    // Container-level keyboard fallback (when iframe is NOT focused)
    this.registerDomEvent(this.contentEl, "keydown", (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      switch (e.key) {
        case "w": e.preventDefault(); this.closeTab(); break;
        case "r": e.preventDefault(); this.refreshIframe(); break;
        case "=": case "+": e.preventDefault(); this.zoomIn(); break;
        case "-": e.preventDefault(); this.zoomOut(); break;
        case "0": e.preventDefault(); this.zoomReset(); break;
        case "[": e.preventDefault(); this.goBack(); break;
        case "]": e.preventDefault(); this.goForward(); break;
      }
    });

    // Parse dependencies for accurate auto-reload
    await this.refreshDependencies(file);
    this.startVaultWatch();
  }

  async onUnloadFile(_file: TFile): Promise<void> {
    this.stopVaultWatch();
    if (this.messageHandler) {
      window.removeEventListener("message", this.messageHandler);
      this.messageHandler = null;
    }
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
    this.deviceBtn = null;
    this.copyBtn = null;
    this.sourceWrapEl = null;
    this.cmEditorContainer = null;
    this.modifiedBadge = null;
    if (this.cmView) { this.cmView.destroy(); this.cmView = null; }
    this.sourceModified = false;
    this.dependencies.clear();
  }

  // ── Lazy-create CM6 editor on first source view ──

  private async ensureEditor(): Promise<void> {
    if (this.cmView || !this.cmEditorContainer || !this.file) return;

    let initialContent = "";
    try {
      initialContent = await this.app.vault.read(this.file);
    } catch (err) {
      this.plugin.logger.error("Failed to read source:", err);
    }

    const saveKeymap = keymap.of([{
      key: "Mod-s",
      run: () => { void this.saveSource(); return true; },
    }]);

    const trackChanges = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        this.sourceModified = true;
        this.modifiedBadge?.addClass("is-visible");
      }
    });

    this.cmView = new EditorView({
      parent: this.cmEditorContainer,
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
  }

  // ── Toolbar ──

  private buildToolbar(toolbar: HTMLElement, file: TFile): void {
    const navGroup = toolbar.createDiv({ cls: "html-preview-toolbar-group" });

    this.backBtn = this.createToolbarBtn(navGroup, "arrow-left", "Back (Cmd+[)", () => this.goBack());
    this.forwardBtn = this.createToolbarBtn(navGroup, "arrow-right", "Forward (Cmd+])", () => this.goForward());
    this.backBtn.addClass("is-disabled");
    this.forwardBtn.addClass("is-disabled");

    this.createToolbarBtn(navGroup, "refresh-cw", "Reload (Cmd+R)", () => this.refreshIframe());

    // Editable URL bar with autocomplete for vault HTML files
    this.urlEl = toolbar.createDiv({ cls: "html-preview-url" });
    const urlIcon = this.urlEl.createSpan({ cls: "html-preview-url-icon" });
    setIcon(urlIcon, "globe");
    const urlText = this.urlEl.createSpan({ cls: "html-preview-url-text" });
    urlText.textContent = file.path;

    const urlInput = this.urlEl.createEl("input", {
      cls: "html-preview-url-input",
      attr: { type: "text", spellcheck: "false", autocomplete: "off" },
    });
    urlInput.style.display = "none";
    urlInput.value = file.path;

    // Autocomplete dropdown
    const dropdown = this.urlEl.createDiv({ cls: "html-preview-url-dropdown" });
    let selectedIdx = -1;
    let currentItems: HTMLElement[] = [];

    const showDropdown = (query: string) => {
      dropdown.empty();
      currentItems = [];
      selectedIdx = -1;
      const q = query.toLowerCase();
      const matches = this.plugin.getHtmlFiles().filter(p => p.toLowerCase().includes(q));
      if (matches.length === 0) {
        dropdown.style.display = "none";
        return;
      }
      for (const m of matches.slice(0, 12)) {
        const item = dropdown.createDiv({ cls: "html-preview-url-dropdown-item" });
        const lowerM = m.toLowerCase();
        const idx = lowerM.indexOf(q);
        if (q && idx !== -1) {
          item.appendText(m.slice(0, idx));
          const mark = item.createEl("strong");
          mark.textContent = m.slice(idx, idx + q.length);
          item.appendText(m.slice(idx + q.length));
        } else {
          item.textContent = m;
        }
        item.addEventListener("mousedown", (e) => {
          e.preventDefault();
          urlInput.value = m;
          dropdown.style.display = "none";
          this.navigateToVaultPath(m);
          urlText.style.display = "";
          urlInput.style.display = "none";
        });
        currentItems.push(item);
      }
      dropdown.style.display = "block";
    };

    const hideDropdown = () => {
      dropdown.style.display = "none";
      selectedIdx = -1;
      currentItems = [];
    };

    const updateSelection = () => {
      currentItems.forEach((el, i) => {
        el.toggleClass("is-selected", i === selectedIdx);
      });
      if (selectedIdx >= 0 && currentItems[selectedIdx]) {
        currentItems[selectedIdx].scrollIntoView({ block: "nearest" });
      }
    };

    this.urlEl.addEventListener("click", (e) => {
      if (urlInput.style.display === "none") {
        urlText.style.display = "none";
        urlInput.style.display = "";
        urlInput.value = urlText.textContent || "";
        urlInput.focus();
        urlInput.select();
        showDropdown(urlInput.value);
        e.stopPropagation();
      }
    });

    urlInput.addEventListener("input", () => {
      showDropdown(urlInput.value.trim());
    });

    urlInput.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (currentItems.length > 0) {
          selectedIdx = Math.min(selectedIdx + 1, currentItems.length - 1);
          updateSelection();
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (currentItems.length > 0) {
          selectedIdx = Math.max(selectedIdx - 1, 0);
          updateSelection();
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        let target: string;
        if (selectedIdx >= 0 && currentItems[selectedIdx]) {
          target = this.plugin.getHtmlFiles().filter(p =>
            p.toLowerCase().includes(urlInput.value.trim().toLowerCase())
          )[selectedIdx] || urlInput.value.trim();
        } else {
          target = urlInput.value.trim();
        }
        hideDropdown();
        if (target) {
          this.navigateToVaultPath(target);
        }
        urlText.style.display = "";
        urlInput.style.display = "none";
      } else if (e.key === "Escape") {
        hideDropdown();
        urlText.style.display = "";
        urlInput.style.display = "none";
      }
    });

    urlInput.addEventListener("blur", () => {
      hideDropdown();
      urlText.style.display = "";
      urlInput.style.display = "none";
    });

    this.urlEl.setAttribute("aria-label", "Click to search files");

    // Right group
    const rightGroup = toolbar.createDiv({ cls: "html-preview-toolbar-group" });

    this.modeToggleBtn = this.createToolbarBtn(
      rightGroup, "code", "View source",
      () => void this.toggleViewMode()
    );

    // Device preset selector
    this.deviceBtn = this.createToolbarBtn(
      rightGroup, "monitor", `Viewport: ${formatPresetLabel(this.currentDevice)}`,
      () => this.showDeviceMenu()
    );
    if (this.currentDevice.id !== "full") this.deviceBtn.addClass("is-active");

    // Copy path menu button
    this.copyBtn = this.createToolbarBtn(
      rightGroup, "copy", "Copy path / URL",
      () => this.showCopyMenu()
    );

    rightGroup.createDiv({ cls: "html-preview-separator" });

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
    this.createToolbarBtn(rightGroup, "minus", "Zoom out (Cmd+-)", () => this.zoomOut());
    this.zoomLabelEl = rightGroup.createSpan({ cls: "html-preview-zoom-label" });
    this.zoomLabelEl.textContent = `${this.zoom}%`;
    this.zoomLabelEl.addEventListener("click", () => this.zoomReset());
    this.zoomLabelEl.setAttribute("aria-label", "Reset zoom (Cmd+0)");
    this.createToolbarBtn(rightGroup, "plus", "Zoom in (Cmd+=)", () => this.zoomIn());

    rightGroup.createDiv({ cls: "html-preview-separator" });

    this.createToolbarBtn(rightGroup, "external-link", "Open in browser", () => this.openExternal());
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

  // ── Copy / device menus ──

  private showCopyMenu(): void {
    if (!this.file) return;
    const menu = new Menu();
    menu.addItem((item) =>
      item.setTitle("Copy vault path")
        .setIcon("file-text")
        .onClick(() => this.copyVaultPath())
    );
    menu.addItem((item) =>
      item.setTitle("Copy system path")
        .setIcon("hard-drive")
        .onClick(() => this.copySystemPath())
    );
    menu.addItem((item) =>
      item.setTitle("Copy preview URL")
        .setIcon("link")
        .onClick(() => this.copyPreviewUrl())
    );
    menu.addItem((item) =>
      item.setTitle("Copy file://… URL")
        .setIcon("globe")
        .onClick(() => this.copyFileUrl())
    );
    if (this.copyBtn) {
      const rect = this.copyBtn.getBoundingClientRect();
      menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
    }
  }

  private showDeviceMenu(): void {
    const menu = new Menu();

    let lastCategory: string | null = null;
    for (const preset of DEVICE_PRESETS) {
      if (lastCategory !== null && preset.category !== lastCategory) {
        menu.addSeparator();
      }
      lastCategory = preset.category;

      const isActive = this.currentDevice.id === preset.id;
      menu.addItem((item) => {
        item.setTitle(formatPresetLabel(preset))
          .setIcon(preset.icon)
          .setChecked(isActive)
          .onClick(() => this.applyDevicePreset(preset));
      });
    }

    if (this.deviceBtn) {
      const rect = this.deviceBtn.getBoundingClientRect();
      menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
    }
  }

  // ── Public actions (also used by commands) ──

  copyVaultPath(): void {
    if (!this.file) return;
    void navigator.clipboard.writeText(this.file.path);
    new Notice(`Copied vault path: ${this.file.path}`);
  }

  copySystemPath(): void {
    if (!this.file) return;
    const adapter = this.app.vault.adapter as FileSystemAdapter;
    const fullPath = adapter.getFullPath(this.file.path);
    void navigator.clipboard.writeText(fullPath);
    new Notice(`Copied system path: ${fullPath}`);
  }

  copyPreviewUrl(): void {
    if (!this.file) return;
    const url = this.server.getFileUrl(this.file.path);
    void navigator.clipboard.writeText(url);
    new Notice("Copied preview URL");
  }

  copyFileUrl(): void {
    if (!this.file) return;
    const adapter = this.app.vault.adapter as FileSystemAdapter;
    const fullPath = adapter.getFullPath(this.file.path);
    const fileUrl = "file://" + fullPath.split(path.sep).join("/");
    void navigator.clipboard.writeText(fileUrl);
    new Notice("Copied file:// URL");
  }

  openExternal(): void {
    if (!this.file) return;
    window.open(this.server.getFileUrl(this.file.path));
  }

  printPreview(): void {
    try {
      this.iframeEl?.contentWindow?.print();
    } catch (err) {
      this.plugin.logger.error("Print failed:", err);
      new Notice("Print failed");
    }
  }

  closeTab(): void {
    if (this.sourceModified && this.plugin.settings.warnUnsavedClose) {
      new ConfirmModal(
        this.app,
        "Unsaved changes",
        "You have unsaved changes in this preview. Discard them and close the tab?",
        "Discard and close",
        () => this.leaf.detach(),
      ).open();
    } else {
      this.leaf.detach();
    }
  }

  // ── Navigate to a vault-relative path ──

  navigateToVaultPath(input: string): void {
    if (/^https?:\/\//i.test(input)) {
      window.open(input);
      return;
    }
    const url = this.server.getFileUrl(input);
    this.loadingEl?.addClass("is-active");
    if (this.iframeEl) this.iframeEl.src = url;
    this.pushHistory(url);
    this.updateUrlDisplay(url);
  }

  // ── View Mode Toggle ──

  async toggleViewMode(): Promise<void> {
    if (this.viewMode === "preview") {
      await this.switchToSource();
    } else {
      if (this.sourceModified) {
        new ConfirmModal(
          this.app,
          "Unsaved changes",
          "You have unsaved changes. Discard and switch to preview?",
          "Discard",
          () => void this.switchToPreview(),
        ).open();
      } else {
        this.switchToPreview();
      }
    }
  }

  private async switchToSource(): Promise<void> {
    this.viewMode = "source";
    if (this.iframeWrapEl) this.iframeWrapEl.style.display = "none";
    if (this.sourceWrapEl) this.sourceWrapEl.style.display = "flex";

    await this.ensureEditor();

    if (this.cmView && this.file) {
      try {
        const content = await this.app.vault.read(this.file);
        this.cmView.dispatch({
          changes: { from: 0, to: this.cmView.state.doc.length, insert: content },
        });
        this.sourceModified = false;
        this.modifiedBadge?.removeClass("is-visible");
      } catch (err) {
        this.plugin.logger.error("Reload source failed:", err);
      }
    }

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

    this.sourceModified = false;
    this.modifiedBadge?.removeClass("is-visible");
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
    try {
      await this.app.vault.modify(this.file, this.cmView.state.doc.toString());
      this.sourceModified = false;
      this.modifiedBadge?.removeClass("is-visible");
      new Notice("Saved");
    } catch (err) {
      new Notice("Failed to save file");
      this.plugin.logger.error("Save error:", err);
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

  goBack(): void {
    if (this.navIndex <= 0) return;
    this.isNavigating = true;
    this.navIndex--;
    this.navigateTo(this.navHistory[this.navIndex]);
  }

  goForward(): void {
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
    const textEl = this.urlEl.querySelector(".html-preview-url-text") as HTMLElement | null;
    if (!textEl) return;
    const token = this.server.getToken();
    const stripped = url.replace(`/${token}/`, "/").replace(/^http:\/\/127\.0\.0\.1:\d+\//, "");
    textEl.textContent = decodeURIComponent(stripped) || "/";
  }

  // ── Dimensions (zoom + device preset) ──

  private applyDimensions(): void {
    if (!this.iframeEl || !this.iframeWrapEl) return;
    const scale = this.zoom / 100;
    const fixedSize = this.currentDevice.width !== null;

    this.iframeWrapEl.classList.toggle("html-preview-iframe-wrap-fixed", fixedSize);

    if (this.zoom === 100) {
      this.iframeEl.style.transform = "";
      this.iframeEl.style.transformOrigin = "";
    } else {
      this.iframeEl.style.transform = `scale(${scale})`;
      this.iframeEl.style.transformOrigin = "0 0";
    }

    if (fixedSize && this.currentDevice.width !== null && this.currentDevice.height !== null) {
      this.iframeEl.style.width = `${this.currentDevice.width}px`;
      this.iframeEl.style.height = `${this.currentDevice.height}px`;
      this.iframeEl.style.flex = "0 0 auto";
    } else if (this.zoom === 100) {
      this.iframeEl.style.width = "100%";
      this.iframeEl.style.height = "100%";
      this.iframeEl.style.flex = "";
    } else {
      this.iframeEl.style.width = `${100 / scale}%`;
      this.iframeEl.style.height = `${100 / scale}%`;
      this.iframeEl.style.flex = "";
    }

    if (this.zoomLabelEl) this.zoomLabelEl.textContent = `${this.zoom}%`;
  }

  zoomIn(): void {
    this.zoom = Math.min(ZOOM_MAX, this.zoom + ZOOM_STEP);
    this.applyDimensions();
    void this.plugin.saveZoomState(this.zoom);
  }

  zoomOut(): void {
    this.zoom = Math.max(ZOOM_MIN, this.zoom - ZOOM_STEP);
    this.applyDimensions();
    void this.plugin.saveZoomState(this.zoom);
  }

  zoomReset(): void {
    this.zoom = 100;
    this.applyDimensions();
    void this.plugin.saveZoomState(this.zoom);
  }

  applyDevicePreset(preset: DevicePreset): void {
    this.currentDevice = preset;
    this.applyDimensions();
    if (this.deviceBtn) {
      this.deviceBtn.setAttribute("aria-label", `Viewport: ${formatPresetLabel(preset)}`);
      this.deviceBtn.toggleClass("is-active", preset.id !== "full");
    }
  }

  // ── Auto Reload ──

  toggleAutoReload(): void {
    this.autoReload = !this.autoReload;
    this.autoReloadBtn?.toggleClass("is-active", this.autoReload);
    this.autoReloadBtn?.setAttribute("aria-label", `Auto-reload: ${this.autoReload ? "ON" : "OFF"}`);
    if (this.autoReload) {
      this.startVaultWatch();
    } else {
      this.stopVaultWatch();
    }
    new Notice(`Auto-reload ${this.autoReload ? "enabled" : "disabled"}`);
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
    window.setTimeout(() => this.reloadIndicatorEl?.removeClass("is-visible"), 1200);
  }

  // ── Dependency tracking ──

  private async refreshDependencies(file: TFile): Promise<void> {
    try {
      const content = await this.app.vault.read(file);
      this.dependencies = parseDependencies(content, file.path);
      this.plugin.logger.debug(`Tracking ${this.dependencies.size} deps for ${file.path}`);
    } catch (err) {
      this.plugin.logger.error("Parse deps failed:", err);
      this.dependencies = new Set([file.path]);
    }
  }

  // ── Vault watch (uses dependency set) ──

  private startVaultWatch(): void {
    this.stopVaultWatch();
    if (!this.autoReload) return;

    this.vaultModifyRef = this.app.vault.on("modify", (changed: TAbstractFile) => {
      void this.handleVaultChange(changed);
    });
    this.registerEvent(this.vaultModifyRef);
  }

  private async handleVaultChange(changed: TAbstractFile): Promise<void> {
    if (!(changed instanceof TFile)) return;
    const ext = path.extname(changed.path).toLowerCase();
    if (!WATCHED_EXTENSIONS.has(ext)) return;
    if (!this.dependencies.has(changed.path)) return;

    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(async () => {
      const reloadType: "css" | "full" = CSS_EXTENSIONS.has(ext) ? "css" : "full";
      this.server.broadcastReload(reloadType);
      this.flashReloadIndicator();
      // Re-parse dependencies if main HTML changed
      if (this.file && changed.path === this.file.path) {
        await this.refreshDependencies(this.file);
      }
    }, 300);
  }

  private stopVaultWatch(): void {
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    if (this.vaultModifyRef) {
      this.app.vault.offref(this.vaultModifyRef);
      this.vaultModifyRef = null;
    }
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

    new Setting(containerEl).setHeading().setName("Sandbox");

    containerEl.createEl("p", {
      text: "Control which capabilities the iframe sandbox grants to previewed HTML. Disable for untrusted content.",
      cls: "setting-item-description",
    });

    const sandboxOptions: { key: keyof SandboxFlags; name: string; desc: string }[] = [
      { key: "scripts",       name: "Scripts",          desc: "Allow JavaScript execution." },
      { key: "popups",        name: "Popups",           desc: "Allow window.open()." },
      { key: "forms",         name: "Forms",            desc: "Allow form submission." },
      { key: "modals",        name: "Modals",           desc: "Allow alert/confirm/prompt." },
      { key: "downloads",     name: "Downloads",        desc: "Allow file downloads." },
      { key: "topNavigation", name: "Top navigation",   desc: "Allow navigating the top window." },
      { key: "pointerLock",   name: "Pointer lock",     desc: "Allow pointer lock API (games, canvas)." },
    ];

    for (const opt of sandboxOptions) {
      new Setting(containerEl)
        .setName(opt.name)
        .setDesc(opt.desc)
        .addToggle((t) =>
          t.setValue(this.plugin.settings.sandboxFlags[opt.key]).onChange(async (v) => {
            this.plugin.settings.sandboxFlags[opt.key] = v;
            await this.plugin.saveSettings();
          })
        );
    }

    new Setting(containerEl).setHeading().setName("Preview");

    new Setting(containerEl)
      .setName("Default zoom")
      .setDesc("Default zoom level for new preview tabs (30% to 300%).")
      .addSlider((s) =>
        s.setLimits(30, 300, 10)
          .setValue(this.plugin.settings.defaultZoom)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.defaultZoom = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Default viewport")
      .setDesc("Default device viewport for new preview tabs.")
      .addDropdown((d) => {
        for (const preset of DEVICE_PRESETS) {
          d.addOption(preset.id, formatPresetLabel(preset));
        }
        d.setValue(this.plugin.settings.defaultDevice).onChange(async (v) => {
          this.plugin.settings.defaultDevice = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Always open in new tab")
      .setDesc(
        "When you click an HTML file in the file explorer while another HTML preview is active, " +
        "open it in a new tab instead of replacing the current preview. " +
        "URL-bar navigation inside a single preview is unaffected."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.alwaysOpenInNewTab).onChange(async (v) => {
          this.plugin.settings.alwaysOpenInNewTab = v;
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
        "Automatically refresh when the HTML or any tracked dependency (CSS, JS, images linked from the HTML) changes. " +
        "CSS changes are hot-swapped without losing page state."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoReload).onChange(async (v) => {
          this.plugin.settings.autoReload = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl).setHeading().setName("Editor");

    new Setting(containerEl)
      .setName("Warn before closing with unsaved changes")
      .setDesc("Show a confirmation when Cmd+W is pressed and the source editor has unsaved changes.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.warnUnsavedClose).onChange(async (v) => {
          this.plugin.settings.warnUnsavedClose = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl).setHeading().setName("Debug");

    new Setting(containerEl)
      .setName("Verbose logging")
      .setDesc("Print debug messages to the developer console.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.verboseLogging).onChange(async (v) => {
          this.plugin.settings.verboseLogging = v;
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
  logger!: Logger;
  private lastZoom = 100;
  private htmlFilesCache: string[] | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.logger = new Logger(() => this.settings.verboseLogging);

    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      new Notice("HTML Live Preview requires the desktop app.");
      return;
    }

    const saved = await this.loadData();
    if (saved?.lastZoom) this.lastZoom = saved.lastZoom;

    this.server = new StaticServer(adapter.getBasePath(), this.logger);
    try {
      const port = await this.server.start();
      new Notice(`HTML Live Preview ready (port ${port})`);
    } catch (err) {
      this.logger.error("Server start failed:", err);
      new Notice("HTML Live Preview: Failed to start local server.");
      return;
    }

    this.registerView(VIEW_TYPE, (leaf) =>
      new HtmlPreviewView(leaf, this, this.server!, this.settings)
    );
    this.registerExtensions(EXTENSIONS, VIEW_TYPE);

    // Invalidate HTML files cache on vault changes
    this.registerEvent(this.app.vault.on("create", () => this.invalidateHtmlFilesCache()));
    this.registerEvent(this.app.vault.on("delete", () => this.invalidateHtmlFilesCache()));
    this.registerEvent(this.app.vault.on("rename", () => this.invalidateHtmlFilesCache()));

    // Intercept HTML file navigation for the "always open in new tab" setting
    this.installOpenFileInterceptor();

    this.registerCommands();
    this.addSettingTab(new HtmlPreviewSettingTab(this.app, this));
  }

  // ── File-open interception (always open in new tab) ──
  //
  // We monkey-patch `WorkspaceLeaf.prototype.openFile` instead of listening
  // on `workspace.on("file-open")`. The event fires *after* Obsidian has
  // already loaded the file into the leaf, so a detect-and-revert approach
  // causes visible flashing and races. Patching lets us intercept BEFORE
  // the load happens, so an HTML preview tab never gets replaced in-place.

  private installOpenFileInterceptor(): void {
    const plugin = this;
    const proto = WorkspaceLeaf.prototype as {
      openFile: (this: WorkspaceLeaf, file: TFile, openState?: unknown) => Promise<void>;
    };
    const original = proto.openFile;
    let unloaded = false;

    const patched = async function (this: WorkspaceLeaf, file: TFile, openState?: unknown): Promise<void> {
      // If we've been unloaded, skip our logic entirely. This matters when
      // another plugin has patched on top of us: their saved "original" still
      // points at this function, so it can keep getting called after us.
      if (unloaded) {
        return original.call(this, file, openState);
      }
      try {
        if (plugin.settings.alwaysOpenInNewTab && file && (file.extension === "html" || file.extension === "htm")) {
          const currentView = this.view;
          const isReplacingHtml =
            currentView instanceof HtmlPreviewView &&
            currentView.file != null &&
            currentView.file.path !== file.path;

          if (isReplacingHtml) {
            // If the target file is already open in another HTML preview leaf,
            // focus that leaf instead of creating a duplicate tab.
            const existingLeaf = plugin.findLeafShowingFile(file.path, this);
            if (existingLeaf) {
              plugin.app.workspace.setActiveLeaf(existingLeaf, { focus: true });
              return;
            }
            // Otherwise open the new file in a fresh tab, leaving this one alone.
            const newLeaf = plugin.app.workspace.getLeaf("tab");
            return original.call(newLeaf, file, openState);
          }
        }
      } catch (err) {
        // Never let our logic break Obsidian's file opening for the whole app.
        plugin.logger.error("openFile interceptor failed, falling back:", err);
      }
      return original.call(this, file, openState);
    };

    proto.openFile = patched;

    // Restore original on unload, but ONLY if our patch is still on top.
    // If another plugin has wrapped ours, restoring blindly would wipe their
    // patch. In that case we leave the chain alone; the `unloaded` guard above
    // makes our function a no-op so stale closure references stay harmless.
    this.register(() => {
      unloaded = true;
      if (proto.openFile === patched) {
        proto.openFile = original;
      }
    });
  }

  private findLeafShowingFile(filePath: string, excludeLeaf: WorkspaceLeaf): WorkspaceLeaf | null {
    let found: WorkspaceLeaf | null = null;
    this.app.workspace.iterateAllLeaves((l) => {
      if (found || l === excludeLeaf) return;
      const v = l.view;
      if (v instanceof HtmlPreviewView && v.file && v.file.path === filePath) {
        found = l;
      }
    });
    return found;
  }

  async onunload(): Promise<void> {
    this.server?.stop();
  }

  // ── Commands ──

  private registerCommands(): void {
    this.addViewCommand("reload",            "Reload HTML preview",         (v) => v.refreshIframe());
    this.addViewCommand("close-tab",         "Close HTML preview tab",      (v) => v.closeTab());
    this.addViewCommand("toggle-mode",       "Toggle source / preview",     (v) => void v.toggleViewMode());
    this.addViewCommand("toggle-auto-reload","Toggle auto-reload",          (v) => v.toggleAutoReload());
    this.addViewCommand("zoom-in",           "Zoom in",                     (v) => v.zoomIn());
    this.addViewCommand("zoom-out",          "Zoom out",                    (v) => v.zoomOut());
    this.addViewCommand("zoom-reset",        "Reset zoom",                  (v) => v.zoomReset());
    this.addViewCommand("nav-back",          "Navigate back",               (v) => v.goBack());
    this.addViewCommand("nav-forward",       "Navigate forward",            (v) => v.goForward());
    this.addViewCommand("open-external",     "Open in external browser",    (v) => v.openExternal());
    this.addViewCommand("print",             "Print preview",               (v) => v.printPreview());
    this.addViewCommand("copy-vault-path",   "Copy vault path",             (v) => v.copyVaultPath());
    this.addViewCommand("copy-system-path",  "Copy system path",            (v) => v.copySystemPath());
    this.addViewCommand("copy-preview-url",  "Copy preview URL",            (v) => v.copyPreviewUrl());
    this.addViewCommand("copy-file-url",     "Copy file:// URL",            (v) => v.copyFileUrl());

    // Viewport preset commands
    for (const preset of DEVICE_PRESETS) {
      this.addViewCommand(
        `viewport-${preset.id}`,
        `Viewport: ${formatPresetLabel(preset)}`,
        (v) => v.applyDevicePreset(preset),
      );
    }
  }

  private addViewCommand(id: string, name: string, action: (view: HtmlPreviewView) => void): void {
    this.addCommand({
      id,
      name,
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(HtmlPreviewView);
        if (!view) return false;
        if (!checking) action(view);
        return true;
      },
    });
  }

  // ── HTML files cache (shared across views) ──

  getHtmlFiles(): string[] {
    if (this.htmlFilesCache) return this.htmlFilesCache;
    this.htmlFilesCache = this.app.vault.getFiles()
      .filter((f) => f.extension === "html" || f.extension === "htm")
      .map((f) => f.path)
      .sort();
    return this.htmlFilesCache;
  }

  private invalidateHtmlFilesCache(): void {
    this.htmlFilesCache = null;
  }

  // ── Persisted state ──

  async saveZoomState(zoom: number): Promise<void> {
    this.lastZoom = zoom;
    const data = (await this.loadData()) || {};
    data.lastZoom = zoom;
    await this.saveData(data);
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) || {};
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...data,
      sandboxFlags: { ...DEFAULT_SETTINGS.sandboxFlags, ...(data.sandboxFlags ?? {}) },
    };
    // Migrate legacy `allowScripts` setting
    if (typeof data.allowScripts === "boolean" && !data.sandboxFlags) {
      this.settings.sandboxFlags.scripts = data.allowScripts;
    }
  }

  async saveSettings(): Promise<void> {
    const data = (await this.loadData()) || {};
    Object.assign(data, this.settings);
    await this.saveData(data);
  }
}
