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

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail > 0 ? 1 : 0);
