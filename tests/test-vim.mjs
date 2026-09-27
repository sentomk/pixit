// Run: node --experimental-strip-types --test tests/test-vim.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { getKeybindings, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import vim from "../extensions/vim.ts";
import { VimEditor } from "../extensions/lib/vim-editor.ts";
import { DEFAULT_VIM_CONFIG, mergeVimConfig, loadVimConfig, parseKeys } from "../extensions/lib/vim-config.ts";

const theme = { borderColor: s => s, selectList: { selectedPrefix: s => s, selectedText: s => s, description: s => s, scrollInfo: s => s, noMatch: s => s } };
const tui = { requestRender() {}, terminal: { rows: 30, columns: 80 } };
const ESC = "\x1b";
function create(text = "", settings = {}) {
	const kb = new KeybindingsManager();
	setKeybindings(kb);
	const editor = new VimEditor(tui, theme, kb, mergeVimConfig(DEFAULT_VIM_CONFIG, settings));
	editor.setText(text);
	return editor;
}
function keys(editor, input) { for (const key of input) editor.handleInput(key); }
function normal(text, settings = {}) { const editor = create(text, settings); editor.handleInput(ESC); return editor; }

test("insert defaults, normal cursor, and native submit", () => {
	const e = create(); let sent;
	e.onSubmit = value => { sent = value; };
	keys(e, "hello"); e.handleInput(ESC);
	assert.equal(e.mode, "normal"); assert.deepEqual(e.getCursor(), { line: 0, col: 4 });
	keys(e, "0l"); assert.equal(e.getCursor().col, 1);
	keys(e, "a!"); e.handleInput(ESC);
	assert.equal(e.getText(), "he!llo");
	e.handleInput("\r"); assert.equal(sent, "he!llo"); assert.equal(e.mode, "insert");
	e.handleInput(ESC); keys(e, "u"); assert.equal(e.getText(), "");
});
test("h/l respect logical line boundaries; j/k do not recall prompt history", () => {
	const e = normal("first\nsecond"); e.addToHistory("old prompt");
	keys(e, "gg0hkk"); assert.deepEqual(e.getCursor(), { line: 0, col: 0 });
	keys(e, "$lll"); assert.equal(e.getCursor().col, 4);
	keys(e, "j"); assert.deepEqual(e.getCursor(), { line: 1, col: 4 });
	assert.equal(e.getText(), "first\nsecond");
});
test("motions and operator counts", () => {
	const e = normal("one two three four five six seven");
	keys(e, "0w"); assert.equal(e.getCursor().col, 4);
	keys(e, "e"); assert.equal(e.getCursor().col, 6);
	keys(e, "b"); assert.equal(e.getCursor().col, 4);
	keys(e, "02d3w"); assert.equal(e.getText(), "seven");
	keys(e, "u"); assert.equal(e.getText(), "one two three four five six seven");
});
test("dd on last line, linewise paste, and undo/redo", () => {
	const e = normal("one\ntwo\nthree");
	keys(e, "dd"); assert.equal(e.getText(), "one\ntwo");
	keys(e, "p"); assert.equal(e.getText(), "one\ntwo\nthree");
	keys(e, "u"); assert.equal(e.getText(), "one\ntwo");
	e.handleInput("\x12"); assert.equal(e.getText(), "one\ntwo\nthree");
});
test("ge and gE move backward to word ends with counts and punctuation", () => {
	const e = normal("one two three"); keys(e, "ge"); assert.equal(e.getCursor().col, 6);
	keys(e, "ge"); assert.equal(e.getCursor().col, 2);
	keys(e, "ge"); assert.equal(e.getCursor().col, 0);
	keys(e, "$2ge"); assert.equal(e.getCursor().col, 2);
	keys(e, "$99ge"); assert.equal(e.getCursor().col, 0);
	const small = normal("one foo.bar baz"); keys(small, "0wlllge"); assert.equal(small.getCursor().col, 6);
	const big = normal("one foo.bar baz"); keys(big, "0wlllgE"); assert.equal(big.getCursor().col, 2);
});
test("dge includes both endpoints and supports undo/redo", () => {
	const e = normal("one two three"); keys(e, "0wedge");
	assert.equal(e.getText(), "on three"); assert.equal(e.getCursor().col, 2);
	keys(e, "u"); assert.equal(e.getText(), "one two three");
	e.handleInput("\x12"); assert.equal(e.getText(), "on three");
	const big = normal("one foo.bar baz"); keys(big, "0wllldgE"); assert.equal(big.getText(), "onbar baz");
});
test("dge multiplies operator and motion counts, including before g", () => {
	for (const command of ["2d3ge", "d6ge", "6dge"]) {
		const e = normal("one two three four five six seven"); keys(e, command); assert.equal(e.getText(), "on", command);
	}
	const e = normal("one two"); keys(e, "d99ge"); assert.equal(e.getText(), "");
});
test("cge changes an inclusive range and yge yanks without changing text", () => {
	const e = normal("one two three"); keys(e, "0wecgeX"); e.handleInput(ESC);
	assert.equal(e.getText(), "onX three"); keys(e, "u"); assert.equal(e.getText(), "one two three");
	keys(e, "0weyge"); assert.equal(e.getText(), "one two three"); assert.equal(e.getCursor().col, 2);
	keys(e, "$p"); assert.equal(e.getText(), "one two threee two");
});
test("ge crosses lines but stops at empty lines, and dge joins its range", () => {
	const e = normal("one\n\ntwo"); keys(e, "ge"); assert.deepEqual(e.getCursor(), { line: 1, col: 0 });
	keys(e, "ge"); assert.deepEqual(e.getCursor(), { line: 0, col: 2 });
	const whitespace = normal("one\n   \ntwo"); keys(whitespace, "ge"); assert.deepEqual(whitespace.getCursor(), { line: 0, col: 2 });
	const deletion = normal("one\n\ntwo"); keys(deletion, "0dge"); assert.equal(deletion.getText(), "one\nwo");
	const joined = normal("one\ntwo"); keys(joined, "dge"); assert.equal(joined.getText(), "on");
});
test("ge keeps graphemes intact and is a no-op at the start", () => {
	const e = normal("one e\u0301🙂 next"); keys(e, "ge"); assert.equal(e.getCursor().col, 6);
	keys(e, "$dge"); assert.equal(e.getText(), "one e\u0301");
	for (const command of ["ge", "gE", "dge", "cge", "yge"]) {
		const start = normal("one two"); keys(start, "0" + command);
		assert.equal(start.getText(), "one two"); assert.equal(start.mode, "normal");
	}
});
test("custom mappings can expand into dge", () => {
	const e = normal("one two three", { mappings: { normal: { X: "dge" } } }); keys(e, "X"); assert.equal(e.getText(), "one tw");
});
test("counted dd and cc preserve neighboring lines", () => {
	const e = normal("one\ntwo\nthree\nfour"); keys(e, "gg2dd");
	assert.equal(e.getText(), "three\nfour");
	keys(e, "ccnew"); e.handleInput(ESC); assert.equal(e.getText(), "new\nfour");
	keys(e, "u"); assert.equal(e.getText(), "three\nfour");
});
test("cw, open line, insert session undo, and redo invalidation", () => {
	const e = normal("one two"); keys(e, "0cwnew"); e.handleInput(ESC);
	assert.equal(e.getText(), "new two"); keys(e, "u"); assert.equal(e.getText(), "one two");
	keys(e, "Otop"); e.handleInput(ESC); assert.equal(e.getText(), "top\none two");
	keys(e, "u"); assert.equal(e.getText(), "one two");
	keys(e, "x"); e.handleInput("\x12"); assert.equal(e.getText(), "ne two");
});
test("yank leaves buffer unchanged and p/P paste text", () => {
	const e = normal("one two"); keys(e, "0yw$p"); assert.equal(e.getText(), "one twoone ");
	keys(e, "u0yyP"); assert.equal(e.getText(), "one two\none two");
});
test("find/till and replace accept literal digit or command keys", () => {
	const e = normal("a1bjcdje"); keys(e, "0f1"); assert.equal(e.getCursor().col, 1);
	keys(e, "r9"); assert.equal(e.getText(), "a9bjcdje");
	keys(e, "0dfj"); assert.equal(e.getText(), "cdje");
	keys(e, "u0dtj"); assert.equal(e.getText(), "jcdje");
	keys(e, "$Fj"); assert.equal(e.getCursor().col, 3);
	keys(e, "0fz"); assert.equal(e.getCursor().col, 0);
});
test("word text objects and counted character replacement", () => {
	const e = normal("one two three"); keys(e, "0wldiw"); assert.equal(e.getText(), "one  three");
	keys(e, "u0wdaw"); assert.equal(e.getText(), "one three");
	keys(e, "u0wlciwnew"); e.handleInput(ESC); assert.equal(e.getText(), "one new three");
	keys(e, "u02r好"); assert.equal(e.getText(), "好好e two three");
});
test("vertical movements retain a preferred column across short lines", () => {
	const e = normal("abcde\nx\nabcde"); keys(e, "gg$jj"); assert.deepEqual(e.getCursor(), { line: 2, col: 4 });
	keys(e, "kk"); assert.deepEqual(e.getCursor(), { line: 0, col: 4 });
});
test("normal mode filters unsupported printable commands", () => {
	const e = normal("abc"); keys(e, "<>:v?z"); assert.equal(e.getText(), "abc");
});
test("empty lines and Unicode grapheme clusters remain intact", () => {
	const e = normal("\n你👨‍👩‍👦e\u0301好\n"); keys(e, "ggjlx");
	assert.equal(e.getText(), "\n你e\u0301好\n");
	keys(e, "x"); assert.equal(e.getText(), "\n你好\n");
	keys(e, "u"); assert.equal(e.getText(), "\n你e\u0301好\n");
	for (const value of ["", "\n", "\n\n"]) { const empty = normal(value); keys(empty, "gg0hjk$ddpux"); }
});
test("mapping jj exits insert and mismatch keeps literal input", () => {
	const e = create("", { mappings: { insert: { jj: "<Esc>" } } });
	keys(e, "ajxjj"); assert.equal(e.getText(), "ajx"); assert.equal(e.mode, "normal");
});
test("mapping timeout, exact-prefix ambiguity, and prefix mismatch", async () => {
	const e = create("", { timeout: 50, mappings: { insert: { j: "a", jj: "<Esc>" } } });
	keys(e, "j"); assert.equal(e.getText(), "");
	await new Promise(resolve => setTimeout(resolve, 80)); assert.equal(e.getText(), "a");
	keys(e, "jx"); assert.equal(e.getText(), "aax");
	keys(e, "jj"); assert.equal(e.mode, "normal");
});
test("partial mapping flushes on Enter, Escape, and dispose", () => {
	for (const action of ["enter", "escape", "dispose"]) {
		const e = create("", { mappings: { insert: { jk: "<Esc>" } } }); let submitted;
		e.onSubmit = value => { submitted = value; }; keys(e, "j");
		if (action === "dispose") e.dispose(); else e.handleInput(action === "enter" ? "\r" : ESC);
		assert.equal(action === "enter" ? submitted : e.getText(), "j");
	}
});
test("mappings are non-recursive, support leader, and can suppress a key", () => {
	const e = normal("one two", { leader: ",", mappings: { normal: { H: "0", "<leader>d": "dd", x: "", j: "k", k: "j" } } });
	keys(e, "Hx"); assert.equal(e.getText(), "one two"); assert.equal(e.getCursor().col, 0);
	keys(e, ",d"); assert.equal(e.getText(), "");
	keys(e, "jk"); // Cyclic definitions must terminate.
});
test("split bracketed paste stays literal and ignores mapping keys", () => {
	for (const startMode of ["normal", "insert"]) {
		const e = create("", { startMode, mappings: { insert: { jj: "<Esc>" } } });
		e.handleInput("\x1b[200~ddjj\n你"); e.handleInput("好\x1b[20"); e.handleInput("1~");
		assert.equal(e.getText(), "ddjj\n你好"); assert.equal(e.mode, startMode);
		if (startMode === "insert") e.handleInput(ESC);
		keys(e, "u"); assert.equal(e.getText(), "");
	}
});
test("Kitty printable keys, key releases, and batched Unicode typing", () => {
	const e = normal("abc"); e.handleInput("\x1b[48u"); assert.equal(e.getCursor().col, 0);
	e.handleInput("\x1b[108;1:3u"); assert.equal(e.getCursor().col, 0);
	e.handleInput("\x1b[105u"); e.handleInput("你好"); assert.equal(e.getText(), "你好abc");
});
test("native shortcuts remain available; Escape cancels pending commands before abort", () => {
	const e = create(); let abort = 0, exit = 0, model = 0;
	e.onEscape = () => abort++; e.onCtrlD = () => exit++;
	e.onAction("app.model.cycleForward", () => model++);
	e.handleInput(ESC); assert.equal(abort, 0);
	keys(e, "d"); e.handleInput(ESC); assert.equal(abort, 0);
	e.handleInput(ESC); assert.equal(abort, 1);
	e.handleInput("\x04"); assert.equal(exit, 1);
	e.handleInput("\x10"); assert.equal(model, 1);
	keys(e, "d"); e.handleInput("\x10"); assert.equal(model, 2);
});
test("join consumes one separator and keeps following blank lines", () => {
	const e = normal("a\n\nb"); keys(e, "ggJ"); assert.equal(e.getText(), "a \nb");
});
test("native autocomplete and newline insertion still work", async () => {
	const e = create();
	e.setAutocompleteProvider({
		triggerCharacters: ["/"],
		async getSuggestions() { return { items: [{ value: "/help", label: "/help" }], prefix: "/" }; },
		applyCompletion() { return { lines: ["/help"], cursorLine: 0, cursorCol: 5 }; },
	});
	keys(e, "/");
	await new Promise(resolve => setTimeout(resolve, 150));
	assert.equal(e.isShowingAutocomplete(), true);
	e.handleInput(ESC); assert.equal(e.isShowingAutocomplete(), false); assert.equal(e.mode, "insert");
	e.handleInput(ESC); assert.equal(e.mode, "normal");
	const plain = create("hello"); plain.handleInput("\x1b[13;2u"); assert.equal(plain.getText(), "hello\n");
});
test("movement respects disabled/remapped native keys and restores global manager", () => {
	const e = normal("abc\ndef"); const kb = getKeybindings();
	kb.setUserBindings({ "tui.editor.cursorLeft": [], "tui.editor.cursorRight": ["ctrl+q"], "tui.editor.cursorLineStart": [] });
	keys(e, "gg0l"); assert.deepEqual(e.getCursor(), { line: 0, col: 1 }); assert.equal(getKeybindings(), kb);
});
test("external setText resets undo and pending mapping state", async () => {
	const e = create("", { timeout: 50, mappings: { insert: { jj: "<Esc>" } } });
	keys(e, "j"); e.setText("new draft"); await new Promise(resolve => setTimeout(resolve, 80));
	assert.equal(e.getText(), "new draft"); e.handleInput(ESC); keys(e, "u"); assert.equal(e.getText(), "new draft");
});
test("mode indicator renders within narrow widths", () => {
	const e = normal("你👩‍💻text");
	for (const width of [8, 20, 80]) { const lines = e.render(width); assert.ok(lines[0].includes("NORMAL")); assert.ok(visibleWidth(lines[0]) <= width); }
});
test("configuration validation and key notation", () => {
	assert.deepEqual(parseKeys("<leader>w<Esc><C-r><Space><lt>", ","), [",", "w", "<Esc>", "<C-r>", " ", "<"]);
	for (const config of [{ timeout: 0 }, { startMode: "visual" }, { enabled: "yes" }, { mappings: [] }, { mappings: { visual: {} } }, { mappings: { normal: { "<Bogus>": "x" } } }]) assert.throws(() => mergeVimConfig(DEFAULT_VIM_CONFIG, config));
});
test("global/project config merge, null removal, and malformed file isolation", () => {
	const root = mkdtempSync(join(tmpdir(), "pixit-vim-"));
	try {
		const agent = join(root, "agent"), project = join(root, "project"); mkdirSync(agent); mkdirSync(join(project, ".pi"), { recursive: true });
		writeFileSync(join(agent, "vim.json"), JSON.stringify({ mappings: { insert: { jj: "<Esc>" } }, timeout: 500 }));
		writeFileSync(join(project, ".pi", "vim.json"), JSON.stringify({ mappings: { insert: { jj: null, jk: "<Esc>" } } }));
		let loaded = loadVimConfig(agent, project); assert.equal(loaded.config.timeout, 500); assert.equal(loaded.config.mappings.insert.jj, null); assert.equal(loaded.errors.length, 0);
		writeFileSync(join(project, ".pi", "vim.json"), "{broken"); loaded = loadVimConfig(agent, project);
		assert.equal(loaded.errors.length, 1); assert.equal(loaded.config.mappings.insert.jj, "<Esc>");
	} finally { rmSync(root, { recursive: true, force: true }); }
});
test("extension lifecycle and toggle preserve the draft and previous editor", async () => {
	const events = {}, commands = {}; let factory, active, text = "draft";
	const root = mkdtempSync(join(tmpdir(), "pixit-vim-lifecycle-"));
	try {
		const prior = () => null; factory = prior;
		const ctx = { cwd: root, hasUI: true, ui: { notify() {}, getEditorComponent: () => factory, setEditorComponent(next) {
			text = active?.getText() ?? text; factory = next;
			active = next && next !== prior ? next(tui, theme, new KeybindingsManager()) : undefined;
			active?.setText(text);
		} } };
		vim({ on: (event, handler) => events[event] = handler, registerCommand: (name, command) => commands[name] = command });
		await commands.vim.handler("on", ctx); assert.ok(active instanceof VimEditor); assert.equal(active.getText(), "draft");
		await commands.vim.handler("off", ctx); assert.equal(factory, prior); assert.equal(text, "draft");
		await events.session_start({}, { ...ctx, hasUI: false }); assert.equal(factory, prior);
		await events.session_shutdown();
	} finally { rmSync(root, { recursive: true, force: true }); }
});
