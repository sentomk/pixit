# pixit

My [pi coding agent](https://buildwithpi.ai/) package: extensions, skills, and themes I use across projects.

Install with:

```bash
pi install npm:@sentomk/pixit
```

## Extensions

* [`vim.ts`](extensions/vim.ts) - Vim-style prompt editor with normal/insert modes, motions, operators, undo/redo, and per-mode custom key mappings. Toggle with `/vim`; see configuration below.
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

## Vim prompt editing

Vim mode is enabled when this package loads and starts in **INSERT** mode. Press
`Esc` for **NORMAL**, then `i` to resume typing. The editor's top border shows the
mode and pending keys. This edits the chat prompt; it does not launch an external
Vim process or edit project files directly.

| Keys | Action |
| --- | --- |
| `h j k l`, arrows | Move by character or logical line |
| `w b e`, `W B E` | Move by word or whitespace-separated word |
| `ge gE` | Move backward to the previous word/WORD end; combine with `d/c/y`, e.g. `dge` |
| `0 ^ $`, `gg G` | Line start, first nonblank, line end, first/last line |
| `f F t T` + character | Find a character or stop just before it on this line |
| `i a I A`, `o O` | Insert/append, or open a line below/above |
| `d c y` + motion | Delete, change, or yank text |
| `dd cc yy`, `diw ciw yiw`, `daw caw yaw` | Line or inner/around-word operations (`iW`/`aW` also work) |
| `x s`, `D C`, `r` + character | Delete/substitute, delete/change to line end, replace |
| `p P`, `J` | Paste after/before, join lines |
| `u`, `Ctrl+r` | Undo/redo (an insert session is one undo step) |

Counts work with motions and operators, e.g. `3w`, `2dd`, `d2w`, `2d3w`,
`3gg`, `2x`, and `d2ge`. `dge` includes both the destination and the character
under the cursor, matching Vim's inclusive backward motion. `j/k` stay within
the current prompt rather than browsing history.
The yank register is internal to this editor, separate from the system clipboard.
This is a focused Vim subset: visual mode, macros, registers, search commands,
`.` repeat, Ex commands, and `.vimrc` are not implemented.

Enter still sends the prompt, Shift+Enter inserts a newline, and pi's app shortcuts
remain available unless explicitly mapped. An open completion menu takes priority;
Escape first dismisses it. Otherwise Escape leaves INSERT mode, cancels a pending
NORMAL command, or passes through to pi's interrupt action when already in idle
NORMAL mode. Bracketed paste inserts literal text in either mode, without executing
Vim commands or mappings. Undo history is cleared after submission or externally
replacing the draft.

### Custom key mappings

Create `~/.pi/agent/vim.json` for global settings (or `vim.json` inside
`PI_CODING_AGENT_DIR` if customized). A project's `.pi/vim.json` overrides global
settings; mappings merge by mode and key. No config file is required.

```json
{
  "enabled": true,
  "startMode": "insert",
  "timeout": 400,
  "leader": " ",
  "mappings": {
    "insert": {
      "jj": "<Esc>",
      "jk": "<Esc>"
    },
    "normal": {
      "H": "0",
      "L": "$",
      "<leader>y": "yy",
      "<C-s>": "<Enter>"
    }
  }
}
```

Mappings expand into Vim keys without recursively applying other mappings.
Use `""` to swallow a key, or `null` to remove an inherited mapping and restore
its default behavior. Supported notation: `<Esc>`, `<Enter>`/`<CR>`, `<Tab>`,
`<BS>`, `<Del>`, `<Space>`, `<lt>`, `<Left>`/`<Right>`/`<Up>`/`<Down>`,
`<Home>`/`<End>`, `<C-a>` through `<C-z>`, and `<leader>`. Escape itself is reserved
for leaving a mode or cancelling. `leader` is one printable character;
`timeout` is 50–5000 milliseconds. Unmatched or timed-out INSERT prefixes are
replayed literally, so typing a lone `j` is not lost. Ambiguous mappings wait for
the timeout or another key; the longest complete match wins.

Use `/vim on`, `/vim off`, `/vim reload`, or `/vim status`; `/vim` alone toggles.
`reload` re-reads both config files, including `enabled`. Invalid files produce a
warning and are skipped, keeping defaults and settings from other valid files.
Toggling preserves the current draft. Vim uses pi's custom-editor slot; when
disabled, it restores the previous editor if it still owns that slot. It does not
combine editing behavior with another custom editor.

## Themes

* [`tokyo-night.json`](themes/tokyo-night.json) - Tokyo Night-inspired theme.
* [`one-dark-pro.json`](themes/one-dark-pro.json) - One Dark Pro-inspired theme.

Select with `/theme` or set `"theme"` in settings.json.

Run tests:

```bash
node --experimental-strip-types tests/test-xedit.mjs
node --experimental-strip-types tests/test-checkpoint.mjs
node --experimental-strip-types tests/test-select-list.mjs
node --experimental-strip-types --test tests/test-vim.mjs
```

## Development

Local testing without publishing:

```bash
pi install /absolute/path/to/pixit
```

Or try it for one run only:

```bash
pi -e /absolute/path/to/pixit
```

Publish a new version (publishes to the public npm registry, as
`@sentomk/pixit` — see `publishConfig` in package.json):

```bash
npm login --registry https://registry.npmjs.org/   # once per machine
npm version patch   # or minor / major
npm publish
```

Note: commit the version bump before publishing so the `gitHead` recorded
in the package metadata points at the released tree.
