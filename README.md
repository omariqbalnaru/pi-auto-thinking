# pi-auto-thinking

Auto thinking level for [pi](https://github.com/earendil-works/pi-coding-agent) — a cheap
side-model classifies each prompt's coding difficulty and sets the reasoning effort
per turn. Replicates [oh-my-pi](https://github.com/can1357/oh-my-pi)'s `auto` thinking
mode for pi.

## How it works

1. On every user prompt, a `before_agent_start` hook sends the prompt to a cheap
   classifier model, which replies with exactly one word:
   `low` | `medium` | `high` | `xhigh`.
2. The classified level is applied with `pi.setThinkingLevel()` for that turn
   (mapped to reasoning budgets: low ≈ 2k, medium ≈ 8k, high ≈ 16k, xhigh ≈ 32k tokens).
3. The level shows in pi's footer — next to the model name natively, plus an
   `auto: <level>` status label from this extension.

Hard rules (mirroring omp):

- Trivial prompts (< 6 words) skip the classifier and pin `low` directly — no API call.
- `auto` never resolves above `xhigh`; `max` is reserved for explicit requests.
- A failed classification never breaks the turn — the current level is kept.
- The classifier runs per turn, so difficulty is judged fresh each time.

## Install

```bash
pi install git:github.com/omariqbalnaru/pi-auto-thinking
```

Or with a pinned ref:

```bash
pi install git:github.com/omariqbalnaru/pi-auto-thinking@v1.0.0
```

## Classifier model

By default the classifier is **Nemotron 3 Nano via Ollama Cloud** (`ollama/nemotron-3-nano:30b-cloud`),
routed through a local Ollama daemon proxying to ollama.com. For that default to resolve,
register the provider in `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "ollama": {
      "api": "openai-completions",
      "apiKey": "ollama",
      "baseUrl": "http://127.0.0.1:11434/v1",
      "compat": { "supportsDeveloperRole": false },
      "models": [{ "id": "nemotron-3-nano:30b-cloud" }]
    }
  }
}
```

Or point the extension at any other cheap model with an env var before starting pi:

```bash
export PI_AUTO_THINKING_MODEL="google/gemini-2.5-flash"   # or "provider/model-id"
```

Resolution order: env override → Nemotron 3 Nano via Ollama Cloud → cheapest
sounding model in your catalogue (flash/haiku/mini/nano/…) → the session's model.

Nemotron 3 Nano is a reasoning model; the extension budgets 4096 output tokens so
its reasoning trace never crowds out the classification keyword, and parses the
`content` (not the trace) for the level keyword.

## Usage

- `/autothink` — toggle auto mode on/off (also accepts `on` / `off`)
- The footer shows `auto: classifying…` while checking, then `auto: <level>`
- Manual level changes (keybindings, `/model`) keep the label in sync via the
  `thinking_level_select` event

## Requirements

- The session model must support reasoning (`model.reasoning`); otherwise the
  extension stays out of the way.
- A reachable classifier model (Ollama Cloud + signed-in local Ollama daemon for
  the default, or any provider model via the env override).

## License

MIT