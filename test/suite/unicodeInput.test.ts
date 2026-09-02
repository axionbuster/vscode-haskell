import * as assert from 'assert';
import * as vscode from 'vscode';
import { ExpandUnicodeCommandName } from '../../src/commands/constants';

suite('Unicode input', () => {
  let editor: vscode.TextEditor;

  suiteSetup(async () => {
    await vscode.extensions.getExtension('haskell.haskell')!.activate();
  });

  setup(async () => {
    const document = await vscode.workspace.openTextDocument({ language: 'haskell' });
    editor = await vscode.window.showTextDocument(document);
  });

  teardown(async () => {
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  async function type(text: string): Promise<void> {
    await vscode.commands.executeCommand('default:type', { text });
  }

  async function expectText(text: string): Promise<void> {
    const deadline = Date.now() + 3000;
    while (editor.document.getText() !== text && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.strictEqual(editor.document.getText(), text);
  }

  async function expand(delimiter = '', expected?: string): Promise<void> {
    if (delimiter) await type(delimiter);
    else await vscode.commands.executeCommand(ExpandUnicodeCommandName);
    if (expected !== undefined) await expectText(expected);
  }

  test('Space retains its spacing and backslash starts the next shortcut', async () => {
    await type('f \\::');
    await expand(' ', 'f ∷ ');
    await type('\\alpha');
    await expand('\\', 'f ∷ α\\');
    await type('->');
    await expand('\\', 'f ∷ α→\\');
    await type('beta');
    await expand();
    assert.strictEqual(editor.document.getText(), 'f ∷ α→β');
    assert.strictEqual(editor.selection.active.character, 'f ∷ α→β'.length);
  });

  test('symbolic aliases, named aliases, and longer aliases expand exactly', async () => {
    let expected = '';
    for (const [alias, symbol] of [
      ['::', '∷'],
      ['->', '→'],
      ['to', '→'],
      ['=>', '⇒'],
      ['<-', '←'],
      ['forall', '∀'],
      ['-<<', '⤛'],
      ['%1->', '⊸'],
      ['lambda', 'λ'],
      ['Gamma', 'Γ'],
      ['<=', '≤'],
      ['hbar', 'ℏ'],
      ['partial', '∂'],
      ['nabla', '∇'],
      ['int', '∫'],
      ['varepsilon', 'ϵ'],
      ['_1', '₁'],
      ['_j', 'ⱼ'],
      ['_beta', 'ᵦ'],
      ['^2', '²'],
      ['^-1', '⁻¹'],
      ['^T', 'ᵀ'],
    ]) {
      await type(`\\${alias}`);
      expected += `${symbol} `;
      await expand(' ', expected);
    }
  });

  test('ordinary syntax stays ASCII even with UnicodeSyntax enabled', async () => {
    const text = '{-# LANGUAGE UnicodeSyntax #-}\nf :: a -> a\nf = \\x';
    await type(text);
    await expand(' ');
    assert.strictEqual(editor.document.getText(), text + ' ');
  });

  test('partial, unknown, and escaped shortcuts stay literal', async () => {
    let expected = '';
    for (const text of ['\\alph', '\\notAnAlias', '\\\\alpha']) {
      await type(text);
      expected += text + ' ';
      await expand(' ', expected);
    }
    await type('\\unknown');
    await expand('\\');
    await type('alpha');
    await expand(' ', expected + '\\unknownα ');
  });

  test('typing a shortcut does not change it before a commit key', async () => {
    await type('\\alpha');
    assert.strictEqual(editor.document.getText(), '\\alpha');
  });

  test('Undo and Redo preserve the shortcut and cursor', async () => {
    await type('\\alpha');
    await expand(' ', 'α ');
    await vscode.commands.executeCommand('undo');
    await expectText('\\alpha ');
    await vscode.commands.executeCommand('redo');
    assert.strictEqual(editor.document.getText(), 'α ');
    assert.strictEqual(editor.selection.active.character, 2);
  });

  test('multiple cursors on the same line expand in one edit', async () => {
    await type('\\alpha + \\beta');
    editor.selections = [new vscode.Selection(0, 6, 0, 6), new vscode.Selection(0, 14, 0, 14)];
    await expand('\\', 'α\\ + β\\');
    assert.deepStrictEqual(
      editor.selections.map((s) => s.active.character),
      [2, 7],
    );
    await type('to');
    await expand();
    assert.strictEqual(editor.document.getText(), 'α→ + β→');
  });

  test('mixed cursors preserve ordinary Space input', async () => {
    await type('\\alpha\nx');
    editor.selections = [new vscode.Selection(0, 6, 0, 6), new vscode.Selection(1, 1, 1, 1)];
    await expand(' ', 'α \nx ');
  });

  test('subscripts and superscripts attach to identifiers', async () => {
    await type('x\\_1');
    await expand('\\', 'x₁\\');
    await type('^2');
    await expand('', 'x₁²');
    await type(' + matrix\\^T');
    await expand('', 'x₁² + matrixᵀ');
  });

  test('explicit input works in comments and literate Haskell', async () => {
    await vscode.languages.setTextDocumentLanguage(editor.document, 'literate haskell');
    await type('A type variable: \\alpha');
    await expand(' ', 'A type variable: α ');
  });

  test('completion suggestions replace the backslash and preserve case', async () => {
    await type('\\Gam');
    const result = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      editor.document.uri,
      editor.selection.active,
    );
    const item = result.items.find((item) => typeof item.label !== 'string' && item.label.label === '\\Gamma');
    assert.ok(item);
    assert.strictEqual(item.insertText, 'Γ');
    assert.ok(item.range instanceof vscode.Range);
    assert.strictEqual(editor.document.getText(item.range), '\\Gam');
    assert.strictEqual(item.commitCharacters, undefined, 'Space must not accept a partial alias');
  });

  test('disabled input and other languages preserve text', async () => {
    const config = vscode.workspace.getConfiguration('haskell', editor.document);
    const original = config.inspect<boolean>('unicodeInput')?.globalValue;
    try {
      await config.update('unicodeInput', false, vscode.ConfigurationTarget.Global);
      await type('\\alpha');
      await expand(' ');
      assert.strictEqual(editor.document.getText(), '\\alpha ');
      const result = await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        editor.document.uri,
        new vscode.Position(0, 6),
      );
      assert.ok(!result?.items.some((item) => item.insertText === 'α'));
    } finally {
      await config.update('unicodeInput', original, vscode.ConfigurationTarget.Global);
    }
    await vscode.languages.setTextDocumentLanguage(editor.document, 'plaintext');
    await type('\\beta');
    await expand(' ');
    assert.strictEqual(editor.document.getText(), '\\alpha \\beta ');
  });
});
