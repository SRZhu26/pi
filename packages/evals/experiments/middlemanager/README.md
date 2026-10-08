# Middlemanager SWE-bench Lite Experiments

The experiment uses the pinned `princeton-nlp/SWE-bench_Lite` dataset revision `6ec7bb89b9342f664a54a6e0a6ea6501d3437cc2`, configuration `default`, test split (300 instances). The primary score is the official SWE-bench `resolved` result, not a text judge.

## Arms

There are nine paired arms for every issue:

- `pi-no-extensions`: raw Pi with extension discovery and built-in extensions disabled.
- Seven `middlemanager-add-*` arms: raw Pi plus exactly one Middlemanager feature.
- `middlemanager-full`: all seven features enabled.

Every treatment uses `--no-extensions --extension packages/coding-agent/examples/extensions/middlemanager/index.ts`; the baseline uses only `--no-extensions`. This excludes ambient/user extensions from all arms. Feature booleans come from `PI_MIDDLEMANAGER_*`, not `--flag=false` CLI arguments.

## Freeze Tasks And Plan

The downloader fetches the pinned `data/test-00000-of-00001.parquet` artifact through `hf-mirror.com`, and reads only instance ID, repository, base commit, issue text, version, and optional environment setup commit. Reference patches, hints, and hidden test lists are never decoded into the task set.

```powershell
$env:HF_ENDPOINT = "https://hf-mirror.com"
$env:HF_HUB_OFFLINE = "0"
$env:NODE_USE_ENV_PROXY = "1"
npm run eval:middlemanager:dataset --workspace=@earendil-works/pi-evals -- --output .eval/middlemanager/swebench-lite-v1.json

npm run eval:middlemanager:plan --workspace=@earendil-works/pi-evals -- `
	--tasks .eval/middlemanager/swebench-lite-v1.json `
	--repetitions 1 `
	--seed 20261008
```

The default coding and classifier model is `openai/Qwen3.8-Flash-Next-FP8` at `http://172.16.125.60:30000/v1`, with a 262,144-token context, temperature 1, 32,768 maximum output tokens, and one concurrent run. Each arm launch sets both `NO_PROXY` and `no_proxy` to include `172.16.125.60`. Override models explicitly only for a separately versioned experiment.

One repetition schedules 2,700 agent runs (300 issues × 9 arms). The planner writes a protocol and pending-observation manifest; it does not launch Pi or run the SWE-bench evaluator. Run agent requests from ReachyBot with proxy bypass for `172.16.125.60`.

## Execution And Reporting

Run every arm from the exact task base commit in a fresh isolated SWE-bench environment. Keep the coding model, classifier, tool set, budgets, and environment image fixed. Randomize arm order within each issue/repetition block. Collect final patches and score them with the official SWE-bench harness at the pinned dataset revision. Report resolved rate and paired per-issue outcomes; also record wall time, model tokens/cost, classifier calls/latency/cost, tool calls, safety blocks, and feature invocation counts.

SWE-bench Lite has no images, so `middlemanager-add-visual-review` is a no-image negative control and visual review is not exercised in the full arm. Bounded autopilot only has an effect if Pi calls `middlemanager_choose`; memory selection only acts when matching repository memory files are preloaded. Report these exposure counts and do not attribute a score change to a feature that did not activate.