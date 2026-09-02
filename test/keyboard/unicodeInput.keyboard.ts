import * as assert from 'assert';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';

const exec = promisify(execFile);

// Run only through test:unicode:keyboard, which provides a private Xvfb display.
// Actual keystrokes exercise keybinding enablement and context propagation;
// invoking the registered command directly cannot verify either of those.
suite('Unicode input keyboard workflow', () => {
  let editor: vscode.TextEditor;

  suiteSetup(async () => {
    await vscode.extensions.getExtension('haskell.haskell')!.activate();
    const config = vscode.workspace.getConfiguration('editor');
    await config.update('quickSuggestions', false, vscode.ConfigurationTarget.Global);
    await config.update('suggestOnTriggerCharacters', false, vscode.ConfigurationTarget.Global);
  });

  setup(async () => {
    const document = await vscode.workspace.openTextDocument({ language: 'haskell' });
    editor = await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    const { stdout } = await exec('xdotool', ['search', '--onlyvisible', '--name', 'Extension Development Host']);
    await exec('xdotool', ['windowfocus', '--sync', stdout.trim().split('\n')[0]]);
  });

  teardown(async () => {
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  async function type(text: string, key?: string): Promise<void> {
    await exec('xdotool', ['type', '--clearmodifiers', '--delay', '15', text]);
    if (key) await exec('xdotool', ['key', '--clearmodifiers', key]);
  }

  async function expectText(text: string): Promise<void> {
    const deadline = Date.now() + 3000;
    while (editor.document.getText() !== text && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.strictEqual(editor.document.getText(), text);
  }

  test('type a Unicode signature using Space, backslash, and Tab without suggestions', async () => {
    await type('f \\:: \\alpha\\->\\beta', 'Tab');
    await expectText('f ∷ α→β');
  });

  test('unknown shortcuts, escaped leaders, and ordinary lambdas stay literal', async () => {
    const text = '\\alph \\unknown \\\\alpha \\x -> x ';
    await type(text);
    await expectText(text);
  });

  test('Ctrl+Z restores literal input without triggering another conversion', async () => {
    await type('\\alpha ');
    await expectText('α ');
    await exec('xdotool', ['key', '--clearmodifiers', 'ctrl+z']);
    await expectText('\\alpha ');
  });

  test('suggestions do not accept partial aliases on Space or disrupt chaining', async () => {
    const config = vscode.workspace.getConfiguration('editor');
    await config.update('suggestOnTriggerCharacters', true, vscode.ConfigurationTarget.Global);
    try {
      await type('\\alph \\alpha\\->\\beta', 'Tab');
      await expectText('\\alph α→β');
    } finally {
      await config.update('suggestOnTriggerCharacters', false, vscode.ConfigurationTarget.Global);
    }
  });

  test('type physics symbols and scripted identifiers', async () => {
    await type('x\\_1\\^2 \\hbar \\partial \\psi matrix\\^T', 'Tab');
    await expectText('x₁² ℏ ∂ ψ matrixᵀ');
  });
});
