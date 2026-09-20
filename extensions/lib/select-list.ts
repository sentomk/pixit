/**
 * Shared list picker for pixit extensions.
 *
 * `ctx.ui.select()` only accepts plain strings (the runtime renders each option
 * verbatim as `{ value: option, label: option }`), so anything richer — a
 * description column, fuzzy search, scrolling — must go through
 * `ctx.ui.custom()` + `SelectList` from `@earendil-works/pi-tui`.
 *
 * Note: this file lives in a subdirectory without an `index.ts`, so pi's
 * extension discovery ignores it and only the importing extensions load it.
 */

import { DynamicBorder, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Container,
	fuzzyFilter,
	Input,
	SelectList,
	Spacer,
	Text,
	type SelectItem,
} from "@earendil-works/pi-tui";

export interface ListPickerOptions {
	/** Rows visible at once before scrolling (default 12). */
	maxVisible?: number;
	/** Show a fuzzy filter input (default: only when there are more than 8 items). */
	searchable?: boolean;
	/** Hint line rendered below the list. Pass null to hide it. */
	hint?: string | null;
}

/**
 * Show a scrollable (optionally searchable) list and return the selected
 * item's `value`, or `null` when the user cancels.
 */
export async function pickFromList(
	ctx: ExtensionContext,
	title: string,
	items: SelectItem[],
	options: ListPickerOptions = {},
): Promise<string | null> {
	if (items.length === 0 || !ctx.hasUI) return null;
	if (items.length === 1) return items[0]!.value;

	const maxVisible = options.maxVisible ?? 12;
	const searchable = options.searchable ?? items.length > 8;
	const hint =
		options.hint === undefined
			? searchable
				? "Type to filter • ↑↓ navigate • enter select • esc cancel"
				: "↑↓ navigate • enter select • esc cancel"
			: options.hint;

	return ctx.ui.custom<string | null>((tui, theme, keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));

		const searchInput = searchable ? new Input() : null;
		if (searchInput) container.addChild(searchInput);
		container.addChild(new Spacer(1));

		const listContainer = new Container();
		container.addChild(listContainer);
		if (hint) container.addChild(new Text(theme.fg("dim", hint), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		let filtered = items;
		let selectList: SelectList | null = null;

		const refresh = () => {
			listContainer.clear();
			if (filtered.length === 0) {
				listContainer.addChild(new Text(theme.fg("warning", "  No matching items"), 1, 0));
				selectList = null;
				return;
			}
			selectList = new SelectList(filtered, Math.min(filtered.length, maxVisible), {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			});
			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done(null);
			listContainer.addChild(selectList);
		};

		const applyFilter = () => {
			const query = searchInput?.getValue().trim();
			filtered = query
				? fuzzyFilter(items, query, (item) => `${item.label} ${item.value} ${item.description ?? ""}`)
				: items;
			refresh();
		};

		refresh();

		return {
			// Focusable: forward focus to the search input so the hardware cursor
			// (IME candidate window) is positioned correctly.
			get focused() {
				return searchInput?.focused ?? false;
			},
			set focused(value: boolean) {
				if (searchInput) searchInput.focused = value;
			},
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				const isListKey =
					keybindings.matches(data, "tui.select.up") ||
					keybindings.matches(data, "tui.select.down") ||
					keybindings.matches(data, "tui.select.confirm") ||
					keybindings.matches(data, "tui.select.cancel");
				if (isListKey) {
					if (selectList) selectList.handleInput(data);
					else if (keybindings.matches(data, "tui.select.cancel")) done(null);
				} else {
					searchInput?.handleInput(data);
					applyFilter();
				}
				tui.requestRender();
			},
		};
	});
}
