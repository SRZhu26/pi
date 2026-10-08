# Middlemanager Experiments

This experiment matrix separates optimization tasks from general goal tasks. The built-in cohort contains vanilla Pi, full Middlemanager, and one leave-one-feature-out arm for each of the seven capabilities. `pi-autoresearch` is only assigned to optimization tasks; `pi-goal-x` is only assigned to goal tasks.

## Freeze A Task Set

Copy `tasks.template.json` to a versioned task file and replace every placeholder. Each task needs a stable ID, a frozen prompt, acceptance criteria, and a task-specific evaluation. Optimization tasks must specify a deterministic benchmark command, baseline, target, direction, and unit. Goal tasks must include a rubric suitable for blinded scoring. Do not compare optimization and goal results as one headline.

Record the starting Pi commit, coding model, classifier model, comparator commit SHAs, benchmark environment, and task-set hash with every run. The external comparators in `arms.json` are pinned to full commit SHAs; update those pins deliberately when selecting a new comparator revision.

## Feature Environment

The Middlemanager extension reads `PI_MIDDLEMANAGER_*` defaults so arms can independently enable or disable features. A CLI presence flag may turn a boolean on, so ablation launchers should use these environment variables rather than `--flag=false`. The protocol planner emits these settings for each Middlemanager arm.

## Generate A Protocol

After freezing a task file, generate the randomized plan from the repository root:

```powershell
$env:PI_MIDDLEMANAGER_MODEL = "provider/classifier-model"
npm run eval:middlemanager:plan --workspace=@earendil-works/pi-evals -- `
	--tasks experiments/middlemanager/tasks-v1.json `
	--model provider/coding-model `
	--classifier-model provider/classifier-model `
	--repetitions 3 `
	--seed 20261008
```

The output defaults to `packages/evals/.eval/middlemanager/` and contains a protocol and a pending-observation manifest. A protocol is a plan, not evidence that any arm ran.

## Metrics And Execution

Randomize arm order within each `(task, repetition)` block with a recorded seed. Run every arm in a fresh worktree or isolated container from the same base commit. Keep model, tools, timeouts, and resource limits equal where the comparator permits. Count user interventions and safety blocks as outcomes, not missing data. Report acceptance-test success, blinded quality score, wall time, tool calls, coding-model tokens and cost, classifier usage and cost, and local classifier latency/hardware separately when usage is unavailable.

The plan CLI only validates the task set and writes a reproducible randomized protocol; it does not execute model tasks or grade outputs. Execution must use the isolated Pi eval harness and an explicit scorer. No experiment results should be reported until the task set, scorers, comparator revisions, and execution adapter are frozen.