/**
 * session-grep — /sg [query]
 *
 * Full-text search across past pi sessions of the current project
 * (~/.pi/agent/sessions/<encoded-cwd>/*.jsonl). Case-insensitive substring
 * match over user and assistant messages. Reads only the tail (256KB) of each
 * session file, newest first, to stay fast on large histories.
 *
 * Selecting a result prints the full message back into the current chat
 * (display-only, does not trigger a turn).
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MAX_RESULTS = 40;
const TAIL_BYTES = 256 * 1024;

function getAgentDir(): string {
	const env = process.env.PI_CODING_AGENT_DIR;
	if (env) return env;
	return path.join(os.homedir(), ".pi", "agent");
}

function getSessionDirForCwd(cwd: string): string {
	const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return path.join(getAgentDir(), "sessions", safePath);
}

async function readTail(filePath: string, maxBytes = TAIL_BYTES): Promise<string> {
	let handle: fs.FileHandle | undefined;
	try {
		const stats = await fs.stat(filePath);
		const start = Math.max(0, stats.size - maxBytes);
		const length = stats.size - start;
		if (length <= 0) return "";
		const buffer = Buffer.alloc(length);
		handle = await fs.open(filePath, "r");
		const { bytesRead } = await handle.read(buffer, 0, length, start);
		let chunk = buffer.subarray(0, bytesRead).toString("utf8");
		if (start > 0) {
			const nl = chunk.indexOf("\n");
			if (nl !== -1) chunk = chunk.slice(nl + 1);
		}
		return chunk;
	} catch {
		return "";
	} finally {
		await handle?.close();
	}
}

interface Hit {
	file: string;
	sessionName: string;
	role: string;
	timestamp: number;
	text: string;
	matchLine: number;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c): c is { type: "text"; text: string } => Boolean(c && typeof c === "object" && (c as any).type === "text"))
			.map((c) => c.text ?? "")
			.join("\n");
	}
	return "";
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("sg", {
		description: "Search past sessions of this project (usage: /sg <query>)",
		handler: async (args, ctx) => {
			let query = args.trim();
			if (!query) {
				if (!ctx.hasUI) return;
				const input = await ctx.ui.input("Search sessions", "case-insensitive text…");
				if (!input || !input.trim()) return;
				query = input.trim();
			}

			const sessionDir = getSessionDirForCwd(ctx.cwd);
			let files: string[] = [];
			try {
				const dirents = await fs.readdir(sessionDir, { withFileTypes: true });
				const withMtime = await Promise.all(
					dirents
						.filter((d) => d.isFile() && d.name.endsWith(".jsonl"))
						.map(async (d) => {
							const full = path.join(sessionDir, d.name);
							try {
								return { full, mtimeMs: (await fs.stat(full)).mtimeMs };
							} catch {
								return undefined;
							}
						}),
				);
				files = withMtime
					.filter((f): f is { full: string; mtimeMs: number } => !!f)
					.sort((a, b) => b.mtimeMs - a.mtimeMs)
					.map((f) => f.full);
			} catch {
				ctx.ui.notify(`No sessions found for ${ctx.cwd}`, "warning");
				return;
			}

			const needle = query.toLowerCase();
			const hits: Hit[] = [];

			for (const file of files) {
				if (hits.length >= MAX_RESULTS) break;
				const tail = await readTail(file);
				if (!tail.toLowerCase().includes(needle)) continue;

				const lines = tail.split("\n");
				for (let i = 0; i < lines.length && hits.length < MAX_RESULTS; i++) {
					let entry: any;
					try {
						entry = JSON.parse(lines[i]!);
					} catch {
						continue;
					}
					if (entry?.type !== "message") continue;
					const message = entry.message;
					if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
					const text = extractText(message.content);
					const lineIdx = text.toLowerCase().indexOf(needle);
					if (lineIdx === -1) continue;

					hits.push({
						file,
						sessionName: path.basename(file, ".jsonl").slice(0, 18),
						role: message.role,
						timestamp: Number(message.timestamp ?? entry.timestamp ?? 0),
						text,
						matchLine: text.slice(0, lineIdx).split("\n").length,
					});
				}
			}

			if (hits.length === 0) {
				ctx.ui.notify(`No matches for "${query}"`, "warning");
				return;
			}

			// Newest first in the picker.
			hits.reverse();

			const items = hits.map((h, i) => ({
				value: String(i),
				label: `[${h.role}] ${h.text.split("\n")[h.matchLine - 1]?.trim().slice(0, 60) ?? ""}`,
				description: `${h.sessionName} · ${new Date(h.timestamp).toLocaleString()}`,
			}));

			const picked = await ctx.ui.select(`${hits.length} match(es) for "${query}"`, items);
			if (!picked) return;

			const hit = hits[Number(picked)]!;
			// Print the full message into the chat without triggering a turn.
			pi.sendMessage(
				{
					customType: "session-grep",
					content: `**${hit.role}** · \`${path.basename(hit.file)}\` · ${new Date(hit.timestamp).toLocaleString()}\n\n---\n\n${hit.text.slice(0, 8000)}`,
					display: true,
				},
				{ triggerTurn: false },
			);
		},
	});
}
