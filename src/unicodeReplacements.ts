import { Range, TextDocument, TextDocumentChangeEvent, TextEditor } from 'vscode';

interface Replacement {
  start: number;
  end: number;
  original: string;
  symbol: string;
}

/** Keep committed shortcuts attached to their text while editor edits are in flight.
 * VS Code rejects edits against an old document version. Following subsequent
 * changes lets us retry without moving the cursor or intercepting normal typing.
 */
export class UnicodeReplacements {
  private readonly pending = new Map<TextDocument, Replacement[]>();
  private readonly running = new Map<TextDocument, Promise<void>>();

  clear(document?: TextDocument): void {
    if (document) this.pending.delete(document);
    else this.pending.clear();
  }

  change(event: TextDocumentChangeEvent): void {
    if (event.reason !== undefined) {
      // Undo restores the literal shortcut. Never expand it again on that event.
      this.clear(event.document);
      return;
    }
    const replacements = this.pending.get(event.document);
    if (!replacements) return;
    this.pending.set(
      event.document,
      replacements.filter((replacement) => {
        let shift = 0;
        for (const change of event.contentChanges) {
          if (change.rangeOffset + change.rangeLength <= replacement.start) {
            shift += change.text.length - change.rangeLength;
          } else if (change.rangeOffset < replacement.end) {
            // A manual edit or a successful conversion has replaced this text.
            return false;
          }
        }
        replacement.start += shift;
        replacement.end += shift;
        return true;
      }),
    );
  }

  add(document: TextDocument, range: Range, symbol: string): void {
    const replacements = this.pending.get(document) ?? [];
    const start = document.offsetAt(range.start);
    const end = document.offsetAt(range.end);
    if (replacements.some((replacement) => start < replacement.end && end > replacement.start)) return;
    // Do not mutate a batch captured by an edit already in flight. A later
    // shortcut must remain pending until its own replacement has been applied.
    this.pending.set(document, [...replacements, { start, end, symbol, original: document.getText(range) }]);
  }

  flush(editor: TextEditor): Promise<void> {
    const existing = this.running.get(editor.document);
    if (existing) return existing;
    const operation = this.apply(editor).finally(() => this.running.delete(editor.document));
    this.running.set(editor.document, operation);
    return operation;
  }

  private async apply(editor: TextEditor): Promise<void> {
    const document = editor.document;
    while (!document.isClosed) {
      const replacements = (this.pending.get(document) ?? []).filter((replacement) => {
        const range = new Range(document.positionAt(replacement.start), document.positionAt(replacement.end));
        return document.getText(range) === replacement.original;
      });
      this.pending.set(document, replacements);
      if (replacements.length === 0) break;
      const version = document.version;
      const applied = await editor.edit((edit) => {
        for (const replacement of replacements) {
          edit.replace(
            new Range(document.positionAt(replacement.start), document.positionAt(replacement.end)),
            replacement.symbol,
          );
        }
      });
      if (applied) {
        const remaining = this.pending.get(document) ?? [];
        this.pending.set(
          document,
          remaining.filter((replacement) => !replacements.includes(replacement)),
        );
      } else if (document.version === version) {
        // No newer text to retry against (for example, an editor was closed).
        break;
      }
    }
    if (this.pending.get(document)?.length === 0) this.pending.delete(document);
  }
}
