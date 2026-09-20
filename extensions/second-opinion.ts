/**
 * second-opinion — /so [question]
 *
 * Sends the recent conversation context to a DIFFERENT model than the one
 * currently active and prints its independent take. Useful for architecture
 * decisions: let another vendor's model review the plan and poke holes.
 *
 * Model selection:
 * - Candidates come from scoped models (or the full available catalogue),
 *   excluding the current provider/model.
 * - The first run asks interactively; the choice is remembered for the session.
 */

import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { pickFromList } from "./lib/select-list.ts";

const MAX_CONTEXT_CHARS = 24000;

const DEFAULT_QUESTION =
	"Review the current conversation (plan, code, decisions) from your independent perspective. Point out flaws, risks, overlooked alternatives, and anything the other model got wrong. Be concise and concrete.";

const SYSTEM_PROMPT =
	"You are a senior reviewer giving a second opinion. You are shown a conversation handled by another model. Audit it critically: correctness, security, performance, design, and missed alternatives. Be direct and specific; skip pleasantries.";

interface CandidateModel {
	provider: string;
	id: string;
}

function collectConversationContext(ctx: ExtensionContext): string {
	const entries = ctx.sessionManager.getEntries();
	const parts: string[] = [];
	let total = 0;

	for (let i = entries.length - 1; i >= 0 && total < MAX_CONTEXT_CHARS; i--) {
		const entry = entries[i] as { type?: string; message?: { role?: string; content?: unknown } };
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
		const content = message.content;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.filter((c): c is { type: "text"; text: string } => Boolean(c && typeof c === "object" && (c as any).type === "text"))
							.map((c) => c.text)
							.join("\n")
					: "";
		if (!text.trim()) continue;
		parts.unshift(`[${message.role}]\n${text}`);
		total += text.length;
	}

	let joined = parts.join("\n\n---\n\n");
	if (joined.length > MAX_CONTEXT_CHARS) {
		joined = "…(earlier context truncated)…\n\n" + joined.slice(-MAX_CONTEXT_CHARS);
	}
	return joined;
}

function listCandidates(ctx: ExtensionContext): CandidateModel[] {
	const currentProvider = ctx.model?.provider;
	const currentId = ctx.model?.id;

	const raw: any[] = ctx.scopedModels && ctx.scopedModels.length > 0 ? [...ctx.scopedModels] : [];
	let candidates: CandidateModel[] = raw
		.map((sm) => ({ provider: sm?.model?.provider ?? sm?.provider, id: sm?.model?.id ?? sm?.id }))
		.filter((m) => m.provider && m.id);

	if (candidates.length === 0) {
		try {
			candidates = ctx.modelRegistry.getAvailable().map((m: any) => ({ provider: m.provider, id: m.id }));
		} catch {
			candidates = [];
		}
	}

	// De-duplicate and drop the model that is currently answering.
	const seen = new Set<string>();
	return candidates.filter((m) => {
		if (m.provider === currentProvider && m.id === currentId) return false;
		const key = `${m.provider}/${m.id}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function modelLabel(model: CandidateModel): string {
	return `${model.provider}/${model.id}`;
}

export default function (pi: ExtensionAPI) {
	let remembered: CandidateModel | null = null;

	async function pickModel(ctx: ExtensionContext, candidates: CandidateModel[]): Promise<CandidateModel | null> {
		if (candidates.length === 0) return null;

		if (
			remembered &&
			candidates.some((m) => m.provider === remembered!.provider && m.id === remembered!.id)
		) {
			return remembered;
		}
		if (candidates.length === 1) return candidates[0]!;

		if (!ctx.hasUI) return candidates[0]!;
		const picked = await pickFromList(
			ctx,
			"Second opinion from which model?",
			candidates.slice(0, 50).map((m) => ({
				value: modelLabel(m),
				label: modelLabel(m),
			})),
		);
		if (picked === null) return null;
		return candidates.find((m) => modelLabel(m) === picked) ?? null;
	}

	async function soHandler(ctx: ExtensionContext, args: string): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify("second-opinion requires interactive mode", "error");
			return;
		}
		if (!ctx.model) {
			ctx.ui.notify("No current model selected", "error");
			return;
		}

		const candidates = listCandidates(ctx);
		const model = await pickModel(ctx, candidates);
		if (!model) {
			ctx.ui.notify("No other model available for a second opinion", "warning");
			return;
		}
		remembered = model;

		const target = ctx.modelRegistry.find(model.provider, model.id);
		if (!target) {
			ctx.ui.notify(`Model ${model.provider}/${model.id} not found in registry`, "error");
			return;
		}

		const question = args.trim() || DEFAULT_QUESTION;
		const conversation = collectConversationContext(ctx);

		const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const loader = new BorderedLoader(tui, theme, `Asking ${model.provider}/${model.id}…`);
			loader.onAbort = () => done(null);

			(async () => {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(target);
				if (!auth.ok) throw new Error(auth.error);

				const response = await complete(
					target,
					{
						systemPrompt: SYSTEM_PROMPT,
						messages: [
							{
								role: "user",
								content: [
									{ type: "text", text: `<conversation>\n${conversation}\n</conversation>\n\n<request>\n${question}\n</request>` },
								],
								timestamp: Date.now(),
							},
						],
					},
					{ apiKey: auth.apiKey, headers: auth.headers, signal: loader.signal },
				);

				if (response.stopReason === "aborted") return null;
				return response.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n")
					.trim();
			})()
				.then(done)
				.catch((err) => {
					ctx.ui.notify(`second-opinion failed: ${err instanceof Error ? err.message : String(err)}`, "error");
					done(null);
				});

			return loader;
		});

		if (!result) return;

		pi.sendMessage(
			{
				customType: "second-opinion",
				content: `## 🧭 Second opinion — ${model.provider}/${model.id}\n\n${result}`,
				display: true,
			},
			{ triggerTurn: false },
		);
	}

	pi.registerCommand("so", {
		description: "Ask a different model for a second opinion (usage: /so [question])",
		handler: async (args, ctx) => soHandler(ctx, args),
	});

	pi.registerCommand("second-opinion", {
		description: "Ask a different model for a second opinion (usage: /second-opinion [question])",
		handler: async (args, ctx) => soHandler(ctx, args),
	});
}
