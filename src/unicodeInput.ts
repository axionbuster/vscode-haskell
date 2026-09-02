import {
  commands,
  CompletionItem,
  CompletionItemKind,
  CompletionList,
  Disposable,
  languages,
  Position,
  Range,
  TextDocument,
  window,
  workspace,
} from 'vscode';
import { ExpandUnicodeCommandName } from './commands/constants';
import { unicodeSymbols } from './unicodeSymbols';
import { UnicodeReplacements } from './unicodeReplacements';

const maxAliasLength = Math.max(...[...unicodeSymbols.keys()].map((alias) => alias.length));

function enabled(document: TextDocument): boolean {
  return (
    (document.languageId === 'haskell' || document.languageId === 'literate haskell') &&
    workspace.getConfiguration('haskell', document).get<boolean>('unicodeInput', true)
  );
}

function shortcutAt(document: TextDocument, position: Position): { alias: string; range: Range } | undefined {
  // Limit the scan even on very long lines. Include a second backslash so an
  // escaped leader (two backslashes) stays literal, including in strings and comments.
  const start = Math.max(0, position.character - maxAliasLength - 2);
  const text = document.getText(new Range(position.line, start, position.line, position.character));
  const leader = text.lastIndexOf('\\');
  if (leader < 0 || (leader > 0 && text[leader - 1] === '\\')) return undefined;
  const alias = text.slice(leader + 1);
  if (/\s/.test(alias) || alias.length > maxAliasLength) return undefined;
  return { alias, range: new Range(position.line, start + leader, position.line, position.character) };
}

/** Register input independently of HLS so untitled files and server startup work. */
export function registerUnicodeInput(): Disposable {
  const replacements = new UnicodeReplacements();
  let exactContext = false;
  const updateContext = () => {
    const editor = window.activeTextEditor;
    const shortcuts =
      editor && enabled(editor.document) && editor.selections.every((selection) => selection.isEmpty)
        ? editor.selections.map((selection) => shortcutAt(editor.document, selection.active))
        : [];
    const exact = shortcuts.length > 0 && shortcuts.every((shortcut) => shortcut && unicodeSymbols.has(shortcut.alias));
    if (exact !== exactContext) {
      exactContext = exact;
      void commands.executeCommand('setContext', 'haskell.unicodeInputExact', exact);
    }
  };

  const expand = commands.registerCommand(ExpandUnicodeCommandName, async (suggestionVisible: unknown = false) => {
    const editor = window.activeTextEditor;
    if (!editor) return;
    const matches = editor.selections.map((selection) => {
      if (!enabled(editor.document) || !selection.isEmpty) return undefined;
      const shortcut = shortcutAt(editor.document, selection.active);
      const symbol = shortcut && unicodeSymbols.get(shortcut.alias);
      return shortcut && symbol ? { range: shortcut.range, symbol } : undefined;
    });
    const ranges = matches.map((match, index) => match?.range ?? editor.selections[index]);
    const sortedRanges = [...ranges].sort((a, b) => a.start.compareTo(b.start));
    const overlap = sortedRanges.some((range, index) => index > 0 && sortedRanges[index - 1].end.isAfter(range.start));
    if (!matches.every(Boolean) || overlap) {
      // Tab is scoped to Haskell in the manifest and checked here. Document
      // contexts can arrive after Tab during fast typing or over remote SSH.
      await commands.executeCommand(suggestionVisible === true ? 'acceptSelectedSuggestion' : 'tab');
      return;
    }
    matches.forEach((match) => {
      if (match) replacements.add(editor.document, match.range, match.symbol);
    });
    await replacements.flush(editor);
    updateContext();
  });

  const completions = languages.registerCompletionItemProvider(
    [{ language: 'haskell' }, { language: 'literate haskell' }],
    {
      provideCompletionItems(document, position) {
        if (!enabled(document)) return undefined;
        const shortcut = shortcutAt(document, position);
        if (!shortcut) return undefined;
        const items: CompletionItem[] = [];
        for (const [alias, symbol] of unicodeSymbols) {
          if (!alias.startsWith(shortcut.alias)) continue;
          const item = new CompletionItem({ label: `\\${alias}`, description: symbol }, CompletionItemKind.Text);
          item.insertText = symbol;
          item.range = shortcut.range;
          item.filterText = `\\${alias}`;
          item.detail = `Insert ${symbol}`;
          items.push(item);
        }
        // Recompute as letters arrive: symbolic aliases and names share a table.
        // Delimiters are observed after normal typing, not commitCharacters, so
        // a partial alias never accepts an unrelated highlighted suggestion.
        return new CompletionList(items, true);
      },
    },
    '\\',
  );

  const subscriptions = [
    expand,
    completions,
    window.onDidChangeActiveTextEditor(updateContext),
    window.onDidChangeTextEditorSelection(updateContext),
    workspace.onDidChangeTextDocument((event) => {
      replacements.change(event);
      const editor = window.activeTextEditor;
      if (!editor || event.document !== editor.document) return;
      if (event.reason === undefined && enabled(event.document)) {
        // All offsets in an event refer to its old document. Earlier changes
        // move later cursors, so locate each typed delimiter in the new text.
        const changes = [...event.contentChanges].sort((a, b) => a.rangeOffset - b.rangeOffset);
        let shift = 0;
        for (const change of changes) {
          if (change.rangeLength === 0 && (change.text === ' ' || change.text === '\\')) {
            const position = event.document.positionAt(change.rangeOffset + shift);
            const shortcut = shortcutAt(event.document, position);
            const symbol = shortcut && unicodeSymbols.get(shortcut.alias);
            if (shortcut && symbol) replacements.add(event.document, shortcut.range, symbol);
          }
          shift += change.text.length - change.rangeLength;
        }
        void replacements.flush(editor).catch((error: unknown) => {
          replacements.clear(event.document);
          if (!event.document.isClosed) console.error('Unicode shortcut conversion failed', error);
        });
      }
      updateContext();
    }),
    workspace.onDidCloseTextDocument((document) => replacements.clear(document)),
    workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('haskell.unicodeInput')) {
        replacements.clear();
        updateContext();
      }
    }),
  ];
  updateContext();
  return Disposable.from(
    ...subscriptions,
    new Disposable(() => {
      replacements.clear();
      void commands.executeCommand('setContext', 'haskell.unicodeInputExact', false);
    }),
  );
}
