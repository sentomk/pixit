import { readFileSync } from "node:fs";
import { join } from "node:path";

export type VimMode = "insert" | "normal";
export type VimConfig = {
	enabled: boolean;
	startMode: VimMode;
	timeout: number;
	leader: string;
	mappings: Record<VimMode, Record<string, string | null>>;
};

export const DEFAULT_VIM_CONFIG: VimConfig = {
	enabled: true,
	startMode: "insert",
	timeout: 400,
	leader: " ",
	mappings: { insert: {}, normal: {} },
};

const named: Record<string, string> = {
	esc: "<Esc>", escape: "<Esc>", cr: "<Enter>", enter: "<Enter>",
	bs: "<BS>", backspace: "<BS>", tab: "<Tab>", space: " ", lt: "<",
	left: "<Left>", right: "<Right>", up: "<Up>", down: "<Down>",
	home: "<Home>", end: "<End>", del: "<Del>",
};

/** Vim notation, with literal Unicode characters outside angle brackets. */
export function parseKeys(value: string, leader = " "): string[] {
	const result: string[] = [];
	for (let i = 0; i < value.length;) {
		if (value[i] === "<" && value.indexOf(">", i) >= 0) {
			const end = value.indexOf(">", i);
			const name = value.slice(i + 1, end).toLowerCase();
			if (name === "leader") result.push(leader);
			else if (named[name]) result.push(named[name]);
			else if (/^c-[a-z]$/.test(name)) result.push(`<C-${name.slice(2)}>`);
			else throw new Error(`Unknown key <${value.slice(i + 1, end)}>`);
			i = end + 1;
		} else {
			const char = String.fromCodePoint(value.codePointAt(i)!);
			if (/[\x00-\x1f\x7f]/.test(char)) throw new Error("Use key notation for control characters");
			result.push(char);
			i += char.length;
		}
	}
	return result;
}

function object(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export function mergeVimConfig(base: VimConfig, value: unknown): VimConfig {
	if (!object(value)) throw new Error("Vim config must be an object");
	for (const key of Object.keys(value)) {
		if (!["enabled", "startMode", "timeout", "leader", "mappings"].includes(key)) throw new Error(`Unknown option: ${key}`);
	}
	const next: VimConfig = { ...base, mappings: { insert: { ...base.mappings.insert }, normal: { ...base.mappings.normal } } };
	if (value.enabled !== undefined) {
		if (typeof value.enabled !== "boolean") throw new Error("enabled must be boolean");
		next.enabled = value.enabled;
	}
	if (value.startMode !== undefined) {
		if (value.startMode !== "insert" && value.startMode !== "normal") throw new Error("startMode must be insert or normal");
		next.startMode = value.startMode;
	}
	if (value.timeout !== undefined) {
		if (!Number.isInteger(value.timeout) || Number(value.timeout) < 50 || Number(value.timeout) > 5000) throw new Error("timeout must be 50–5000 milliseconds");
		next.timeout = Number(value.timeout);
	}
	if (value.leader !== undefined) {
		if (typeof value.leader !== "string" || [...value.leader].length !== 1 || /[\x00-\x1f\x7f]/.test(value.leader)) throw new Error("leader must be one printable character");
		next.leader = value.leader;
	}
	if (value.mappings !== undefined) {
		if (!object(value.mappings)) throw new Error("mappings must be an object");
		for (const [mode, bindings] of Object.entries(value.mappings)) {
			if (mode !== "insert" && mode !== "normal") throw new Error(`Unknown mapping mode: ${mode}`);
			if (!object(bindings)) throw new Error(`${mode} mappings must be an object`);
			for (const [lhs, rhs] of Object.entries(bindings)) {
				if (!lhs || parseKeys(lhs, next.leader).length > 32) throw new Error("Mapping keys must contain 1–32 keys");
				if (rhs !== null && typeof rhs !== "string") throw new Error(`Mapping ${lhs} must be a string or null`);
				if (typeof rhs === "string" && parseKeys(rhs, next.leader).length > 256) throw new Error("Mapping expansion exceeds 256 keys");
				next.mappings[mode][lhs] = rhs;
			}
		}
	}
	return next;
}

export function loadVimConfig(agentDir: string, cwd: string): { config: VimConfig; errors: string[]; paths: string[] } {
	let config = mergeVimConfig(DEFAULT_VIM_CONFIG, {});
	const paths = [join(agentDir, "vim.json"), join(cwd, ".pi", "vim.json")];
	const errors: string[] = [];
	for (const path of paths) {
		try {
			config = mergeVimConfig(config, JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(`${path}: ${(error as Error).message}`);
		}
	}
	return { config, errors, paths };
}
