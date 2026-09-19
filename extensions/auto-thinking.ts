/**
 * auto-thinking — replicate oh-my-pi's `auto` thinking level in pi.
 *
 * On every user prompt, a cheap side-model classifies the prompt's coding
 * difficulty into low|medium|high|xhigh, then pi.setThinkingLevel() applies
 * it before the agent loop starts.
 *
 * Classifier model resolution (first match wins):
 *   1. $PI_AUTO_THINKING_MODEL  (format: "provider/model-id" or bare "model-id")
 *   2. Built-in default: ollama/nemotron-3-nano:30b-cloud (Ollama Cloud, proxied
 *      via the local daemon; registered in ~/.pi/agent/models.json)
 *   3. Heuristic: cheapest/smallest model in the catalogue (flash/haiku/mini...)
 *   4. The session's current model
 *
 * Toggle with /autothink on|off. On classification failure the current
 * thinking level is left untouched (never breaks the turn).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Level = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const CLASSIFIER_SYSTEM_PROMPT = `You are a routing classifier for a coding agent. Given a user prompt, rate the coding difficulty it requires and reply with EXACTLY ONE word:
- low: trivial questions, single-file tweaks, renames, explanations, simple edits, "what does this do"
- medium: normal tasks — implement a small feature, fix a bug with clear cause, write a small script, multi-file changes with obvious steps
- high: hard tasks — tricky debugging, architecture changes, performance work, multi-step refactors, subtle logic
- xhigh: very hard — deep debugging of unknown causes, algorithmically complex work, large cross-cutting redesigns, concurrency-heavy changes

Reply with exactly one word: low, medium, high, or xhigh. No other text.`;

const CHEAP_MODEL_HINTS = [
	"flash",
	"haiku",
	"mini",
	"nano",
	"small",
	"smol",
	"lite",
	"turbo",
];

/** Default classifier: NVIDIA Nemotron 3 Nano via Ollama Cloud (zero per-token cost). */
const DEFAULT_CLASSIFIER_MODEL = "ollama/nemotron-3-nano:30b-cloud";

/** Nemotron 3 Nano is a reasoning model — its trace is separate from content,
 * but the budget must cover the trace or the keyword never lands. */
const CLASSIFIER_MAX_TOKENS = 4096;

let enabled = true;

function pickCheapModel(available: unknown[], current: unknown): unknown {
	// 1. Explicit override via env: "provider/model-id" or bare "model-id"
	const override = process.env.PI_AUTO_THINKING_MODEL;
	if (override) {
		const [maybeProvider, maybeId] = override.includes("/")
			? [override.split("/")[0], override.slice(override.indexOf("/") + 1)]
			: [undefined, override];
		const hit = available.find(
			(m: any) =>
				(maybeProvider === undefined || m.provider === maybeProvider) &&
				(m.id === maybeId || `${m.provider}/${m.id}` === override),
		);
		if (hit) return hit;
	}

	// 2. Built-in default: Nemotron 3 Nano via Ollama Cloud
	const defaultHit = available.find(
		(m: any) => `${m.provider}/${m.id}` === DEFAULT_CLASSIFIER_MODEL || m.id === DEFAULT_CLASSIFIER_MODEL,
	);
	if (defaultHit) return defaultHit;

	// 3. Heuristic: cheapest-sounding model that isn't the current one
	for (const hint of CHEAP_MODEL_HINTS) {
		const hit = available.find((m: any) => (m.id as string).toLowerCase().includes(hint));
		if (hit) return hit;
	}

	// 4. Fall back to the session model
	return current;
}

async function classify(
	promptText: string,
	ctx: any,
): Promise<Level | undefined> {
	const registry = ctx.modelRegistry;
	const available = registry.getAvailable() ?? [];
	const model = pickCheapModel(available, ctx.model);
	if (!model) return undefined;

	const response = await registry.complete(
		model,
		{
			systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					content: `Classify this prompt:\n\n${promptText.slice(0, 4000)}`,
					timestamp: Date.now(),
				},
			],
		},
		{ maxTokens: CLASSIFIER_MAX_TOKENS, signal: ctx.signal, cacheRetention: "none" },
	);

	if (response.stopReason === "error" || response.stopReason === "aborted") {
		return undefined;
	}

	const text = response.content
		.filter((c: any) => c.type === "text")
		.map((c: any) => c.text)
		.join(" ")
		.toLowerCase();

	// Earliest match wins; xhigh probed before high (regex collision)
	const xhigh = text.search(/x[\s_-]?high/);
	if (xhigh >= 0) return "xhigh";
	const high = text.search(/\bhigh\b/);
	if (high >= 0) return "high";
	const medium = text.search(/\bmed(?:ium)?\b/);
	if (medium >= 0) return "medium";
	const low = text.search(/\blow\b/);
	if (low >= 0) return "low";
	return undefined;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("autothink", {
		description: "Toggle auto thinking level (on/off) or force a level",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();
			if (arg === "off" || arg === "on") {
				enabled = arg === "on";
				ctx.ui.notify(`Auto-thinking ${enabled ? "enabled" : "disabled"}`, "info");
				return;
			}
			enabled = !enabled;
			ctx.ui.notify(`Auto-thinking ${enabled ? "enabled" : "disabled"}`, "info");
			if (!enabled) ctx.ui.setStatus("auto-think", "");
		},
		});

		// Keep the label truthful whenever the level changes (classifier, /model,
		// keybinding, session restore) — clear it when auto is disabled.
		pi.on("thinking_level_select", async (event, ctx) => {
			if (!enabled) return;
			ctx.ui.setStatus("auto-think", `auto: ${event.level}`);
		});

		pi.on("before_agent_start", async (event, ctx) => {
		if (!enabled) return;
		if (!ctx.model?.reasoning) return;

		const promptText = event.prompt?.trim() ?? "";
		// Trivial prompts skip the classifier call entirely (mirrors omp's Low floor)
		if (promptText.split(/\s+/).length < 6) {
			pi.setThinkingLevel("low");
			ctx.ui.setStatus("auto-think", "auto: low (short prompt)");
			return;
		}

		ctx.ui.setStatus("auto-think", "auto: classifying…");
		try {
			const level = await classify(promptText, ctx);
			if (level) {
				pi.setThinkingLevel(level);
				ctx.ui.setStatus("auto-think", `auto: ${level}`);
			}
			// On undefined (classifier failed) keep the current level — never break the turn
		} catch {
			// keep current level
		}
	});
}