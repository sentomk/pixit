# pixit

My [pi coding agent](https://buildwithpi.ai/) package: extensions, skills, and themes I use across projects.

Install with:

```bash
pi install npm:pixit
```

## Extensions

* [`questionnaire.ts`](extensions/questionnaire.ts) - Unified questionnaire tool. Single questions show an option list, multiple questions get tab navigation, `multiple: true` enables checkbox multi-select with accumulating custom entries, and empty `options` render a free-text editor. Includes `/answer` (shortcut `ctrl+.`): extracts unanswered questions from the last assistant message via LLM, lets you answer them in the same TUI, then sends the compiled answers back to trigger a new turn.
* [`custom-footer.ts`](extensions/custom-footer.ts) - Two-line status footer (tokens/cost/context + git branch/model/thinking level), O(1) cached rendering, toggled with `/footer`.
* [`xedit.ts`](extensions/xedit.ts) - Enhanced editing tool (`xedit`). Classic exact-replace plus `multi` batch edits and Codex-style `patch`. Ambiguous multi-match edits are rejected with match line numbers unless `replaceAll: true`; unambiguous whitespace-tolerant fuzzy matching kicks in when exact match fails; every batch runs on a virtual filesystem first and rolls back all writes if any step fails.
* [`btw.ts`](extensions/btw.ts) - `/btw` side-chat popover with optional summary injection back into the main chat.
* [`review.ts`](extensions/review.ts) - Code review command (working tree, PR-style diff, commits, custom instructions).
* [`todos.ts`](extensions/todos.ts) - File-backed todo manager with TUI.
* [`checkpoint.ts`](extensions/checkpoint.ts) - Automatic per-turn git snapshots into a private ref chain (never touches your index or branch). `/undo` reverts the working tree to before the last agent turn (repeat to walk further back), `/checkpoints` lists recent snapshots.
* [`second-opinion.ts`](extensions/second-opinion.ts) - `/so [question]` sends the recent conversation to a different model than the active one and prints its independent critique. Model choice is remembered for the session.
* [`session-grep.ts`](extensions/session-grep.ts) - `/sg <query>` full-text search across past sessions of this project; selecting a result prints the original message back into chat.
* [`clipboard.ts`](extensions/clipboard.ts) - `/copy-code` copies the last fenced code block from the assistant's reply to the system clipboard (clip.exe / pbcopy / wl-copy / xclip / xsel).

## Themes

* [`tokyo-night.json`](themes/tokyo-night.json) - Tokyo Night-inspired theme.
* [`one-dark-pro.json`](themes/one-dark-pro.json) - One Dark Pro-inspired theme.

Select with `/theme` or set `"theme"` in settings.json.

Run tests:

```bash
node --experimental-strip-types tests/test-xedit.mjs
node --experimental-strip-types tests/test-checkpoint.mjs
node --experimental-strip-types tests/test-select-list.mjs
```

## Development

Local testing without publishing:

```bash
pi install /absolute/path/to/sentomk
```

Or try it for one run only:

```bash
pi -e /absolute/path/to/sentomk
```

Publish a new version:

```bash
npm version patch   # or minor / major
npm publish
```
