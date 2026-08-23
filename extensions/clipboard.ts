/**
 * /copy-code — copy the last fenced code block from the most recent
 * assistant message to the system clipboard.
 *
 * Cross-platform clipboard backends:
 * - Windows: clip.exe
 * - macOS:   pbcopy
 * - Linux:   wl-copy (Wayland), xclip, xsel — first probe that succeeds wins
 */

import { spawn, spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c): c is { type: "text"; text: string } => Boolean(c && typeof c === "object" && (c as any).type === "text"))
			.map((c) => c.text)
			.join("\n");
	}
	return "";
}

function getLastAssistantText(ctx: ExtensionContext): string | null {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type?: string; message?: { role?: string; content?: unknown } };
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (message?.role !== "assistant") continue;
		const text = extractText(message.content).trim();
		return text || null;
	}
	return null;
}

function extractLastCodeBlock(text: string): { lang: string; code: string } | null {
	const fence = /```([^\n`]*)\n([\s\S]*?)```/g;
	let match: RegExpExecArray | null;
	let last: RegExpExecArray | null = null;
	while ((match = fence.exec(text)) !== null) last = match;
	if (!last) return null;
	return { lang: last[1]!.trim(), code: last[2] ?? "" };
}

function linuxCopyCommand(): string[] | null {
	for (const cmd of [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]]) {
		const probe = spawnSync(cmd[0]!, ["--version"], { stdio: "ignore" });
		if (probe.status === 0 || (probe.error === undefined && probe.status !== null)) return cmd;
		// wl-copy has no --version; treat "spawned but exited otherwise" as present too.
		if (cmd[0] === "wl-copy" && probe.error === undefined) return cmd;
	}
	return null;
}

function copyToClipboard(text: string): Promise<void> {
	return new Promise((resolve, reject) => {
		let argv: string[];
		if (process.platform === "win32") {
			argv = ["clip"];
		} else if (process.platform === "darwin") {
			argv = ["pbcopy"];
		} else {
			const cmd = linuxCopyCommand();
			if (!cmd) {
				reject(new Error("No clipboard backend found (tried wl-copy, xclip, xsel)"));
				return;
			}
			argv = cmd;
		}

		const child = spawn(argv[0]!, argv.slice(1), { stdio: ["pipe", "ignore", "pipe"] });
		let stderr = "";
		child.stderr?.on("data", (d) => (stderr += String(d)));
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`Clipboard command exited with ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
		});
		child.stdin!.on("error", reject);
		child.stdin!.end(text, "utf8");
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("copy-code", {
		description: "Copy the last code block to the clipboard",
		handler: async (_args, ctx) => {
			const text = getLastAssistantText(ctx);
			if (!text) {
				ctx.ui.notify("No assistant messages found", "error");
				return;
			}
			const block = extractLastCodeBlock(text);
			if (!block) {
				ctx.ui.notify("No code block found in the last assistant message", "warning");
				return;
			}
			try {
				await copyToClipboard(block.code);
				const lines = block.code.replace(/\n$/, "").split("\n").length;
				ctx.ui.notify(`Copied ${lines} line(s)${block.lang ? ` (${block.lang})` : ""} to clipboard`, "info");
			} catch (err) {
				ctx.ui.notify(`Clipboard copy failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}
