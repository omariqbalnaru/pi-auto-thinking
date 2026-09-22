/**
 * auto-thinking — replicate oh-my-pi's `auto` thinking level in pi.
 *
 * On every user prompt, a cheap side-model classifies the prompt's coding
 * difficulty into low|medium|high|xhigh, then pi.setThinkingLevel() applies
 * it before the agent loop starts.
 *
 * Classifier model resolution (first match wins):
 *   1. $PI_AUTO_THINKING_MODEL  (format: "provider/model-id" or bare "model-id"; unset
 *      here on purpose — the classifier model is machine-specific, so it must be
 *      pinned per environment to an id registered in the local model registry)
 *   2. Heuristic: cheapest/smallest model in the catalogue (flash/haiku/mini...)
 *   3. The session's current model
 *
 * Toggle with /autothink on|off. On classification failure the current
 * thinking level is left untouched (never breaks the turn).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Level = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const CLASSIFIER_SYSTEM_PROMPT = `You are a routing classifier for a coding agent. Given a user prompt, rate the coding difficulty it requires and reply with EXACTLY ONE word:
- low: pure Q&A — "what does this do", "explain X", "which file handles Y". Reading only, zero code changes
- medium: ANY code change not clearly hard — small features, bug fixes, renames, single or multi-file edits
- high: tricky debugging, architecture changes, performance work, multi-step refactors, subtle logic, anything touching concurrency or data consistency
- xhigh: deep debugging of unknown causes, algorithmically complex work, large cross-cutting redesigns, concurrency-heavy changes

When unsure between two levels, pick the HIGHER one.

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

/** Nemotron 3 Nano is a reasoning model — its trace is separate from content,
 * but the budget must cover the trace or the keyword never lands. */
const CLASSIFIER_MAX_TOKENS = 4096;

/** Classifier latency ceiling — abort and fall back rather than delay turn start. */
const CLASSIFIER_TIMEOUT_MS = 4000;

/** Pasted code/errors swamp the classifier's window and skew the verdict toward
 * low (it judges the dump, not the ask). Fenced blocks are the dominant form. */
function preprocessPrompt(text: string): string {
	return text.replace(/```[\s\S]*?```/g, " [code block] ").slice(0, 4000);
}

let enabled = true;
/** Last successful classification — sticky fallback when the classifier fails. */
let lastResolved: Level | undefined;

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

	// 2. Heuristic: cheapest-sounding model that isn't the current one
	for (const hint of CHEAP_MODEL_HINTS) {
		const hit = available.find((m: any) => (m.id as string).toLowerCase().includes(hint));
		if (hit) return hit;
	}

	// 3. Fall back to the session model
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
				content: `Classify this prompt:\n\n${preprocessPrompt(promptText)}`,
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
		// Trivial prompts skip the classifier call entirely; medium floor so terse
		// hard prompts ("fix deadlock in plan refresh") still get thinking budget
		if (promptText.split(/\s+/).length < 6) {
			pi.setThinkingLevel("medium");
			ctx.ui.setStatus("auto-think", "auto: medium (short prompt)");
			return;
		}

		ctx.ui.setStatus("auto-think", "auto: classifying…");
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const timeout = new Promise<undefined>((resolve) => {
				timer = setTimeout(() => resolve(undefined), CLASSIFIER_TIMEOUT_MS);
			});
			const level = await Promise.race([classify(promptText, ctx), timeout]);
			const resolved = level ?? lastResolved ?? "medium";
			if (level) lastResolved = level;
			pi.setThinkingLevel(resolved);
			ctx.ui.setStatus(
				"auto-think",
				level ? `auto: ${resolved}` : `auto: ${resolved} (classifier failed)`,
			);
		} catch {
			const resolved = lastResolved ?? "medium";
			pi.setThinkingLevel(resolved);
			ctx.ui.setStatus("auto-think", `auto: ${resolved} (classifier failed)`);
		} finally {
			clearTimeout(timer);
		}
	});
}