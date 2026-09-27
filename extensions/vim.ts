import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadVimConfig } from "./lib/vim-config.ts";
import { VimEditor } from "./lib/vim-editor.ts";

export default function vim(pi: ExtensionAPI): void {
	let editor: VimEditor | undefined;
	let enabled = false;
	let previous: ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;
	let installed: ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;

	function disable(ctx: ExtensionContext): void {
		editor?.dispose(); // Flush a partial insert mapping before pi copies the draft.
		editor = undefined;
		if (installed && ctx.ui.getEditorComponent() === installed) ctx.ui.setEditorComponent(previous);
		installed = undefined;
		enabled = false;
	}
	function enable(ctx: ExtensionContext): void {
		const { config, errors } = loadVimConfig(getAgentDir(), ctx.cwd);
		for (const error of errors) ctx.ui.notify(`Vim: ${error}`, "warning");
		if (enabled) disable(ctx);
		previous = ctx.ui.getEditorComponent();
		installed = (tui, theme, keybindings) => {
			editor?.dispose();
			editor = new VimEditor(tui, theme, keybindings, config);
			return editor;
		};
		ctx.ui.setEditorComponent(installed);
		enabled = true;
	}

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		const { config, errors } = loadVimConfig(getAgentDir(), ctx.cwd);
		if (config.enabled) enable(ctx);
		else {
			if (enabled) disable(ctx);
			for (const error of errors) ctx.ui.notify(`Vim: ${error}`, "warning");
		}
	});
	pi.on("session_shutdown", () => { editor?.dispose(); });
	pi.registerCommand("vim", {
		description: "Vim input mode: /vim [on|off|reload|status] (no argument toggles)",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const action = args.trim().toLowerCase() || (enabled ? "off" : "on");
			if (action === "on") enable(ctx);
			else if (action === "off") disable(ctx);
			else if (action === "reload") {
				const { config, errors } = loadVimConfig(getAgentDir(), ctx.cwd);
				if (config.enabled) enable(ctx);
				else { disable(ctx); for (const error of errors) ctx.ui.notify(`Vim: ${error}`, "warning"); }
			} else if (action !== "status") { ctx.ui.notify("Usage: /vim [on|off|reload|status]", "info"); return; }
			const { paths } = loadVimConfig(getAgentDir(), ctx.cwd);
			ctx.ui.notify(`Vim ${enabled ? "on" : "off"}. Config: ${paths.join(" → ")}`, "info");
		},
	});
}
