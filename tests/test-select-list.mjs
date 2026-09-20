// Functional test for extensions/lib/select-list.ts
// (run: node --experimental-strip-types tests/test-select-list.mjs)
//
// `ctx.ui.custom` is mocked: the factory is captured and driven manually with
// raw key sequences, so no real terminal is needed.
//
// Regression guard for the "[object Object]" bug: rich lists must go through
// SelectList, and the picked result must be the item's `value`.

let pickFromList;
let getKeybindings;
try {
	({ pickFromList } = await import("../extensions/lib/select-list.ts"));
	({ getKeybindings } = await import("@earendil-works/pi-tui"));
} catch (err) {
	if (err?.code === "ERR_MODULE_NOT_FOUND") {
		console.log("skipped: run `npm install` first (deps come from pi's bundled packages)");
		process.exit(0);
	}
	throw err;
}

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") => {
	cond ? (pass++, console.log(`  ok  ${name}`)) : (fail++, console.log(`FAIL  ${name} ${extra}`));
};

// Raw terminal input, not the symbolic `Key.*` identifiers.
const ENTER = "\r";
const ESCAPE = "\x1b";
const DOWN = "\x1b[B";

const theme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};
const tui = { requestRender: () => {} };
// Real keybinding manager with default keys, so arrow/enter/escape behave as in pi.
const keybindings = getKeybindings();

/** Drive pickFromList with a scripted list of key sequences. */
async function runPicker(items, keys = [], options = {}) {
	let done;
	const result = new Promise((resolve) => (done = resolve));
	const ctx = {
		hasUI: true,
		ui: {
			custom(factory) {
				const component = factory(tui, theme, keybindings, done);
				for (const key of keys) component.handleInput(key);
				component.render(80); // must not throw
				return result;
			},
		},
	};
	const picked = await pickFromList(ctx, "Pick", items, options);
	return { picked, rendered: true };
}

const items = [
	{ value: "alpha", label: "Alpha", description: "first" },
	{ value: "beta", label: "Beta", description: "second" },
	{ value: "gamma", label: "Gamma", description: "third" },
];

// Single item short-circuits (no dialog).
{
	const ctx = { hasUI: true, ui: { custom: () => { throw new Error("should not open a dialog"); } } };
	check("single item returns its value without a dialog", (await pickFromList(ctx, "Pick", [items[0]])) === "alpha");
}

// No UI -> null.
check("no UI returns null", (await pickFromList({ hasUI: false, ui: {} }, "Pick", items)) === null);
check("empty list returns null", (await pickFromList({ hasUI: true, ui: {} }, "Pick", [])) === null);

// Enter on the first item.
{
	const { picked } = await runPicker(items, [ENTER]);
	check("enter selects the default item", picked === "alpha", `got ${JSON.stringify(picked)}`);
}

// Arrow down then enter -> second item.
{
	const { picked } = await runPicker(items, [DOWN, ENTER]);
	check("down + enter selects the second item", picked === "beta", `got ${JSON.stringify(picked)}`);
}

// Escape cancels -> null.
{
	const { picked } = await runPicker(items, [ESCAPE]);
	check("escape cancels", picked === null, `got ${JSON.stringify(picked)}`);
}

// Typing filters (searchable forced on for a short list) and enter picks the filtered item.
{
	const { picked } = await runPicker(items, [..."gam", ENTER], { searchable: true, hint: null });
	check("typed query filters the list", picked === "gamma", `got ${JSON.stringify(picked)}`);
}

// A query that matches nothing still lets the user cancel.
{
	const { picked } = await runPicker(items, [..."zzzz", ESCAPE], { searchable: true });
	check("no-match + escape cancels", picked === null, `got ${JSON.stringify(picked)}`);
}

// The selected value is always the item value, never a rendered label.
{
	const { picked } = await runPicker(items, [ENTER], { searchable: false });
	check("result is the item value, not the label", picked === "alpha");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
