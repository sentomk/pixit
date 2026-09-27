import { CustomEditor } from "@earendil-works/pi-coding-agent";
import {
	Editor, KeybindingsManager, TUI_KEYBINDINGS, getKeybindings, setKeybindings,
	decodeKittyPrintable, isKeyRelease, matchesKey, truncateToWidth,
} from "@earendil-works/pi-tui";
import { parseKeys, type VimConfig, type VimMode } from "./vim-config.ts";

type Snapshot = { text: string; pos: number };
type Binding = { keys: string[]; output: string[] };
type EditorArgs = ConstructorParameters<typeof CustomEditor>;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const segments = (text: string) => [...segmenter.segment(text)];
const previous = (text: string, pos: number) => segments(text.slice(0, pos)).at(-1)?.index ?? 0;
const following = (text: string, pos: number) => pos + (segments(text.slice(pos))[0]?.segment.length ?? 0);
const lineStart = (text: string, pos: number) => pos === 0 ? 0 : text.lastIndexOf("\n", pos - 1) + 1;
const lineEnd = (text: string, pos: number) => { const end = text.indexOf("\n", pos); return end < 0 ? text.length : end; };
const wordClass = (char: string) => /\s/u.test(char) ? 0 : /[\p{L}\p{N}_]/u.test(char) ? 1 : 2;
const rawKeys: Record<string, string> = {
	"<Esc>": "\x1b", "<Enter>": "\r", "<Tab>": "\t", "<BS>": "\x7f",
	"<Left>": "\x1b[D", "<Right>": "\x1b[C", "<Up>": "\x1b[A", "<Down>": "\x1b[B",
	"<Home>": "\x1b[H", "<End>": "\x1b[F", "<Del>": "\x1b[3~",
};
function raw(key: string): string {
	return rawKeys[key] ?? (/^<C-[a-z]>$/.test(key) ? String.fromCharCode(key.charCodeAt(3) - 96) : key);
}
function token(data: string): string | undefined {
	for (const [key, id] of Object.entries({ "<Esc>": "escape", "<Enter>": "enter", "<Tab>": "tab", "<BS>": "backspace", "<Left>": "left", "<Right>": "right", "<Up>": "up", "<Down>": "down", "<Home>": "home", "<End>": "end", "<Del>": "delete" })) {
		if (matchesKey(data, id as Parameters<typeof matchesKey>[1])) return key;
	}
	for (const char of "abcdefghijklmnopqrstuvwxyz") if (matchesKey(data, `ctrl+${char}` as Parameters<typeof matchesKey>[1])) return `<C-${char}>`;
	const modified = /^\x1b\[27;[12];(\d+)~$/.exec(data);
	const printable = modified && Number(modified[1]) >= 32 && Number(modified[1]) <= 0x10ffff ? String.fromCodePoint(Number(modified[1])) : undefined;
	return decodeKittyPrintable(data) ?? printable ?? (/^[^\x00-\x1f\x7f]+$/u.test(data) ? data : undefined);
}

// The public Editor API has getCursor but no setCursor. Route only synchronous
// cursor movements through the base editor with known bindings; restore the user's
// manager immediately. No private editor state, app actions, or history navigation.
const cursorBindings = new KeybindingsManager(TUI_KEYBINDINGS);

export class VimEditor extends CustomEditor {
	mode: VimMode;
	private config: VimConfig;
	private bindings: Record<VimMode, Binding[]>;
	private pending: { key: string; data: string }[] = [];
	private timer?: ReturnType<typeof setTimeout>;
	private count = "";
	private operator = "";
	private operatorCount = 1;
	private prefix = "";
	private desiredColumn?: number;
	private register = { text: "", linewise: false };
	private undoHistory: Snapshot[] = [];
	private redoHistory: Snapshot[] = [];
	private insertStart?: Snapshot;
	private paste?: string;
	private disposed = false;

	constructor(tui: EditorArgs[0], theme: EditorArgs[1], keybindings: EditorArgs[2], config: VimConfig) {
		super(tui, theme, keybindings);
		this.config = config;
		this.mode = config.startMode;
		this.bindings = { insert: [], normal: [] };
		for (const mode of ["insert", "normal"] as const) {
			for (const [keys, output] of Object.entries(config.mappings[mode])) {
				if (output !== null) this.bindings[mode].push({ keys: parseKeys(keys, config.leader), output: parseKeys(output, config.leader) });
			}
		}
	}

	private snapshot(): Snapshot {
		const cursor = this.getCursor();
		return { text: this.getText(), pos: this.getLines().slice(0, cursor.line).reduce((n, line) => n + line.length + 1, 0) + cursor.col };
	}

	private move(pos: number): void {
		const text = this.getText();
		pos = Math.max(0, Math.min(text.length, pos));
		const lines = text.slice(0, pos).split("\n");
		const targetLine = lines.length - 1;
		const col = lines.at(-1)!.length;
		const saved = getKeybindings();
		setKeybindings(cursorBindings);
		try {
			const key = (data: string) => Editor.prototype.handleInput.call(this, data);
			while (this.getCursor().line > targetLine) { key("\x1b[H"); key("\x1b[D"); }
			while (this.getCursor().line < targetLine) { key("\x1b[F"); key("\x1b[C"); }
			key("\x1b[H");
			while (this.getCursor().col < col) {
				const before = this.getCursor().col;
				key("\x1b[C");
				if (this.getCursor().col === before) break;
			}
		} finally { setKeybindings(saved); }
	}

	private apply(snapshot: Snapshot): void {
		if (snapshot.text !== this.getText()) super.setText(snapshot.text);
		this.move(snapshot.pos);
	}
	private remember(before: Snapshot): void {
		if (before.text === this.getText()) return;
		this.undoHistory.push(before);
		if (this.undoHistory.length > 200) this.undoHistory.shift();
		this.redoHistory = [];
	}
	private clamp(): void {
		const { text, pos } = this.snapshot();
		if (pos > lineStart(text, pos) && pos === lineEnd(text, pos)) this.move(previous(text, pos));
	}
	private clearCommand(): void { this.count = ""; this.operator = ""; this.operatorCount = 1; this.prefix = ""; }
	private normal(): void {
		if (this.insertStart) this.remember(this.insertStart);
		this.insertStart = undefined;
		this.mode = "normal";
		const { text, pos } = this.snapshot();
		if (pos > lineStart(text, pos)) this.move(previous(text, pos));
		this.clearCommand();
	}
	private insert(before = this.snapshot()): void { this.insertStart = before; this.mode = "insert"; }

	override setText(text: string): void {
		this.cancelPending();
		super.setText(text);
		this.undoHistory = [];
		this.redoHistory = [];
		this.insertStart = undefined;
		this.clearCommand();
		this.desiredColumn = undefined;
		if (this.mode === "normal") this.clamp();
	}

	private cancelPending(): void { clearTimeout(this.timer); this.timer = undefined; this.pending = []; }
	dispose(): void { this.flushPending(); this.disposed = true; this.cancelPending(); }
	private flushPending(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		while (this.pending.length) this.resolvePending(true);
	}
	private resolvePending(force = false): void {
		const candidates = this.bindings[this.mode].filter(binding => this.pending.every((entry, i) => binding.keys[i] === entry.key));
		const exact = candidates.find(binding => binding.keys.length === this.pending.length);
		if (exact && (force || !candidates.some(binding => binding.keys.length > this.pending.length))) {
			this.pending = [];
			for (const key of exact.output) this.dispatch(key, raw(key)); // Non-recursive mappings.
		} else if (candidates.length && !force) {
			this.timer = setTimeout(() => { if (!this.disposed) { this.flushPending(); this.tui.requestRender(); } }, this.config.timeout);
			this.timer.unref?.();
		} else {
			// Longest complete prefix wins on mismatch; otherwise replay one literal key.
			const prefix = this.bindings[this.mode].filter(binding => binding.keys.length <= this.pending.length && binding.keys.every((key, i) => key === this.pending[i].key)).sort((a, b) => b.keys.length - a.keys.length)[0];
			if (prefix) {
				this.pending.splice(0, prefix.keys.length);
				for (const key of prefix.output) this.dispatch(key, raw(key));
			} else {
				const entry = this.pending.shift()!;
				this.dispatch(entry.key, entry.data);
			}
			if (this.pending.length) this.resolvePending(force);
		}
	}

	override handleInput(data: string): void {
		if (this.disposed || isKeyRelease(data)) return;
		// Paste is literal in both modes, including when terminal chunks split the end marker.
		if (this.paste !== undefined || data.startsWith("\x1b[200~")) {
			this.flushPending();
			this.paste = (this.paste ?? "") + (this.paste === undefined ? data.slice(6) : data);
			const end = this.paste.indexOf("\x1b[201~");
			if (end >= 0) {
				const value = this.paste.slice(0, end);
				const rest = this.paste.slice(end + 6);
				this.paste = undefined;
				const before = this.snapshot();
				if (this.mode === "insert") this.insertStart ??= before;
				this.insertTextAtCursor(value);
				if (this.mode === "normal") { this.remember(before); this.clamp(); }
				this.clearCommand();
				if (rest) this.handleInput(rest);
			}
			return;
		}
		const key = token(data);
		if (key === "<Esc>") { this.flushPending(); this.dispatch(key, data); return; }
		if (this.isShowingAutocomplete()) { this.flushPending(); this.native(data); return; }
		if (!key) { this.flushPending(); this.clearCommand(); this.native(data); return; }
		// Terminals can batch ordinary typing; decode each key without interpreting paste.
		if (!key.startsWith("<") && [...key].length > 1) { for (const char of key) this.handleInput(char); return; }
		clearTimeout(this.timer);
		this.pending.push({ key, data });
		this.resolvePending();
	}

	private native(data: string): void {
		const before = this.snapshot();
		if (this.mode === "insert") this.insertStart ??= before;
		super.handleInput(data);
		// Submission clears the native editor. Never let undo resurrect a sent prompt.
		if (before.text && !this.getText() && getKeybindings().matches(data, "tui.input.submit")) {
			this.undoHistory = []; this.redoHistory = []; this.insertStart = undefined;
			this.mode = this.config.startMode;
		} else if (this.mode === "normal") { this.remember(before); this.clamp(); }
	}

	private motion(key: string, text: string, pos: number, count: number): number | undefined {
		if (key === "ge" || key === "gE") {
			const parts = segments(text);
			const kind = (value: string) => key === "gE" ? Number(!/\s/u.test(value)) : wordClass(value);
			const ends = parts.filter((part, index) => {
				if (part.index >= pos) return false;
				// Like Vim, an empty logical line is a word; a whitespace-only line is not.
				if (part.segment === "\n" && (index === 0 || parts[index - 1].segment === "\n")) return true;
				const current = kind(part.segment);
				return current !== 0 && (!parts[index + 1] || kind(parts[index + 1].segment) !== current);
			});
			return ends[ends.length - count]?.index ?? 0;
		}
		for (let n = 0; n < count; n++) {
			const start = lineStart(text, pos), end = lineEnd(text, pos);
			switch (key) {
				case "h": case "<Left>": pos = Math.max(start, previous(text, pos)); break;
				case "l": case "<Right>": pos = Math.min(end > start ? previous(text, end) : end, following(text, pos)); break;
				case "0": case "<Home>": pos = start; break;
				case "^": pos = start + (text.slice(start, end).search(/\S/) < 0 ? 0 : text.slice(start, end).search(/\S/)); break;
				case "$": case "<End>": pos = end > start ? previous(text, end) : end; break;
				case "j": case "<Down>": {
					if (end === text.length) break;
					const next = end + 1, nextEnd = lineEnd(text, next);
					const column = this.desiredColumn ?? segments(text.slice(start, pos)).length;
					pos = next + (segments(text.slice(next, nextEnd))[column]?.index ?? Math.max(0, previous(text.slice(next, nextEnd), nextEnd - next)));
					break;
				}
				case "k": case "<Up>": {
					if (!start) break;
					const prevStart = lineStart(text, start - 1), content = text.slice(prevStart, start - 1);
					pos = prevStart + (segments(content)[this.desiredColumn ?? segments(text.slice(start, pos)).length]?.index ?? previous(content, content.length));
					break;
				}
				case "w": case "W": {
					const kind = (p: number) => key === "W" ? Number(!/\s/u.test(text[p] ?? " ")) : wordClass(text[p] ?? " ");
					const initial = kind(pos);
					while (pos < text.length && kind(pos) === initial) pos = following(text, pos);
					while (pos < text.length && kind(pos) === 0) pos = following(text, pos);
					break;
				}
				case "b": case "B": {
					const kind = (p: number) => key === "B" ? Number(!/\s/u.test(text[p] ?? " ")) : wordClass(text[p] ?? " ");
					pos = previous(text, pos);
					while (pos > 0 && kind(pos) === 0) pos = previous(text, pos);
					const initial = kind(pos);
					while (pos > 0 && kind(previous(text, pos)) === initial) pos = previous(text, pos);
					break;
				}
				case "e": case "E": {
					const kind = (p: number) => key === "E" ? Number(!/\s/u.test(text[p] ?? " ")) : wordClass(text[p] ?? " ");
					pos = following(text, pos);
					while (pos < text.length && kind(pos) === 0) pos = following(text, pos);
					while (following(text, pos) < text.length && kind(following(text, pos)) === kind(pos)) pos = following(text, pos);
					break;
				}
				default: return undefined;
			}
		}
		return pos;
	}

	private editRange(before: Snapshot, from: number, to: number, op: string, linewise = false): void {
		this.register = { text: before.text.slice(from, to), linewise };
		if (linewise && !this.register.text.endsWith("\n")) this.register.text += "\n";
		if (op === "y") return;
		let replacement = "";
		if (linewise && op === "c" && to < before.text.length) replacement = "\n";
		// Deleting the last line consumes the preceding separator, but the register does not.
		if (linewise && op === "d" && to === before.text.length && from > 0) from--;
		this.apply({ text: before.text.slice(0, from) + replacement + before.text.slice(to), pos: from });
		if (op === "c") this.insert(before);
		else { this.remember(before); this.clamp(); }
	}

	private dispatch(key: string, data: string): void {
		if (key === "<Esc>") {
			if (this.isShowingAutocomplete()) { super.handleInput(data); return; }
			if (this.mode === "insert") this.normal();
			else if (this.count || this.operator || this.prefix) this.clearCommand();
			else super.handleInput(data); // A second Escape retains pi's interrupt action.
			return;
		}
		if (this.mode === "insert") { this.native(data); return; }
		const before = this.snapshot(), { text, pos } = before;
		const argumentPrefix = ["f", "F", "t", "T", "r", "i", "a"].includes(this.prefix);
		if (!argumentPrefix && (/^[1-9]$/.test(key) || (key === "0" && this.count))) { this.count = String(Math.min(10000, Number(this.count + key))); return; }
		const explicitCount = !!this.count;
		const count = Math.min(10000, (Number(this.count) || 1) * this.operatorCount);
		this.count = "";
		if (["d", "c", "y"].includes(key) && !this.operator && !this.prefix) { this.operator = key; this.operatorCount = count; return; }
		if (!this.prefix && (["g", "f", "F", "t", "T"].includes(key) || (key === "r" && !this.operator) || (this.operator && ["i", "a"].includes(key)))) {
			this.prefix = key;
			this.count = explicitCount || this.operatorCount > 1 ? String(count) : "";
			this.operatorCount = 1;
			return;
		}
		let target: number | undefined;
		let linewise = false;
		if (!this.prefix && ["j", "k", "<Up>", "<Down>"].includes(key)) this.desiredColumn ??= segments(text.slice(lineStart(text, pos), pos)).length;
		else this.desiredColumn = undefined;
		if (this.prefix === "r") {
			if (segments(key).length === 1 && !rawKeys[key]) {
				let end = pos;
				for (let i = 0; i < count && end < lineEnd(text, pos); i++) end = following(text, end);
				if (segments(text.slice(pos, end)).length === count) {
					const replacement = key.repeat(count);
					this.apply({ text: text.slice(0, pos) + replacement + text.slice(end), pos: pos + previous(replacement, replacement.length) });
					this.remember(before);
				}
			}
			this.clearCommand(); return;
		}
		if (["i", "a"].includes(this.prefix) && this.operator && ["w", "W"].includes(key)) {
			const kind = (p: number) => key === "W" ? Number(!/\s/u.test(text[p] ?? " ")) : wordClass(text[p] ?? " ");
			let from = pos, to = pos;
			while (from > lineStart(text, pos) && kind(previous(text, from)) === kind(pos)) from = previous(text, from);
			while (to < lineEnd(text, pos) && kind(to) === kind(pos)) to = following(text, to);
			for (let i = 1; i < count; i++) {
				while (to < lineEnd(text, pos) && kind(to) === 0) to = following(text, to);
				const nextKind = kind(to);
				while (to < lineEnd(text, pos) && kind(to) === nextKind) to = following(text, to);
			}
			if (this.prefix === "a") {
				const end = to;
				while (to < lineEnd(text, pos) && kind(to) === 0) to = following(text, to);
				if (end === to) while (from > lineStart(text, pos) && kind(previous(text, from)) === 0) from = previous(text, from);
			}
			this.editRange(before, from, to, this.operator);
			this.clearCommand(); return;
		}
		if (["f", "F", "t", "T"].includes(this.prefix)) {
			const forward = this.prefix === this.prefix.toLowerCase();
			target = pos;
			for (let i = 0; i < count; i++) {
				const found = segments(text.slice(lineStart(text, pos), lineEnd(text, pos))).map(part => ({ ...part, index: part.index + lineStart(text, pos) }));
				const match = forward ? found.find(part => part.index > target! && part.segment === key) : found.reverse().find(part => part.index < target! && part.segment === key);
				if (!match) { this.clearCommand(); return; }
				target = match.index;
			}
			if (this.prefix === "t") target = previous(text, target);
			if (this.prefix === "T") target = following(text, target);
		} else if (!this.prefix && this.operator === key) {
			target = lineStart(text, pos);
			for (let n = 0; n < count; n++) target = Math.min(text.length, lineEnd(text, target) + 1);
			linewise = true;
		} else if ((this.prefix === "g" && key === "g") || (!this.prefix && key === "G")) {
			const lines = text.split("\n"), line = explicitCount ? Math.min(count, lines.length) - 1 : key === "G" ? lines.length - 1 : 0;
			target = lines.slice(0, line).reduce((sum, item) => sum + item.length + 1, 0);
			linewise = !!this.operator;
		} else if (this.prefix === "g" && ["e", "E"].includes(key)) target = this.motion(`g${key}`, text, pos, count);
		else if (!this.prefix) target = this.motion(key, text, pos, count);
		if (target !== undefined) {
			const backwardEnd = this.prefix === "g" && ["e", "E"].includes(key);
			// At the beginning there is no backward motion, so dge/cge must not edit.
			if (backwardEnd && target === pos) { this.clearCommand(); return; }
			if (this.operator) {
				let from = Math.min(pos, target), to = Math.max(pos, target);
				linewise ||= !this.prefix && ["j", "k", "<Up>", "<Down>"].includes(key);
				if (linewise) {
					from = lineStart(text, from);
					to = this.operator === key ? target : Math.min(text.length, lineEnd(text, to) + 1);
				} else if (backwardEnd || ["f", "t"].includes(this.prefix) || (!this.prefix && ["e", "E", "$", "<End>"].includes(key))) to = following(text, to);
				// cw changes through the word end and preserves its trailing whitespace.
				if (!this.prefix && this.operator === "c" && ["w", "W"].includes(key) && /\S/u.test(text[pos] ?? " ")) {
					while (to > from && /\s/u.test(text[previous(text, to)])) to = previous(text, to);
				}
				this.editRange(before, from, to, this.operator, linewise);
				if (backwardEnd && this.operator === "y") this.move(from);
			} else { this.move(target); this.clamp(); }
			this.clearCommand(); return;
		}
		if (this.operator || this.prefix) {
			this.clearCommand();
			if (rawKeys[key] || /^<C-[a-z]>$/.test(key)) this.native(data);
			return;
		}
		switch (key) {
			case "i": this.insert(); return;
			case "a": this.move(Math.min(lineEnd(text, pos), following(text, pos))); this.insert(); return;
			case "I": this.move(this.motion("^", text, pos, 1)!); this.insert(); return;
			case "A": this.move(lineEnd(text, pos)); this.insert(); return;
			case "o": case "O": {
				const at = key === "o" ? lineEnd(text, pos) : lineStart(text, pos);
				this.apply({ text: text.slice(0, at) + "\n" + text.slice(at), pos: at + (key === "o" ? 1 : 0) });
				this.insert(before); return;
			}
			case "x": case "<Del>": case "s": {
				let end = pos;
				for (let i = 0; i < count; i++) end = Math.min(lineEnd(text, pos), following(text, end));
				this.editRange(before, pos, end, key === "s" ? "c" : "d"); return;
			}
			case "D": case "C": this.editRange(before, pos, lineEnd(text, pos), key === "C" ? "c" : "d"); return;
			case "p": case "P": {
				if (!this.register.text) return;
				let at = key === "P" ? pos : Math.min(lineEnd(text, pos), following(text, pos));
				let value = this.register.text.repeat(count), cursor = at;
				if (this.register.linewise) {
					at = key === "P" ? lineStart(text, pos) : Math.min(text.length, lineEnd(text, pos) + 1);
					if (key === "p" && lineEnd(text, pos) === text.length) { value = "\n" + value.slice(0, -1); cursor = at + 1; }
					else cursor = at;
				} else cursor = at + previous(value, value.length);
				this.apply({ text: text.slice(0, at) + value + text.slice(at), pos: cursor });
				this.remember(before); return;
			}
			case "u": case "<C-r>": {
				const source = key === "u" ? this.undoHistory : this.redoHistory, destination = key === "u" ? this.redoHistory : this.undoHistory;
				for (let i = 0; i < count; i++) { const snapshot = source.pop(); if (!snapshot) break; destination.push(this.snapshot()); this.apply(snapshot); }
				this.clamp(); return;
			}
			case "J": {
				let result = text;
				for (let i = 0; i < Math.max(1, count - 1); i++) { const end = lineEnd(result, pos); if (end === result.length) break; result = result.slice(0, end).replace(/[ \t]+$/, "") + " " + result.slice(end + 1).replace(/^[ \t]+/, ""); }
				this.apply({ text: result, pos }); this.remember(before); return;
			}
			default:
				if (rawKeys[key] || /^<C-[a-z]>$/.test(key)) this.native(data);
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		const label = ` ${this.mode.toUpperCase()} ${this.operator}${this.prefix}${this.count}${this.pending.map(entry => entry.key).join("")} `;
		// Top border is stable even while completion suggestions are displayed below.
		if (lines.length) lines[0] = truncateToWidth(this.borderColor(label) + lines[0], Math.max(1, width), "");
		return lines;
	}
}
