// Functional tests for the xedit extension (run: node test-xedit.mjs)
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const xedit = (await import("../extensions/xedit.ts")).default;

const tools = {};
xedit({ registerTool: (t) => (tools[t.name] = t) });
const tool = tools["edit"];
if (!tool) throw new Error("edit tool not registered");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xedit-test-"));
const file = path.join(tmp, "a.txt");
fs.writeFileSync(file, "alpha one\nalpha two\nalpha three\nend\n");

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
	if (cond) {
		pass++;
		console.log(`  ok  ${name}`);
	} else {
		fail++;
		console.log(`FAIL  ${name} ${extra}`);
	}
}

const ctx = { cwd: tmp };
const exec = (params) => tool.execute("t1", params, undefined, undefined, ctx);

// --- 1. Ambiguity rejection ---
try {
	await exec({ path: file, oldText: "alpha", newText: "beta" });
	check("ambiguity rejected (throws)", false);
} catch (err) {
	const msg = String(err.message);
	check(
		"ambiguity rejected (throws)",
		msg.includes("3 times") && msg.includes("replaceAll"),
		`\n    ${msg.split("\n")[0]}`,
	);
}
check(
	"file untouched after rejection",
	fs.readFileSync(file, "utf8") === "alpha one\nalpha two\nalpha three\nend\n",
);

// --- 2. replaceAll ---
await exec({ path: file, oldText: "alpha", newText: "gamma", replaceAll: true });
check(
	"replaceAll replaces all occurrences",
	fs.readFileSync(file, "utf8") === "gamma one\ngamma two\ngamma three\nend\n",
);

// --- 3. Fuzzy fallback (indentation difference) ---
await exec({
	path: file,
	oldText: "gamma two", // will differ by indentation below
	newText: "GAMMA TWO",
});
{
	fs.writeFileSync(file, "alpha one\n    alpha two\nalpha three\nend\n");
	try {
		await exec({ path: file, oldText: "alpha two\n", newText: "TWO\n" });
		const out = fs.readFileSync(file, "utf8");
		check(
			"fuzzy match applies unambiguous indentation-differing edit",
			out === "alpha one\n    TWO\nalpha three\nend\n",
			`\n    got: ${JSON.stringify(out)}`,
		);
	} catch (err) {
		check("fuzzy match applies unambiguous indentation-differing edit", false, String(err.message));
	}
}

// --- 4. Rollback on mid-batch failure ---
{
	fs.writeFileSync(path.join(tmp, "b.txt"), "b1\n");
	fs.writeFileSync(path.join(tmp, "c.txt"), "c1 unique\n");
	try {
		await exec({
			multi: [
				{ path: "b.txt", oldText: "b1", newText: "B1-CHANGED" },
				{ path: "c.txt", oldText: "does-not-exist", newText: "x" },
			],
		});
		check("rollback throws on failing batch", false);
	} catch (err) {
		check(
			"rollback message present",
			String(err.message).includes("Rolled back"),
			`\n    ${String(err.message).split("\n")[0]}`,
		);
	}
	check(
		"first file rolled back after batch failure",
		fs.readFileSync(path.join(tmp, "b.txt"), "utf8") === "b1\n",
		`\n    got: ${JSON.stringify(fs.readFileSync(path.join(tmp, "b.txt"), "utf8"))}`,
	);
}

// --- 5. Normal exact edit still works ---
{
	const r = await exec({ path: file, oldText: "alpha three", newText: "THREE" });
	check("normal exact edit succeeds", r.content[0].text.includes("Edited"));
}

// --- 6. patch still rejected together with classic params ---
try {
	await exec({ patch: "*** Begin Patch\n*** End Patch\n", oldText: "x", newText: "y" });
	check("patch+classic mutual exclusion", false);
} catch (err) {
	check("patch+classic mutual exclusion", String(err.message).includes("mutually exclusive"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
