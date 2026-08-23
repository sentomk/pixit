/**
 * Questionnaire Tool - Unified tool for asking single or multiple questions
 *
 * Single question: simple options list
 * Multiple questions: tab bar navigation between questions
 *
 * Per-question `multiple: true` enables multi-select (checkbox) mode:
 * - Space toggles preset options (☑ / ☐)
 * - Enter confirms the current question and advances
 * - "Type something" becomes an accumulator: each submitted custom entry is
 *   added to the selection without leaving the question
 *
 * Questions with an empty `options` array are treated as free-text questions:
 * the editor opens automatically, Tab/Shift+Tab navigate between questions.
 *
 * Also provides `/answer` (shortcut ctrl+.), integrated from mitsupi's
 * answer.ts: extracts unanswered questions from the last assistant message
 * via LLM, presents them as free-text questions in this TUI, and sends the
 * compiled answers back as a user message to trigger a new turn.
 */

import { complete, type Api, type Model, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

// Types
interface QuestionOption {
	value: string;
	label: string;
	description?: string;
}

type RenderOption = QuestionOption & { isOther?: boolean };

interface Question {
	id: string;
	label: string;
	prompt: string;
	options: QuestionOption[];
	allowOther: boolean;
	multiple: boolean;
}

interface Answer {
	id: string;
	// single-select (unchanged shape for backward compatibility)
	value: string;
	label: string;
	wasCustom: boolean;
	index?: number;
	// multi-select
	multiple?: boolean;
	values?: string[];
	labels?: string[];
	customValues?: string[];
}

interface QuestionnaireResult {
	questions: Question[];
	answers: Answer[];
	cancelled: boolean;
}

// In-progress draft for multi-select questions
interface MultiDraft {
	selected: Set<number>; // indices into q.options (preset options only)
	custom: string[]; // accumulated "Type something" entries
}

// Extracted question shape (from /answer LLM extraction)
interface ExtractedQuestion {
	question: string;
	context?: string;
}

interface ExtractionResult {
	questions: ExtractedQuestion[];
}

const HAIKU_MODEL_ID = "claude-haiku-4-5";

const EXTRACTION_SYSTEM_PROMPT = `You are a question extractor. Given text from a conversation, extract any questions that need answering.

Output a JSON object with this structure:
{
  "questions": [
    {
      "question": "The question text",
      "context": "Optional context that helps answer the question"
    }
  ]
}

Rules:
- Extract all questions that require user input
- Keep questions in the order they appeared
- Be concise with question text
- Include context only when it provides essential information for answering
- If no questions are found, return {"questions": []}

Example output:
{
  "questions": [
    {
      "question": "What is your preferred database?",
      "context": "We can only configure MySQL and PostgreSQL because of what is implemented."
    },
    {
      "question": "Should we use TypeScript or JavaScript?"
    }
  ]
}`;

// Schema
const QuestionOptionSchema = Type.Object({
	value: Type.String({ description: "The value returned when selected" }),
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this question" }),
	label: Type.Optional(
		Type.String({
			description: "Short contextual label for tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2)",
		}),
	),
	prompt: Type.String({ description: "The full question text to display" }),
	options: Type.Array(QuestionOptionSchema, { description: "Available options to choose from. Use an empty array for a free-text question." }),
	allowOther: Type.Optional(Type.Boolean({ description: "Allow 'Type something' option (default: true)" })),
	multiple: Type.Optional(
		Type.Boolean({
			description:
				"Allow selecting multiple options (default: false). Enables checkbox mode: Space toggles options, Enter confirms the question, and 'Type something' accumulates custom entries.",
		}),
	),
});

const QuestionnaireParams = Type.Object({
	questions: Type.Array(QuestionSchema, { description: "Questions to ask the user" }),
});

function errorResult(
	message: string,
	questions: Question[] = [],
): { content: { type: "text"; text: string }[]; details: QuestionnaireResult } {
	return {
		content: [{ type: "text", text: message }],
		details: { questions, answers: [], cancelled: true },
	};
}

function normalizeQuestions(raw: Array<Partial<Question>>): Question[] {
	return raw.map((q, i) => {
		const options = q.options ?? [];
		const freeText = options.length === 0;
		return {
			id: q.id || `q${i + 1}`,
			label: q.label || `Q${i + 1}`,
			prompt: q.prompt || "",
			options,
			allowOther: freeText ? true : q.allowOther !== false,
			multiple: !freeText && q.multiple === true,
		};
	});
}

function isFreeText(q?: Question): boolean {
	return !!q && q.options.length === 0;
}

function formatPlainAnswers(result: QuestionnaireResult): string {
	return result.answers.map((a) => {
		if (a.multiple) {
			const parts = [...(a.labels ?? [])];
			for (const c of a.customValues ?? []) parts.push(c);
			return parts.join("; ");
		}
		return a.label;
	}).map((text, i) => `${i + 1}. ${text}`).join("\n");
}

/**
 * Prefer a cheap/fast model (Haiku) for extraction when auth is available,
 * otherwise fall back to the currently selected model.
 */
async function selectExtractionModel(
	currentModel: Model<Api>,
	modelRegistry: ModelRegistry,
): Promise<Model<Api>> {
	const haikuModel = modelRegistry.find("anthropic", HAIKU_MODEL_ID);
	if (!haikuModel) return currentModel;
	const auth = await modelRegistry.getApiKeyAndHeaders(haikuModel);
	if (!auth.ok) return currentModel;
	return haikuModel;
}

function parseExtractionResult(text: string): ExtractionResult | null {
	try {
		let jsonStr = text;
		const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
		if (jsonMatch) {
			jsonStr = jsonMatch[1].trim();
		}
		const parsed = JSON.parse(jsonStr);
		if (parsed && Array.isArray(parsed.questions)) {
			return parsed as ExtractionResult;
		}
		return null;
	} catch {
		return null;
	}
}

function getLastAssistantText(entries: unknown[]): string | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type?: string; message?: { role?: string; content?: unknown } };
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (message?.role !== "assistant") continue;
		const content = message.content;
		if (typeof content === "string") return content.trim() || null;
		if (Array.isArray(content)) {
			const text = content
				.filter((c): c is { type: "text"; text: string } => Boolean(c && typeof c === "object" && (c as any).type === "text"))
				.map((c) => c.text)
				.join("\n")
				.trim();
			return text || null;
		}
		return null;
	}
	return null;
}

/**
 * Shared questionnaire TUI. Returns answers (or cancelled flag).
 */
async function runQuestionnaireUI(ctx: ExtensionContext, questions: Question[]): Promise<QuestionnaireResult> {
	const isMulti = questions.length > 1;
	const totalTabs = questions.length + 1; // questions + Submit

	return ctx.ui.custom<QuestionnaireResult>((tui, theme, _kb, done) => {
		// State
		let currentTab = 0;
		let optionIndex = 0;
		let inputMode = false;
		let inputQuestionId: string | null = null;
		let cachedLines: string[] | undefined;
		const answers = new Map<string, Answer>();
		const multiDrafts = new Map<string, MultiDraft>();

		// Editor for "Type something" option / free-text questions
		const editorTheme: EditorTheme = {
			borderColor: (s) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
		};
		const editor = new Editor(tui, editorTheme);

		// Helpers
		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		function currentQuestion(): Question | undefined {
			return questions[currentTab];
		}

		function isMultiSelect(q?: Question): boolean {
			return !!q && q.multiple;
		}

		function currentOptions(): RenderOption[] {
			const q = currentQuestion();
			if (!q || isFreeText(q)) return [];
			const opts: RenderOption[] = [...q.options];
			if (q.allowOther) {
				opts.push({ value: "__other__", label: "Type something.", isOther: true });
			}
			return opts;
		}

		function draftFor(qid: string): MultiDraft {
			let d = multiDrafts.get(qid);
			if (!d) {
				d = { selected: new Set<number>(), custom: [] };
				multiDrafts.set(qid, d);
			}
			return d;
		}

		function questionHasAnswer(q: Question): boolean {
			if (q.multiple) {
				const d = multiDrafts.get(q.id);
				return !!d && (d.selected.size > 0 || d.custom.length > 0);
			}
			return answers.has(q.id);
		}

		function allAnswered(): boolean {
			return questions.every((q) => questionHasAnswer(q));
		}

		// Free-text questions open the editor automatically (prefilled with a previous answer).
		function maybeAutoInput() {
			const q = currentQuestion();
			if (!q || !isFreeText(q) || currentTab >= questions.length) return;
			if (!inputMode) {
				const prev = answers.get(q.id);
				inputMode = true;
				inputQuestionId = q.id;
				editor.setText(prev ? prev.value : "");
			}
		}

		// Commit a multi-select draft into a finalized answer.
		function commitMulti(q: Question) {
			const d = draftFor(q.id);
			const values: string[] = [];
			const labels: string[] = [];
			for (const idx of d.selected) {
				const opt = q.options[idx];
				if (opt) {
					values.push(opt.value);
					labels.push(opt.label);
				}
			}
			answers.set(q.id, {
				id: q.id,
				multiple: true,
				value: values.join(", ") || "(none)",
				label: labels.join(", ") || "(none)",
				wasCustom: d.custom.length > 0,
				values,
				labels,
				customValues: [...d.custom],
			});
		}

		function submit(cancelled: boolean) {
			if (!cancelled) {
				// Commit any multi-select drafts that have content but were never
				// explicitly confirmed with Enter (e.g. user toggled then Tabbed away).
				for (const q of questions) {
					if (q.multiple) {
						const d = multiDrafts.get(q.id);
						if (d && (d.selected.size > 0 || d.custom.length > 0)) {
							commitMulti(q);
						}
					}
				}
			}
			done({ questions, answers: Array.from(answers.values()), cancelled });
		}

		function advanceAfterAnswer() {
			if (!isMulti) {
				submit(false);
				return;
			}
			if (currentTab < questions.length - 1) {
				currentTab++;
			} else {
				currentTab = questions.length; // Submit tab
			}
			optionIndex = 0;
			maybeAutoInput();
			refresh();
		}

		function saveAnswerSingle(
			questionId: string,
			value: string,
			label: string,
			wasCustom: boolean,
			index?: number,
		) {
			answers.set(questionId, { id: questionId, value, label, wasCustom, index });
		}

		function leaveInputMode() {
			inputMode = false;
			inputQuestionId = null;
			editor.setText("");
		}

		function navigateTabs(delta: number) {
			currentTab = (currentTab + delta + totalTabs) % totalTabs;
			optionIndex = 0;
			maybeAutoInput();
			refresh();
		}

		// Editor submit callback
		editor.onSubmit = (value) => {
			if (!inputQuestionId) return;
			const q = questions.find((x) => x.id === inputQuestionId);
			if (!q) return;
			const trimmed = value.trim() || "(no response)";
			if (isMultiSelect(q)) {
				// Accumulate: stay on this question so the user can keep selecting.
				const d = draftFor(q.id);
				d.custom.push(trimmed);
				answers.delete(q.id); // must be re-confirmed (or auto-committed at submit)
				leaveInputMode();
				refresh();
				return;
			}
			saveAnswerSingle(inputQuestionId, trimmed, trimmed, true);
			leaveInputMode();
			advanceAfterAnswer();
		};

		function handleInput(data: string) {
			// Input mode: route to editor
			if (inputMode) {
				const activeQ = currentQuestion();
				// Free-text inputs have no option list; allow Tab navigation and
				// treat Esc as cancel of the whole questionnaire.
				if (isFreeText(activeQ)) {
					if (matchesKey(data, Key.tab)) {
						leaveInputMode();
						navigateTabs(1);
						return;
					}
					if (matchesKey(data, Key.shift("tab"))) {
						leaveInputMode();
						navigateTabs(-1);
						return;
					}
					if (matchesKey(data, Key.escape)) {
						leaveInputMode();
						submit(true);
						return;
					}
					editor.handleInput(data);
					refresh();
					return;
				}
				if (matchesKey(data, Key.escape)) {
					leaveInputMode();
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			const q = currentQuestion();
			const opts = currentOptions();

			// Tab navigation (multi-question only)
			if (isMulti) {
				if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
					navigateTabs(1);
					return;
				}
				if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
					navigateTabs(-1);
					return;
				}
			}

			// Submit tab
			if (currentTab === questions.length) {
				if (matchesKey(data, Key.enter) && allAnswered()) {
					submit(false);
				} else if (matchesKey(data, Key.escape)) {
					submit(true);
				}
				return;
			}

			if (!q) return;
			const multi = isMultiSelect(q);

			// Option navigation
			if (matchesKey(data, Key.up)) {
				optionIndex = Math.max(0, optionIndex - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				optionIndex = Math.min(opts.length - 1, optionIndex + 1);
				refresh();
				return;
			}

			// Multi-select: Space toggles a preset option
			if (multi && matchesKey(data, Key.space)) {
				const opt = opts[optionIndex];
				if (opt && !opt.isOther) {
					const d = draftFor(q.id);
					if (d.selected.has(optionIndex)) {
						d.selected.delete(optionIndex);
					} else {
						d.selected.add(optionIndex);
					}
					answers.delete(q.id); // draft is source of truth until committed
					refresh();
				}
				return;
			}

			// Select / confirm
			if (matchesKey(data, Key.enter)) {
				const opt = opts[optionIndex];
				// "Type something" -> edit mode (single & multi)
				if (opt && opt.isOther) {
					inputMode = true;
					inputQuestionId = q.id;
					editor.setText("");
					refresh();
					return;
				}
				// Multi-select: Enter commits the draft for this question
				if (multi) {
					const d = draftFor(q.id);
					if (d.selected.size === 0 && d.custom.length === 0) {
						refresh(); // nothing chosen yet; ignore
						return;
					}
					commitMulti(q);
					advanceAfterAnswer();
					return;
				}
				// Single-select: choose and advance
				if (opt) {
					saveAnswerSingle(q.id, opt.value, opt.label, false, optionIndex + 1);
					advanceAfterAnswer();
				}
				return;
			}

			// Cancel
			if (matchesKey(data, Key.escape)) {
				submit(true);
			}
		}

		// Free-text first question starts in input mode right away
		maybeAutoInput();

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;

			const lines: string[] = [];
			const renderWidth = Math.max(1, width);
			const q = currentQuestion();
			const opts = currentOptions();
			const multi = isMultiSelect(q);
			const freeText = isFreeText(q);

			function addWrapped(text: string) {
				lines.push(...wrapTextWithAnsi(text, renderWidth));
			}

			function addWrappedWithPrefix(prefix: string, text: string) {
				const prefixWidth = visibleWidth(prefix);
				if (prefixWidth >= renderWidth) {
					addWrapped(prefix + text);
					return;
				}
				const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
				const continuationPrefix = " ".repeat(prefixWidth);
				for (let i = 0; i < wrapped.length; i++) {
					lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
				}
			}

			lines.push(theme.fg("accent", "─".repeat(renderWidth)));

			// Tab bar (multi-question only)
			if (isMulti) {
				const tabs: string[] = ["← "];
				for (let i = 0; i < questions.length; i++) {
					const isActive = i === currentTab;
					const isAnswered = questionHasAnswer(questions[i]);
					const lbl = questions[i].label;
					const box = isAnswered ? "■" : "□";
					const color = isAnswered ? "success" : "muted";
					const text = ` ${box} ${lbl} `;
					const styled = isActive ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(color, text);
					tabs.push(`${styled} `);
				}
				const canSubmit = allAnswered();
				const isSubmitTab = currentTab === questions.length;
				const submitText = " ✓ Submit ";
				const submitStyled = isSubmitTab
					? theme.bg("selectedBg", theme.fg("text", submitText))
					: theme.fg(canSubmit ? "success" : "dim", submitText);
				tabs.push(`${submitStyled} →`);
				addWrappedWithPrefix(" ", tabs.join(""));
				lines.push("");
			}

			// Options renderer (multi-select aware)
			function renderOptions() {
				const draft = multi && q ? draftFor(q.id) : null;
				for (let i = 0; i < opts.length; i++) {
					const opt = opts[i];
					const cursor = i === optionIndex;
					const isOther = opt.isOther === true;

					let prefix: string;
					let label: string;
					if (multi && !isOther) {
						const checked = !!(draft && draft.selected.has(i));
						const box = checked ? "☑" : "☐";
						prefix = cursor ? theme.fg("accent", `> ${box} `) : `  ${box} `;
						label = opt.label;
					} else if (multi && isOther) {
						prefix = cursor ? theme.fg("accent", "> ") : "  ";
						const customCount = draft?.custom.length ?? 0;
						const mark = inputMode ? " ✎" : "";
						const count = customCount > 0 ? ` (${customCount} added)` : "";
						label = `${opt.label}${mark}${count}`;
					} else {
						prefix = cursor ? theme.fg("accent", "> ") : "  ";
						label = `${i + 1}. ${opt.label}${isOther && inputMode ? " ✎" : ""}`;
					}

					const color = cursor || (isOther && inputMode) ? "accent" : "text";
					addWrappedWithPrefix(prefix, theme.fg(color, label));
					if (opt.description) {
						addWrappedWithPrefix("     ", theme.fg("muted", opt.description));
					}
				}
			}

			// Content
			if (inputMode && q) {
				addWrappedWithPrefix(" ", theme.fg("text", q.prompt));
				lines.push("");
				renderOptions();
				lines.push("");
				addWrappedWithPrefix(
					" ",
					theme.fg("muted", multi ? "Add a custom entry (Enter to add, then keep selecting):" : "Your answer:"),
				);
				for (const line of editor.render(Math.max(1, renderWidth - 2))) {
					lines.push(` ${line}`);
				}
				lines.push("");
				addWrappedWithPrefix(
					" ",
					theme.fg(
						"dim",
						freeText
							? isMulti
								? "Enter to answer • Tab next/prev • Esc cancel"
								: "Enter to submit • Esc to cancel"
							: multi
								? "Enter to add • Esc back to options"
								: "Enter to submit • Esc to cancel",
					),
				);
			} else if (currentTab === questions.length) {
				addWrappedWithPrefix(" ", theme.fg("accent", theme.bold("Ready to submit")));
				lines.push("");
				for (const question of questions) {
					const answer = answers.get(question.id);
					if (answer) {
						let summary: string;
						if (answer.multiple) {
							const parts = [...(answer.labels ?? [])];
							for (const c of answer.customValues ?? []) parts.push(`(wrote) ${c}`);
							summary = `${theme.fg("muted", `${question.label}: `)}${theme.fg("text", parts.join(", ") || "(none)")}`;
						} else {
							const wrotePrefix = answer.wasCustom ? "(wrote) " : "";
							summary = `${theme.fg("muted", `${question.label}: `)}${theme.fg("text", wrotePrefix + answer.label)}`;
						}
						addWrappedWithPrefix(" ", summary);
					}
				}
				lines.push("");
				if (allAnswered()) {
					addWrappedWithPrefix(" ", theme.fg("success", "Press Enter to submit"));
				} else {
					const missing = questions
						.filter((qx) => !questionHasAnswer(qx))
						.map((qx) => qx.label)
						.join(", ");
					addWrappedWithPrefix(" ", theme.fg("warning", `Unanswered: ${missing}`));
				}
			} else if (q) {
				addWrappedWithPrefix(" ", theme.fg("text", q.prompt));
				if (multi) {
					const d = draftFor(q.id);
					const total = d.selected.size + d.custom.length;
					addWrappedWithPrefix(
						" ",
						theme.fg("dim", `Multi-select • ${total} chosen • Space toggle • Enter confirm`),
					);
				}
				lines.push("");
				renderOptions();
			}

			lines.push("");
			if (!inputMode) {
				const help = multi
					? isMulti
						? "Tab/←→ navigate • ↑↓ move • Space toggle • Enter confirm • Esc cancel"
						: "↑↓ move • Space toggle • Enter confirm • Esc cancel"
					: isMulti
						? "Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel"
						: "↑↓ navigate • Enter select • Esc cancel";
				addWrappedWithPrefix(" ", theme.fg("dim", help));
			}
			lines.push(theme.fg("accent", "─".repeat(renderWidth)));

			cachedLines = lines;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
		};
	});
}

export default function questionnaire(pi: ExtensionAPI) {
	pi.registerTool({
		name: "questionnaire",
		label: "Questionnaire",
		description:
			"Ask the user one or more questions. Use for clarifying requirements, getting preferences, or confirming decisions. For single questions, shows a simple option list. For multiple questions, shows a tab-based interface. Set multiple:true on a question to enable multi-select (checkbox) mode where the user can pick several options and accumulate custom inputs. Set options to an empty array for a free-text question.",
		parameters: QuestionnaireParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui") {
				return errorResult("Error: UI not available (running in non-interactive mode)");
			}
			if (params.questions.length === 0) {
				return errorResult("Error: No questions provided");
			}

			const questions = normalizeQuestions(params.questions);
			const result = await runQuestionnaireUI(ctx, questions);

			if (result.cancelled) {
				return {
					content: [{ type: "text", text: "User cancelled the questionnaire" }],
					details: result,
				};
			}

			const answerLines = result.answers.map((a) => {
				const qLabel = questions.find((q) => q.id === a.id)?.label || a.id;
				if (a.multiple) {
					const parts = [...(a.labels ?? [])];
					for (const c of a.customValues ?? []) parts.push(`user wrote: ${c}`);
					return `${qLabel}: user selected: [${parts.join("; ")}]`;
				}
				if (a.wasCustom) {
					return `${qLabel}: user wrote: ${a.label}`;
				}
				return `${qLabel}: user selected: ${a.index}. ${a.label}`;
			});

			return {
				content: [{ type: "text", text: answerLines.join("\n") }],
				details: result,
			};
		},

		renderCall(args, theme, _context) {
			const qs = (args.questions as Question[]) || [];
			const count = qs.length;
			const multiCount = qs.filter((q) => q.multiple).length;
			const labels = qs.map((q) => q.label || q.id).join(", ");
			let text = theme.fg("toolTitle", theme.bold("questionnaire "));
			text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
			if (multiCount > 0) {
				text += theme.fg("dim", ` • ${multiCount} multi-select`);
			}
			if (labels) {
				text += theme.fg("dim", ` (${labels})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as QuestionnaireResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			const lines = details.answers.map((a) => {
				if (a.multiple) {
					const parts = [...(a.labels ?? [])];
					for (const c of a.customValues ?? []) {
						parts.push(`${theme.fg("muted", "(wrote) ")}${c}`);
					}
					const joined = parts.join(theme.fg("dim", ", "));
					return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${joined}`;
				}
				if (a.wasCustom) {
					return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${theme.fg("muted", "(wrote) ")}${a.label}`;
				}
				const display = a.index ? `${a.index}. ${a.label}` : a.label;
				return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${display}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	// -----------------------------------------------------------------------
	// /answer - extract questions from the last assistant message and answer
	// them in this questionnaire TUI (integrated from mitsupi's answer.ts)
	// -----------------------------------------------------------------------
	async function answerHandler(ctx: ExtensionContext) {
		if (!ctx.hasUI) {
			ctx.ui.notify("answer requires interactive mode", "error");
			return;
		}

		const lastAssistantText = getLastAssistantText(ctx.sessionManager.getEntries());
		if (!lastAssistantText) {
			ctx.ui.notify("No assistant messages found", "error");
			return;
		}
		if (!ctx.model) {
			ctx.ui.notify("No model selected", "error");
			return;
		}

		const extractionModel = await selectExtractionModel(ctx.model, ctx.modelRegistry);

		const extractionResult = await ctx.ui.custom<ExtractionResult | null>((tui, theme, _kb, done) => {
			const loader = new BorderedLoader(tui, theme, `Extracting questions using ${extractionModel.id}...`);
			loader.onAbort = () => done(null);

			const doExtract = async () => {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(extractionModel);
				if (!auth.ok) {
					throw new Error(auth.error);
				}
				const userMessage: UserMessage = {
					role: "user",
					content: [{ type: "text", text: lastAssistantText! }],
					timestamp: Date.now(),
				};

				const response = await complete(
					extractionModel,
					{ systemPrompt: EXTRACTION_SYSTEM_PROMPT, messages: [userMessage] },
					{ apiKey: auth.apiKey, headers: auth.headers, signal: loader.signal },
				);

				if (response.stopReason === "aborted") {
					return null;
				}

				const responseText = response.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n");

				return parseExtractionResult(responseText);
			};

			doExtract()
				.then(done)
				.catch(() => done(null));

			return loader;
		});

		if (extractionResult === null) {
			ctx.ui.notify("Cancelled", "info");
			return;
		}

		if (extractionResult.questions.length === 0) {
			ctx.ui.notify("No questions found in the last message", "info");
			return;
		}

		const questions = normalizeQuestions(
			extractionResult.questions.map((eq) => ({
				prompt: eq.context ? `${eq.question}\n\n${eq.context}` : eq.question,
			})),
		);

		const result = await runQuestionnaireUI(ctx, questions);
		if (result.cancelled) {
			ctx.ui.notify("Cancelled", "info");
			return;
		}

		// Send the answers directly as a message and trigger a turn
		pi.sendMessage(
			{
				customType: "answers",
				content: "I answered your questions in the following way:\n\n" + formatPlainAnswers(result),
				display: true,
			},
			{ triggerTurn: true },
		);
	}

	pi.registerCommand("answer", {
		description: "Extract questions from last assistant message into questionnaire",
		handler: (_args, ctx) => answerHandler(ctx),
	});

	pi.registerShortcut("ctrl+.", {
		description: "Extract and answer questions",
		handler: (ctx) => answerHandler(ctx),
	});
}
