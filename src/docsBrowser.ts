import { homedir } from 'os';
import { basename, dirname, join, resolve, sep } from 'path';
import {
  CancellationToken,
  commands,
  CompletionContext,
  CompletionItem,
  CompletionList,
  Disposable,
  env,
  FileType,
  Hover,
  MarkdownString,
  MarkedString,
  Position,
  ProviderResult,
  TextDocument,
  Uri,
  ViewColumn,
  Webview,
  WebviewPanel,
  window,
  workspace,
} from 'vscode';
import { ProvideCompletionItemsSignature, ProvideHoverSignature } from 'vscode-languageclient';

const ShowDocumentationCommandName = 'haskell.showDocumentation';
const OpenOnHackageCommandName = 'haskell.openDocumentationOnHackage';
const OpenExternallyCommandName = 'haskell.openDocumentationExternally';

// ---------------------------------------------------------------------------
// Anchors
//
// HLS points at haddock pages with the *raw* occurrence name as the fragment,
// e.g. `#v:.!=` or `#v:foldl'`. Haddock however escapes every character it does
// not consider legal, so the anchors it actually emitted are `#v:.-33--61-` and
// `#v:foldl-39-`. Unless we escape the fragment the same way, neither the local
// page nor Hackage scrolls to the right place.
// ---------------------------------------------------------------------------

function isAlpha(c: string): boolean {
  return /\p{L}/u.test(c);
}

// Haddock's `isLegal`: ':', '_', '.' and ASCII alphanumerics.
function isLegalAnchorChar(c: string): boolean {
  return c === ':' || c === '_' || c === '.' || /[0-9A-Za-z]/.test(c);
}

/**
 * Port of haddock's `Haddock.Utils.makeAnchorId`. Only the very first character
 * is held to the stricter `isAlpha` rule; haddock applies this to the whole
 * `v:`/`t:` prefixed anchor, so operator characters such as `.` and `:` survive
 * (`.` is `v:.`, `:|` is `v::-124-`).
 */
export function makeAnchorId(name: string): string {
  return Array.from(name)
    .map((c, i) => ((i === 0 ? isAlpha(c) : isLegalAnchorChar(c)) ? c : `-${c.codePointAt(0)}-`))
    .join('');
}

/**
 * Turn the fragment HLS produced into the anchor haddock actually emitted.
 * Fragments that are not name anchors (`line-42`) are left alone, as are
 * fragments that already look escaped -- no Haskell name can contain `-42-`,
 * since operators admit no digits and identifiers no dashes.
 */
export function haddockAnchor(fragment: string): string {
  if (!/^[vt]:./.test(fragment) || /-\d+-/.test(fragment)) {
    return fragment;
  }
  return makeAnchorId(fragment);
}

// ---------------------------------------------------------------------------
// Locating the package a local haddock page belongs to
// ---------------------------------------------------------------------------

/** `aeson-2.2.3.0`, `base-4.21.2.0-fc24` (unit id hash), `text-2.1.2-inplace`. */
const packageIdRegex = /^(.+?)-(\d+(?:\.\d+)*)(?:-[A-Za-z0-9_+]+)?$/;

/** Directories that show up inside a documentation tree but never name a package. */
const nonPackageDirs = new Set(['doc', 'docs', 'html', 'libraries', 'share', 'src']);

/** Directories whose children are compilers rather than packages, e.g. `store/ghc-9.12.4-6f4d`. */
const compilerDirParents = new Set(['store', 'snapshots', 'ghc', 'ghcup']);

export interface PackageId {
  name: string;
  version: string;
}

/**
 * Guess the package a haddock page belongs to by walking up its path. This has
 * to cope with every layout haddock output ends up in:
 *
 *   ghc:         .../share/doc/ghc-9.12.4/html/libraries/base-4.21.2.0-fc24/Data-Functor.html
 *   cabal store: .../store/ghc-9.12.4/aeson-2.2.3.0-<hash>/share/doc/html/Data-Aeson.html
 *   stack:       .../snapshots/<hash>/9.8.4/doc/aeson-2.2.3.0/Data-Aeson.html
 *   nix:         /nix/store/<hash>-aeson-2.2.3.0-doc/share/doc/aeson-2.2.3.0/html/Data-Aeson.html
 */
export function packageIdFromDocPath(fsPath: string): PackageId | undefined {
  const segments = fsPath.split(/[\\/]+/).filter((s) => s.length > 0);
  // The last segment is the html file itself, so start one above it.
  for (let i = segments.length - 2; i >= 0 && i >= segments.length - 10; i--) {
    const segment = segments[i];
    if (nonPackageDirs.has(segment.toLowerCase())) {
      continue;
    }
    if (i > 0 && compilerDirParents.has(segments[i - 1].toLowerCase())) {
      // We reached the compiler directory without finding a package: give up
      // rather than reporting `ghc-9.12.4` as the package.
      return undefined;
    }
    const match = packageIdRegex.exec(segment);
    if (match) {
      return { name: match[1], version: match[2] };
    }
  }
  return undefined;
}

/**
 * The Hackage page corresponding to a local haddock page, or `undefined` if we
 * cannot tell which package the page belongs to.
 */
export function hackageUriFor(localUri: Uri): string | undefined {
  const packageId = packageIdFromDocPath(localUri.fsPath);
  if (!packageId) {
    return undefined;
  }
  // Haddock names both the local and the Hackage page after the module, so the
  // file name carries over verbatim: `Data-Aeson.html` for documentation and
  // `src/Data.Aeson.html` for sources.
  const file = basename(localUri.fsPath);
  const path = isSourcePage(localUri) ? `src/${file}` : file;
  const anchor = haddockAnchor(localUri.fragment);
  const suffix = anchor.length > 0 ? `#${anchor}` : '';
  return `https://hackage.haskell.org/package/${packageId.name}-${packageId.version}/docs/${path}${suffix}`;
}

function isSourcePage(localUri: Uri): boolean {
  return basename(dirname(localUri.fsPath)).toLowerCase() === 'src';
}

function moduleTitle(localUri: Uri): string {
  return basename(localUri.fsPath)
    .replace(/\.html$/i, '')
    .replace(/-/g, '.');
}

async function fileExists(uri: Uri): Promise<boolean> {
  try {
    await workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when the page is missing but its documentation directory is there, i.e.
 * haddock did generate docs for this package and simply has no page for this
 * module -- it is not exposed. Hackage builds the same set of pages, so it
 * would answer with a 404; the link is dead everywhere and following it is
 * worse than saying so.
 *
 * Sources are exempt: Hackage builds them with `--hyperlinked-source` even
 * where the locally installed haddock has no `src` directory at all.
 */
async function isUndocumentedModule(fileUri: Uri): Promise<boolean> {
  if (isSourcePage(fileUri)) {
    return false;
  }
  return !(await fileExists(fileUri)) && (await fileExists(Uri.file(dirname(fileUri.fsPath))));
}

// ---------------------------------------------------------------------------
// Showing documentation
// ---------------------------------------------------------------------------

export interface DocumentationArgs {
  /** Link label, `Documentation` or `Source`. */
  title?: string;
  /** `file:` uri of the local haddock page, fragment included. */
  localPath: string;
  /** Precomputed Hackage uri; recomputed from `localPath` when absent. */
  hackageUri?: string;
}

/**
 * Show the local haddock page if it is installed, otherwise fall back to the
 * matching page online.
 */
async function showDocumentation({
  title,
  localPath,
  hackageUri,
}: DocumentationArgs): Promise<WebviewPanel | undefined> {
  try {
    const localUri = Uri.parse(localPath);
    const fileUri = localUri.with({ fragment: '' });
    const onlineUri = hackageUri ?? hackageUriFor(localUri);

    if (await fileExists(fileUri)) {
      return await showLocalDocumentation(localUri, onlineUri);
    }

    // haddock links to modules a package does not expose, and those pages
    // exist neither here nor on Hackage. Say so instead of opening a 404.
    if (await isUndocumentedModule(fileUri)) {
      await reportUndocumentedModule(localUri, onlineUri);
      return undefined;
    }

    if (onlineUri) {
      await env.openExternal(Uri.parse(onlineUri));
      return undefined;
    }

    await window.showWarningMessage(
      `No documentation found for ${title ?? moduleTitle(localUri)}: ${fileUri.fsPath} is not installed ` +
        'and the package it belongs to could not be determined.',
    );
  } catch (e) {
    if (e instanceof Error) {
      await window.showErrorMessage(e.message);
    }
  }
  return undefined;
}

async function reportUndocumentedModule(localUri: Uri, onlineUri: string | undefined): Promise<void> {
  const packageId = packageIdFromDocPath(localUri.fsPath);
  const packageName = packageId ? `${packageId.name}-${packageId.version}` : 'its package';
  const openPage = 'Open on Hackage anyway';
  const openPackage = 'Open package on Hackage';
  const offered = onlineUri ? [openPage, ...(packageId ? [openPackage] : [])] : [];

  const choice = await window.showWarningMessage(
    `${moduleTitle(localUri)} has no documentation page: ${packageName} does not expose the module, ` +
      'so haddock built one neither here nor on Hackage.',
    ...offered,
  );
  if (choice === openPage && onlineUri) {
    await env.openExternal(Uri.parse(onlineUri));
  } else if (choice === openPackage && packageId) {
    await env.openExternal(Uri.parse(`https://hackage.haskell.org/package/${packageId.name}-${packageId.version}`));
  }
}

// A single reusable panel, so that following links does not pile up editors.
let docsPanel: WebviewPanel | undefined;
let docsPanelRoots: string[] = [];
/** The page the panel currently shows; links are resolved relative to it. */
let docsPanelUri: Uri | undefined;

/** Pages visited in the panel, oldest first, for the Back/Forward buttons. */
interface HistoryEntry {
  localPath: string;
  hackageUri?: string;
}
let docsHistory: HistoryEntry[] = [];
let docsHistoryIndex = -1;
const historyLimit = 100;
/**
 * Set while we dispose the panel ourselves to widen `localResourceRoots`; the
 * history belongs to the user's navigation, not to the panel instance.
 */
let recreatingPanel = false;

function pushHistoryEntry(entry: HistoryEntry): void {
  if (docsHistory[docsHistoryIndex]?.localPath === entry.localPath) {
    return;
  }
  docsHistory = [...docsHistory.slice(0, docsHistoryIndex + 1), entry].slice(-historyLimit);
  docsHistoryIndex = docsHistory.length - 1;
}

async function navigateHistory(delta: number): Promise<void> {
  const index = docsHistoryIndex + delta;
  const entry = docsHistory[index];
  if (!entry) {
    return;
  }
  // Set first: the toolbar the page renders with reflects where we now are.
  const previous = docsHistoryIndex;
  docsHistoryIndex = index;
  try {
    await showLocalDocumentation(Uri.parse(entry.localPath), entry.hackageUri, false);
  } catch (e) {
    // The page went away since it was visited -- drop it and stay put.
    docsHistoryIndex = previous;
    docsHistory.splice(index, 1);
    if (index < docsHistoryIndex) {
      docsHistoryIndex--;
    }
    if (e instanceof Error) {
      await window.showErrorMessage(e.message);
    }
  }
}

/**
 * Roots the webview may load resources (stylesheets, scripts, images) from.
 * The parent directories are included so that links into sibling modules and
 * sibling packages keep working.
 */
function resourceRootsFor(fileUri: Uri): string[] {
  const dir = dirname(fileUri.fsPath);
  const roots = [dir, dirname(dir), dirname(dirname(dir))];
  // Never hand out the filesystem root, and keep each root once.
  return roots.filter((root, i) => dirname(root) !== root && roots.indexOf(root) === i);
}

function isUnder(fsPath: string, root: string): boolean {
  return fsPath === root || fsPath.startsWith(root.endsWith(sep) ? root : root + sep);
}

async function showLocalDocumentation(
  localUri: Uri,
  hackageUri: string | undefined,
  recordHistory = true,
): Promise<WebviewPanel> {
  const fileUri = localUri.with({ fragment: '' });
  const html = new TextDecoder().decode(await workspace.fs.readFile(fileUri));

  // `localResourceRoots` is fixed at creation time, so a page outside the
  // current roots needs a fresh panel.
  if (docsPanel && !docsPanelRoots.some((root) => isUnder(fileUri.fsPath, root))) {
    const stale = docsPanel;
    docsPanel = undefined;
    recreatingPanel = true;
    try {
      stale.dispose();
    } finally {
      recreatingPanel = false;
    }
  }

  if (!docsPanel) {
    docsPanelRoots = resourceRootsFor(fileUri);
    docsPanel = window.createWebviewPanel('haskell.showDocumentationPanel', moduleTitle(fileUri), ViewColumn.Beside, {
      localResourceRoots: docsPanelRoots.map((root) => Uri.file(root)),
      enableFindWidget: true,
      enableCommandUris: [ShowDocumentationCommandName, OpenOnHackageCommandName, OpenExternallyCommandName],
      enableScripts: true,
    });
    docsPanel.onDidDispose(() => {
      docsPanel = undefined;
      docsPanelRoots = [];
      docsPanelUri = undefined;
      if (!recreatingPanel) {
        docsHistory = [];
        docsHistoryIndex = -1;
      }
    });
    docsPanel.webview.onDidReceiveMessage(onWebviewMessage);
  }

  if (recordHistory) {
    pushHistoryEntry({ localPath: localUri.toString(), hackageUri });
  }

  docsPanelUri = fileUri;
  docsPanel.title = moduleTitle(fileUri);
  docsPanel.webview.html = renderDocumentationPage(docsPanel.webview, html, localUri, hackageUri, {
    canGoBack: docsHistoryIndex > 0,
    canGoForward: docsHistoryIndex >= 0 && docsHistoryIndex < docsHistory.length - 1,
  });
  docsPanel.reveal(docsPanel.viewColumn ?? ViewColumn.Beside, true);
  return docsPanel;
}

/** Follow a link the user clicked inside the webview. */
async function onWebviewMessage(message: unknown): Promise<void> {
  const { href, raw, nav } = (message ?? {}) as { href?: unknown; raw?: unknown; nav?: unknown };
  if (nav === 'back' || nav === 'forward') {
    await navigateHistory(nav === 'back' ? -1 : 1);
    return;
  }
  if (typeof raw === 'string') {
    await followPlaceholderLink(raw);
    return;
  }
  if (typeof href !== 'string') {
    return;
  }
  const target = Uri.parse(href);
  if (target.scheme === 'file') {
    // Another haddock page: show it locally, or online if it is not installed.
    await showDocumentation({ localPath: href });
  } else if (['http', 'https', 'mailto'].includes(target.scheme)) {
    await env.openExternal(target);
  }
}

// ---------------------------------------------------------------------------
// `${pkgroot}` links
//
// Cabal writes cross-package links into store haddocks with the `${pkgroot}`
// variable from the dependency's `haddock-html` field left unexpanded:
//
//   ${pkgroot}/../../../share/doc/ghc-9.14.1/html/libraries/base-4.22.0.0-fde1/Control-Monad.html
//
// Resolving that as a relative url yields a path that cannot exist, so the
// page has to be looked for under the roots such a path can hang off.
// ---------------------------------------------------------------------------

async function followPlaceholderLink(raw: string): Promise<void> {
  const current = docsPanelUri;
  if (!current) {
    return;
  }
  const hash = raw.indexOf('#');
  const fragment = hash < 0 ? '' : raw.slice(hash + 1);
  // Drop the placeholder and the `..` steps that follow it: what remains is a
  // path relative to whichever root the placeholder stood for.
  const relative = (hash < 0 ? raw : raw.slice(0, hash)).replace(/^\$\{[^}]*\}[/\\]*/, '').replace(/^(\.\.[/\\])+/, '');
  const resolved = await resolvePlaceholderPath(relative, current);
  // Nothing installed matches: hand the path to showDocumentation anyway, so
  // that the package it names still gets looked up on Hackage.
  const target = resolved ?? Uri.file(`/${relative}`);
  await showDocumentation({ localPath: target.with({ fragment }).toString() });
}

async function resolvePlaceholderPath(relative: string, currentFile: Uri): Promise<Uri | undefined> {
  for (const root of await placeholderRoots(relative, currentFile)) {
    const candidate = Uri.file(resolve(root, relative));
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** Roots a `${pkgroot}` relative path may hang off, best guess first. */
async function placeholderRoots(relative: string, currentFile: Uri): Promise<string[]> {
  const roots: string[] = [];

  // Packages installed alongside this one, e.g. two packages in a cabal store.
  let dir = dirname(currentFile.fsPath);
  for (let i = 0; i < 10 && dirname(dir) !== dir; i++) {
    roots.push(dir);
    dir = dirname(dir);
  }

  // Boot libraries live in the GHC installation the path itself names.
  const ghc = /^share[/\\]doc[/\\]ghc-([\d.]+)[/\\]/.exec(relative);
  if (ghc) {
    const version = ghc[1];
    const ghcups = join(homedir(), '.ghcup', 'ghc');
    roots.push(
      join(ghcups, version),
      `/usr/lib/ghc-${version}`,
      `/usr/local/lib/ghc-${version}`,
      `/opt/ghc/${version}`,
    );
    roots.push('/usr', '/usr/local');
    // ghcup directories are not always named after the version alone.
    roots.push(...(await subdirectories(ghcups)));
  }

  return roots;
}

async function subdirectories(fsPath: string): Promise<string[]> {
  try {
    const entries = await workspace.fs.readDirectory(Uri.file(fsPath));
    return entries.filter(([, type]) => type === FileType.Directory).map(([name]) => join(fsPath, name));
  } catch {
    return [];
  }
}

/** JSON for embedding in a `<script>`; `<` is escaped so it cannot end the tag. */
function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function commandLink(label: string, command: string, args: unknown): string {
  return `<a href="command:${command}?${encodeURIComponent(JSON.stringify(args))}">${label}</a>`;
}

function navButton(label: string, nav: 'back' | 'forward', enabled: boolean): string {
  return (
    `<button type="button" data-nav="${nav}"${enabled ? '' : ' disabled'} title="${
      nav === 'back' ? 'Back (Alt+Left)' : 'Forward (Alt+Right)'
    }" style="font:inherit;background:none;border:none;padding:0 4px;cursor:${enabled ? 'pointer' : 'default'};` +
    `color:${enabled ? 'var(--vscode-textLink-foreground,#06c)' : 'var(--vscode-disabledForeground,#999)'};">` +
    `${label}</button>`
  );
}

export interface NavigationState {
  canGoBack: boolean;
  canGoForward: boolean;
}

export function renderDocumentationPage(
  webview: Webview,
  html: string,
  localUri: Uri,
  hackageUri: string | undefined,
  navigation: NavigationState = { canGoBack: false, canGoForward: false },
): string {
  const fileUri = localUri.with({ fragment: '' });
  const anchor = haddockAnchor(localUri.fragment);

  // Relative links in the page resolve against the webview uri of its directory.
  const base = `<base href="${webview.asWebviewUri(Uri.file(dirname(fileUri.fsPath))).toString()}/">`;

  const links = [
    navButton('&#8592; Back', 'back', navigation.canGoBack) +
      navButton('Forward &#8594;', 'forward', navigation.canGoForward),
  ];
  if (hackageUri) {
    links.push(commandLink('View on Hackage', OpenOnHackageCommandName, { hackageUri, inWebView: false }));
  }
  links.push(
    commandLink('Open in external browser', OpenExternallyCommandName, {
      uri: fileUri.with({ fragment: anchor }).toString(),
    }),
  );
  const toolbar = `
    <div class="vscode-haskell-docs-toolbar"
         style="position:sticky;top:0;z-index:10000;padding:6px 10px;margin:0 0 8px 0;
                font-family:var(--vscode-font-family);font-size:12px;
                background:var(--vscode-editorWidget-background,#eee);
                color:var(--vscode-editorWidget-foreground,#333);
                border-bottom:1px solid var(--vscode-editorWidget-border,#ccc);">
      ${links.join(' &middot; ')}
    </div>`;

  // Haddock anchors are escaped, but fall back to the raw fragment in case a
  // future HLS starts escaping them itself.
  const script = `
    <script>
      (function () {
        let vscode;
        try {
          vscode = acquireVsCodeApi();
        } catch (e) {
          // Not running inside a webview; links stay inert but the page renders.
        }
        const anchors = ${inlineJson([anchor, localUri.fragment].filter((a) => a.length > 0))};
        const fileBase = ${inlineJson(fileUri.toString())};

        function scrollTo(names) {
          for (const name of names) {
            const target = document.getElementById(name) || document.getElementsByName(name)[0];
            if (target) {
              target.scrollIntoView({ block: 'start' });
              return true;
            }
          }
          return false;
        }

        if (anchors.length > 0) {
          window.addEventListener('load', function () { scrollTo(anchors); });
          scrollTo(anchors);
        }

        function navigate(direction) {
          if (vscode) {
            vscode.postMessage({ nav: direction });
          }
        }

        // The toolbar's own buttons, handled before the link interception below.
        window.addEventListener('click', function (event) {
          const button = event.target && event.target.closest ? event.target.closest('button[data-nav]') : null;
          if (!button || button.disabled) {
            return;
          }
          event.preventDefault();
          event.stopImmediatePropagation();
          navigate(button.getAttribute('data-nav'));
        }, true);

        // Capture phase, and stop the event dead once we take a link over: the
        // webview host listens for clicks too and hands anything it sees to the
        // system browser, which would otherwise open alongside our own panel.
        window.addEventListener('click', function (event) {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
            // Leave the modified click to the host: it is how one deliberately
            // opens a page outside vscode.
            return;
          }
          const anchor = event.target && event.target.closest ? event.target.closest('a') : null;
          const href = anchor && anchor.getAttribute('href');
          if (!href || href.startsWith('command:')) {
            return;
          }
          if (href.startsWith('#')) {
            // In-page: never navigate, but let haddock's own expanders run.
            event.preventDefault();
            if (href.length > 1) {
              scrollTo([decodeURIComponent(href.slice(1))]);
            }
            return;
          }
          event.preventDefault();
          event.stopImmediatePropagation();
          // Cabal leaves \${pkgroot} in cross package links; resolving it as a
          // url would destroy the placeholder, so pass it on untouched.
          if (href.indexOf('\${') >= 0) {
            vscode.postMessage({ raw: href });
            return;
          }
          try {
            const target = new URL(href, fileBase);
            // A link into this very page: scroll rather than reload it.
            if (target.href.split('#')[0] === fileBase && target.hash) {
              scrollTo([decodeURIComponent(target.hash.slice(1))]);
              return;
            }
            vscode.postMessage({ href: target.toString() });
          } catch (e) {
            // Not a link we can follow; ignore.
          }
        }, true);

        window.addEventListener('keydown', function (event) {
          const back = event.altKey && event.key === 'ArrowLeft';
          const forward = event.altKey && event.key === 'ArrowRight';
          if (!back && !forward) {
            return;
          }
          event.preventDefault();
          navigate(back ? 'back' : 'forward');
        });

        // Mouse thumb buttons, which would otherwise walk the webview's own
        // history and strip the page we injected.
        window.addEventListener('mousedown', function (event) {
          if (event.button === 3 || event.button === 4) {
            event.preventDefault();
          }
        }, true);
        window.addEventListener('auxclick', function (event) {
          if (event.button !== 3 && event.button !== 4) {
            return;
          }
          event.preventDefault();
          event.stopImmediatePropagation();
          navigate(event.button === 3 ? 'back' : 'forward');
        }, true);
      })();
    </script>`;

  return insertAfter(insertAfter(html, /<head[^>]*>/i, base), /<body[^>]*>/i, toolbar) + script;
}

function insertAfter(html: string, tag: RegExp, snippet: string): string {
  const match = tag.exec(html);
  if (!match) {
    return snippet + html;
  }
  const at = match.index + match[0].length;
  return html.slice(0, at) + snippet + html.slice(at);
}

// registers the browser in VSCode infrastructure
export function registerDocsBrowser(): Disposable {
  return Disposable.from(
    commands.registerCommand(ShowDocumentationCommandName, showDocumentation),
    commands.registerCommand(OpenExternallyCommandName, openDocumentationExternally),
    new Disposable(() => {
      docsPanel?.dispose();
    }),
  );
}

async function openDocumentationOnHackage({
  hackageUri,
  inWebView = false,
}: {
  hackageUri: string;
  inWebView: boolean;
}) {
  try {
    // open on Hackage and close the original webview in VS code
    await env.openExternal(Uri.parse(hackageUri));
    if (inWebView) {
      await commands.executeCommand('workbench.action.closeActiveEditor');
    }
  } catch (e) {
    if (e instanceof Error) {
      await window.showErrorMessage(e.message);
    }
  }
}

/** Hand a local haddock page to the system browser, where its own scripts work. */
async function openDocumentationExternally({ uri }: { uri: string }) {
  try {
    await env.openExternal(Uri.parse(uri));
  } catch (e) {
    if (e instanceof Error) {
      await window.showErrorMessage(e.message);
    }
  }
}

export function registerDocsOpenOnHackage(): Disposable {
  return commands.registerCommand(OpenOnHackageCommandName, openDocumentationOnHackage);
}

export function hoverLinksMiddlewareHook(
  document: TextDocument,
  position: Position,
  token: CancellationToken,
  next: ProvideHoverSignature,
): ProviderResult<Hover> {
  const res = next(document, position, token);
  return Promise.resolve(res).then((r) => {
    if (r !== null && r !== undefined) {
      r.contents = r.contents.map(processLink);
    }
    return r;
  });
}

export function completionLinksMiddlewareHook(
  document: TextDocument,
  position: Position,
  context: CompletionContext,
  token: CancellationToken,
  next: ProvideCompletionItemsSignature,
): ProviderResult<CompletionItem[] | CompletionList> {
  const res = next(document, position, context, token);

  function processCI(ci: CompletionItem): void {
    if (ci.documentation) {
      ci.documentation = processLink(ci.documentation);
    }
  }

  return Promise.resolve(res).then((r) => {
    if (r instanceof Array) {
      r.forEach(processCI);
    } else if (r) {
      r.items.forEach(processCI);
    }
    return r;
  });
}

/** Markdown links to a local haddock page, as emitted by HLS. */
const localDocLinkRegex = /\[([^\]]+)\]\((file:[^)\s]+\.html(?:#[^)\s]*)?)\)/gi;

/**
 * Rewrite the `Documentation` and `Source` links HLS puts in hovers and
 * completions so that they go through our own commands.
 */
export function rewriteDocLinks(markdown: string): string {
  const configuration = workspace.getConfiguration('haskell');
  const alwaysHackageDocs = configuration.get<boolean>('openDocumentationInHackage');
  const alwaysHackageSource = configuration.get<boolean>('openSourceInHackage');

  return markdown.replace(localDocLinkRegex, (all, title: string, localPath: string) => {
    try {
      const localUri = Uri.parse(localPath);
      const hackageUri = hackageUriFor(localUri);
      const alwaysHackage = isSourcePage(localUri) ? alwaysHackageSource : alwaysHackageDocs;
      const args = encodeURIComponent(JSON.stringify({ title, localPath, hackageUri }));
      // Without a Hackage uri there is nothing to fall back to, so always try
      // the local page -- `showDocumentation` reports it if it is missing.
      const command =
        alwaysHackage && hackageUri ? `${OpenOnHackageCommandName}?${args}` : `${ShowDocumentationCommandName}?${args}`;
      return `[${title}](command:${command})`;
    } catch {
      return all;
    }
  });
}

function processLink(ms: MarkdownString | MarkedString): string | MarkdownString {
  if (typeof ms === 'string') {
    return rewriteDocLinks(ms);
  } else if (ms instanceof MarkdownString) {
    const rewritten = new MarkdownString(rewriteDocLinks(ms.value), ms.supportThemeIcons);
    rewritten.supportHtml = ms.supportHtml;
    rewritten.baseUri = ms.baseUri;
    // The rewritten links are command uris, which only render when trusted. Be
    // no more trusting than we have to: enable our own commands, plus whatever
    // the original was already trusted for.
    const ourCommands = [ShowDocumentationCommandName, OpenOnHackageCommandName];
    if (ms.isTrusted === true) {
      rewritten.isTrusted = true;
    } else if (typeof ms.isTrusted === 'object' && ms.isTrusted !== null) {
      rewritten.isTrusted = { enabledCommands: [...ms.isTrusted.enabledCommands, ...ourCommands] };
    } else {
      rewritten.isTrusted = { enabledCommands: ourCommands };
    }
    return rewritten;
  } else {
    return ms.value;
  }
}
