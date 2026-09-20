// Functional test for the checkpoint extension (run: node tests/test-checkpoint.mjs)
// Requires git on PATH.
//
// Simulated timeline (turn_start fires BEFORE the agent edits):
//   session_start → C0 (a=v0)
//   turn_start#1  → C1 (a=v0)        [turn 1 begins]
//   edit          a=v1, b=new        [turn 1 work]
//   turn_start#2  → C2 (a=v1, b=new) [turn 2 begins]
//   edit          a=v2, rm b, add c  [turn 2 work]
//   /undo #1      → expect a=v1, b=new, no c   (revert turn-2 work)
//   /undo #2      → expect a=v0, no b, no c    (revert turn-1 work too)
//   new turn      → turn_start#3 (resets undo pos), edit a=v9
//   /undo #3      → expect a=v0
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const g = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8" });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pixit-ckpt-"));
g(["init", "-b", "main"], tmp);
g(["config", "user.email", "t@t"], tmp);
g(["config", "user.name", "t"], tmp);
fs.writeFileSync(path.join(tmp, "a.txt"), "v0\n");
g(["add", "."], tmp);
g(["commit", "-m", "init"], tmp);

// --- load extension with mocked pi ---
const handlers = {};
const commands = {};
const checkpoint = (await import("../extensions/checkpoint.ts")).default;
checkpoint({
	on: (name, handler) => (handlers[name] = handler),
	registerCommand: (name, opts) => (commands[name] = opts.handler),
});

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
	cond ? (pass++, console.log(`  ok  ${name}`)) : (fail++, console.log(`FAIL  ${name} ${extra}`));
};
const readA = () => fs.readFileSync(path.join(tmp, "a.txt"), "utf8");

const ctx = { cwd: tmp, ui: { notify: () => {}, select: async () => undefined } };

await handlers["session_start"]({}, ctx); // C0
check("session_start creates first checkpoint", !!g(["rev-parse", "--verify", "refs/pixit-checkpoints/head"], tmp));

await handlers["turn_start"]({}, ctx); // C1
fs.writeFileSync(path.join(tmp, "a.txt"), "v1\n");
fs.writeFileSync(path.join(tmp, "b.txt"), "new\n");

await handlers["turn_start"]({}, ctx); // C2: a=v1, b=new
fs.writeFileSync(path.join(tmp, "a.txt"), "v2\n");
fs.rmSync(path.join(tmp, "b.txt"));
fs.writeFileSync(path.join(tmp, "c.txt"), "c\n");

// /undo → revert turn-2 work
await commands["undo"]("", ctx);
check(
	"/undo #1 restores pre-turn-2 state",
	readA() === "v1\n" &&
		fs.readFileSync(path.join(tmp, "b.txt"), "utf8") === "new\n" &&
		!fs.existsSync(path.join(tmp, "c.txt")),
	`\n    got: ${JSON.stringify(readA())}`,
);

// /undo again → revert turn-1 work as well
await commands["undo"]("", ctx);
check(
	"/undo #2 walks further back",
	readA() === "v0\n" && !fs.existsSync(path.join(tmp, "b.txt")),
	`\n    got: ${JSON.stringify(readA())}`,
);

// new agent turn resets undo position and re-snapshots; then undo its work
await handlers["turn_start"]({}, ctx); // C3: a=v0
fs.writeFileSync(path.join(tmp, "a.txt"), "v9\n");
await commands["undo"]("", ctx);
check(
	"/undo after new turn restores latest checkpoint (v0)",
	readA() === "v0\n",
	`\n    got: ${JSON.stringify(readA())}`,
);

// --- /checkpoints must hand plain strings to ui.select ---
// Object options render as "[object Object]" (ui.select maps each option to
// { value: option, label: option } internally).
const selectCalls = [];
const uiCtx = {
	cwd: tmp,
	hasUI: true,
	ui: {
		notify: () => {},
		select: async (title, options) => {
			selectCalls.push({ title, options });
			return undefined;
		},
	},
};
await commands["checkpoints"]("", uiCtx);
const lastSelect = selectCalls.at(-1);
check("/checkpoints opens a picker", !!lastSelect);
check(
	"/checkpoints options are plain strings",
	!!lastSelect && lastSelect.options.length > 0 && lastSelect.options.every((o) => typeof o === "string"),
	JSON.stringify(lastSelect?.options?.[0]),
);

// --- non-git directory: probe once, warn once, stay silent on later turns ---
const plain = fs.mkdtempSync(path.join(os.tmpdir(), "pixit-nogit-"));
const noticed = [];
const nogitCtx = {
	cwd: plain,
	hasUI: true,
	ui: {
		notify: (message) => noticed.push(message),
		select: async () => undefined,
	},
};
const nogitHandlers = {};
const nogitCommands = {};
checkpoint({
	on: (name, handler) => (nogitHandlers[name] = handler),
	registerCommand: (name, opts) => (nogitCommands[name] = opts.handler),
});

await nogitHandlers["session_start"]({}, nogitCtx);
await nogitHandlers["turn_start"]({}, nogitCtx);
await nogitHandlers["turn_start"]({}, nogitCtx);
await nogitHandlers["turn_start"]({}, nogitCtx);
check(
	"non-git: warned exactly once across turns",
	noticed.filter((m) => m.includes("not a git repository")).length === 1,
	JSON.stringify(noticed),
);
check(
	"non-git: no checkpoint ref written",
	!fs.existsSync(path.join(plain, ".git")),
);

noticed.length = 0;
await nogitCommands["undo"]("", nogitCtx);
check("/undo in non-git repo explains why", noticed.some((m) => m.includes("/undo")));

noticed.length = 0;
await nogitCommands["checkpoints"]("", nogitCtx);
check("/checkpoints in non-git repo explains why", noticed.some((m) => m.includes("/checkpoints")));

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(plain, { recursive: true, force: true });
process.exit(fail > 0 ? 1 : 0);
