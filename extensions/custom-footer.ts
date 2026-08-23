/**
 * Custom Footer Extension - two-line status footer, enabled by default.
 *
 * Line 1:  ↑in ↓out $cost                                  ctx <percent> · <tokens>
 * Line 2:   <git branch>                       <model> · <thinking level>
 *
 * Performance: token totals and context usage are cached and recomputed only
 * once per turn (marked dirty on turn_end / session_start). render() reads the
 * cache, so it stays O(1) instead of walking the whole session on every repaint.
 *
 * - Enabled on session start (no toggle needed to try it).
 * - /footer toggles between this custom footer and the default one.
 * - Refreshes on turn end, model change, thinking-level change, and git
 *   branch change (via footerData.onBranchChange).
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ContextUsage, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let tuiRef: TUI | undefined;

	// Cached stats. Recomputed only when `dirty` (once per turn), so render()
	// never walks the session during repaints.
	let input = 0,
		output = 0,
		cost = 0;
	let usage: ContextUsage | undefined;
	let dirty = true;

	const fmt = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);

	function recompute(ctx: ExtensionContext) {
		input = 0;
		output = 0;
		cost = 0;
		for (const e of ctx.sessionManager.getBranch()) {
			if (e.type === "message" && e.message.role === "assistant") {
				const m = e.message as AssistantMessage;
				input += m.usage.input;
				output += m.usage.output;
				cost += m.usage.cost.total;
			}
		}
		usage = ctx.getContextUsage();
		dirty = false;
	}

	function apply(ctx: ExtensionContext) {
		if (!enabled) {
			ctx.ui.setFooter(undefined);
			return;
		}

		ctx.ui.setFooter((tui, theme, footerData) => {
			tuiRef = tui;
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					if (dirty) recompute(ctx); // at most once per turn, not per repaint

					// Context window usage (percent / tokens may be null right after compaction)
					let ctxStr = "ctx —";
					if (usage) {
						const pct = usage.percent != null ? `${Math.round(usage.percent)}%` : "?";
						const tk = usage.tokens != null ? fmt(usage.tokens) : "?";
						ctxStr = `ctx ${pct} · ${tk}`;
					}

					const branch = footerData.getGitBranch();
					const model = ctx.model?.id || "no-model";
					const thinking = pi.getThinkingLevel();

					const pad = (l: string, r: string) =>
						" ".repeat(Math.max(1, width - visibleWidth(l) - visibleWidth(r)));

					// Line 1: tokens + cost  |  context usage
					const l1 = theme.fg("dim", `↑${fmt(input)} ↓${fmt(output)} $${cost.toFixed(3)}`);
					const r1 = theme.fg("dim", ctxStr);
					const line1 = truncateToWidth(l1 + pad(l1, r1) + r1, width);

					// Line 2: git branch  |  model · thinking
					const l2 = branch ? theme.fg("accent", ` ${branch}`) : theme.fg("dim", " no-git");
					const r2 = theme.fg("dim", `${model} · ${thinking}`);
					const line2 = truncateToWidth(l2 + pad(l2, r2) + r2, width);

					return [line1, line2];
				},
			};
		});
	}

	// Apply on session start / reload.
	pi.on("session_start", (_event, ctx) => {
		dirty = true;
		apply(ctx);
	});

	// Mark stats dirty once per turn; model/thinking changes only need a repaint.
	pi.on("turn_end", () => {
		dirty = true;
		tuiRef?.requestRender();
	});
	pi.on("model_select", () => tuiRef?.requestRender());
	pi.on("thinking_level_select", () => tuiRef?.requestRender());

	pi.registerCommand("footer", {
		description: "Toggle custom footer",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			apply(ctx);
			ctx.ui.notify(enabled ? "Custom footer enabled" : "Default footer restored", "info");
		},
	});
}
