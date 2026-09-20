/**
 * checkpoint — automatic per-turn git snapshots with one-key undo.
 *
 * How it works:
 * - At every `turn_start` (and session start) a snapshot of the ENTIRE working
 *   tree (tracked + untracked, .gitignored excluded) is committed into a
 *   private ref chain (`refs/pixit/checkpoints/head`), WITHOUT touching the
 *   user's index or branch. This uses a temporary GIT_INDEX_FILE.
 * - Each snapshot commit's parent is the previous snapshot, so the ref chain
 *   is a standalone timeline independent of the user's own commits.
 * - `/undo` reverts the working tree to the previous snapshot: files added
 *   since are deleted, modified/deleted files are restored from the target
 *   snapshot blob. Repeated /undo walks further back. Any new agent turn
 *   resets the undo position.
 *
 * Commands:
 * - `/undo`        revert working tree to before the last agent turn
 * - `/checkpoints` list recent snapshots
 *
 * Limitations:
 * - Undo position is in-memory; restarting pi restarts undo history at the
 *   latest snapshot.
 * - Changes made outside agent turns by the user are also captured/rolled
 *   back — snapshots cover the whole tree.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const REF = "refs/pixit-checkpoints/head";

type GitResult = string | Buffer;

function git(args: string[], cwd: string, env?: Record<string, string>, buffer = false): GitResult {
	return execFileSync("git", args, {
		cwd,
		env: env ? { ...process.env, ...env } : process.env,
		encoding: buffer ? "buffer" : "utf8",
		windowsHide: true,
		// Keep git's stderr out of the chat: probe failures (not a repo) are
		// expected and handled by the caller.
		stdio: ["ignore", "pipe", "ignore"],
	});
}

function tempIndexPath(): string {
	return path.join(os.tmpdir(), `pixit-idx-${process.pid}-${Math.random().toString(16).slice(2)}`);
}

function revParse(ref: string, cwd: string): string | null {
	try {
		const out = git(["rev-parse", "--verify", "--quiet", ref], cwd);
		const s = String(out).trim();
		return s.length > 0 ? s : null;
	} catch {
		return null;
	}
}

/**
 * Snapshot the current working tree into a tree object via a temporary index.
 * Returns the tree hash, or null if not possible (not a repo, git missing).
 */
function writeTreeSnapshot(cwd: string): string | null {
	const idx = tempIndexPath();
	try {
		const env = { GIT_INDEX_FILE: idx };
		if (revParse("HEAD", cwd)) {
			git(["read-tree", "HEAD"], cwd, env);
		} else {
			git(["read-tree", "--empty"], cwd, env);
		}
		git(["add", "-A", "--"], cwd, env);
		return String(git(["write-tree"], cwd, env)).trim();
	} catch {
		return null;
	} finally {
		fs.rmSync(idx, { force: true });
	}
}

interface CheckpointState {
	/** "unknown" until probed once per session; probing is cached so turn_start stays cheap. */
	repo: "unknown" | "enabled" | "disabled";
	/** Snapshot commit the working tree currently matches (set after /undo). */
	undoPos: string | null;
}

const state: CheckpointState = { repo: "unknown", undoPos: null };

/** Probe (once per session) whether cwd is inside a git work tree. */
function isGitRepo(ctx: ExtensionContext): boolean {
	if (state.repo === "unknown") {
		try {
			state.repo =
				String(git(["rev-parse", "--is-inside-work-tree"], ctx.cwd)).trim() === "true"
					? "enabled"
					: "disabled";
		} catch {
			state.repo = "disabled";
		}
	}
	return state.repo === "enabled";
}

function takeCheckpoint(cwd: string, ctx?: ExtensionContext): void {
	if (state.repo !== "enabled") return;
	const tree = writeTreeSnapshot(cwd);
	if (!tree) return;

	const head = revParse(REF, cwd);
	const commitArgs = ["commit-tree", tree, "-m", `pixit checkpoint ${new Date().toISOString()}`];
	if (head) commitArgs.push("-p", head);

	try {
		const commit = String(git(commitArgs, cwd)).trim();
		git(["update-ref", REF, commit], cwd);
		state.undoPos = null;
	} catch (err) {
		ctx?.ui.notify(`Checkpoint failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
	}
}

function restoreFromCommit(cwd: string, commit: string, relPath: string): void {
	const dest = path.join(cwd, relPath);
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	const content = git(["cat-file", "blob", `${commit}:${relPath}`], cwd, undefined, true) as Buffer;
	fs.writeFileSync(dest, content);
}

function deleteWorktreeFile(cwd: string, relPath: string): void {
	const p = path.join(cwd, relPath);
	try {
		fs.rmSync(p, { force: true });
	} catch {
		// ignore
	}
}

function fileExistsInCommit(cwd: string, commit: string, relPath: string): boolean {
	try {
		git(["cat-file", "-e", `${commit}:${relPath}`, "--"], cwd);
		return true;
	} catch {
		return false;
	}
}

/**
 * Restore the working tree to `target` commit. Uses a diff between the target
 * tree and a fresh snapshot of the current tree so untracked files created by
 * the agent are correctly removed.
 */
function restoreToCommit(cwd: string, target: string): number {
	const currentTree = writeTreeSnapshot(cwd);
	if (!currentTree) throw new Error("Could not snapshot the working tree");

	let diff: string;
	try {
		diff = String(git(["diff", "--name-status", "--no-renames", `${target}^{tree}`, currentTree], cwd));
	} catch (err) {
		throw new Error(`git diff failed: ${err instanceof Error ? err.message : String(err)}`);
	}

	let changed = 0;
	for (const line of diff.split("\n")) {
		if (!line.trim()) continue;
		const [status, filePath] = line.split("\t");
		if (!status || !filePath) continue;
		switch (status[0]) {
			case "A": // added since target → remove
				deleteWorktreeFile(cwd, filePath);
				break;
			default: // M / D / T → restore target content (D means deleted since target)
				restoreFromCommit(cwd, target, filePath);
				break;
		}
		changed++;
	}
	return changed;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		state.repo = "unknown";
		state.undoPos = null;
		if (!isGitRepo(ctx)) {
			// Announce once per session; turn_start stays silent.
			ctx.ui.notify("checkpoint: not a git repository — disabled for this session", "info");
			return;
		}
		takeCheckpoint(ctx.cwd, ctx);
	});

	pi.on("turn_start", async (_event, ctx) => {
		if (!isGitRepo(ctx)) return;
		takeCheckpoint(ctx.cwd, ctx);
	});

	pi.registerCommand("undo", {
		description: "Revert working tree to before the last agent turn",
		handler: async (_args, ctx) => {
			if (!isGitRepo(ctx)) {
				ctx.ui.notify("/undo: checkpointing is not active (not a git repository)", "warning");
				return;
			}
			const head = revParse(REF, ctx.cwd);
			if (!head) {
				ctx.ui.notify("/undo: no checkpoints yet", "warning");
				return;
			}

			// Determine target: latest snapshot, or walk back if already undone.
			let target = state.undoPos ?? head;
			if (state.undoPos) {
				const parent = revParse(`${target}^`, ctx.cwd);
				if (!parent) {
					ctx.ui.notify("/undo: already at the oldest checkpoint", "info");
					return;
				}
				target = parent;
			}

			try {
				const changed = restoreToCommit(ctx.cwd, target);
				state.undoPos = target;
				ctx.ui.notify(`Undid ${changed} file change(s) — restored to ${target.slice(0, 8)}`, "info");
			} catch (err) {
				ctx.ui.notify(`/undo failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});

	pi.registerCommand("checkpoints", {
		description: "List recent pixit checkpoints",
		handler: async (_args, ctx) => {
			if (!isGitRepo(ctx)) {
				ctx.ui.notify("/checkpoints: checkpointing is not active (not a git repository)", "warning");
				return;
			}
			const head = revParse(REF, ctx.cwd);
			if (!head) {
				ctx.ui.notify("No checkpoints recorded yet", "info");
				return;
			}
			try {
				const log = String(
					git(["log", "--format=%h %ct %s", REF, "-n", "15"], ctx.cwd),
				).trim();
				const lines = log.split("\n").map((line) => {
					const [hash, ts, ...rest] = line.split(" ");
					return `${hash}  ${new Date(Number(ts) * 1000).toLocaleString()}  ${rest.join(" ")}`;
				});
				// ui.select() renders plain strings; object options show up as "[object Object]".
				await ctx.ui.select("Recent checkpoints (newest first)", lines);
			} catch (err) {
				ctx.ui.notify(`Failed to list checkpoints: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}
