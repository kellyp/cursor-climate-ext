# AI Climate Impact

Estimates and displays the CO₂ impact of your AI prompts in the status bar.

## Installation

1. **Install the extension** — From a built `.vsix`: run `npm run build`, then in Cursor use **Extensions** → **⋯** → **Install from VSIX…** and select the generated `.vsix` file. (Or install from the marketplace if published.)
2. **Hooks** — The extension installs the Cursor hook automatically on first activation. It writes `~/.cursor/hooks/climate.py` and registers it in `~/.cursor/hooks.json` for prompt-related events.  
   To install or refresh the hook manually: run the command **AI Climate: Install/Update Hooks**, then **restart Cursor** so the new hook is loaded.
3. **Requirement** — The hook runs as `python3 ./hooks/climate.py`; ensure Python 3 is on your PATH.

## How it works

On activation, the extension installs a Cursor hook (`~/.cursor/hooks/climate.py`) that runs on every prompt. The hook estimates token count, energy consumption, and carbon emissions based on the model being used, then writes to a cumulative log. The extension watches this log and updates the status bar in real time.

**Tokens and estimation** — Tokens are approximated as **character count ÷ 3.8** (no real tokenizer). Input = base context (from last compaction or default 5K) + prompt + attachments + files read for context; output = min(2× that new input, 8K). Total tokens × model Wh/1K (see table below) → energy (Wh); energy × 390 gCO₂/kWh → emissions. All figures are estimates; actual usage depends on hardware and provider.

## Status bar

The bottom-right status bar shows a running total:

```
🌐 10.5 gCO₂ · ~5.0K tokens · 8 reqs
```

Click it for a detailed breakdown with real-world equivalences (distance driven, phone charges, LED light minutes).

Color thresholds:
- **Default** — under 10 gCO₂
- **Yellow** — 10–100 gCO₂
- **Red** — over 100 gCO₂

## Commands

- **AI Climate: Show Impact Details** — detailed breakdown popup
- **AI Climate: Reset Stats** — zero out cumulative counters
- **AI Climate: Install/Update Hooks** — reinstall the hook script

## Energy model

Per 1,000 tokens (input + output):

| Model tier | Wh / 1K tokens |
|---|---|
| Opus-class | 0.0060 |
| GPT-4/5-class | 0.0055 |
| Sonnet-class | 0.0030 |
| Haiku-class | 0.0010 |

Carbon intensity: 390 gCO₂/kWh (US average; cloud providers may be lower with renewables).

## References

- **Energy / CO₂:** Luccioni et al. 2023; IEA 2024; Strubell et al. 2019 (token/energy estimates).
- **Water (when enabled):** Li, P., Yang, J., Islam, M. A., Ren, S. — “Making AI Less ‘Thirsty’: Uncovering and Addressing the Secret Water Footprint of AI Models.” arXiv:2304.03271 (2023; rev. 2025). [arXiv](https://arxiv.org/abs/2304.03271). ChatGPT water footprint (per-query estimates by location): [research](https://jhviw.github.io/chatgpt-water-footprint/research.html). Data center water use variation: *Resources, Conservation & Recycling* (2025), e.g. [Colab](https://colab.ws/articles/10.1016%2Fj.resconrec.2025.108310).

## Data

- `~/.cursor/hooks/climate-logs/impact.jsonl` — per-request log
- `~/.cursor/hooks/climate-logs/cumulative.json` — running totals
