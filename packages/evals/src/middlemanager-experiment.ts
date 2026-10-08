export const MIDDLEMANAGER_FEATURES = [
	"task_difficulty",
	"memory_selection",
	"bash_guardrails",
	"edit_alignment",
	"goal_adherence",
	"bounded_autopilot",
	"visual_review",
] as const;
export type MiddlemanagerFeature = (typeof MIDDLEMANAGER_FEATURES)[number];

export const SWE_BENCH_LITE_SOURCE = {
	id: "swe-bench-lite",
	dataset: "princeton-nlp/SWE-bench_Lite",
	revision: "6ec7bb89b9342f664a54a6e0a6ea6501d3437cc2",
	config: "default",
	split: "test",
	expectedInstances: 300,
} as const;

export const SWE_BENCH_AGENT_MODEL = {
	provider: "openai",
	id: "Qwen3.8-Flash-Next-FP8",
	name: "Qwen3.8-Flash-Next-FP8",
	api: "openai-completions",
	baseUrl: "http://172.16.125.60:30000/v1",
	contextWindow: 262_144,
	maxTokens: 32_768,
	samplingParams: { temperature: 1 },
	maxConcurrentRuns: 1,
	noProxyHost: "172.16.125.60",
} as const;

export const SWE_BENCH_CLASSIFIER_MODEL = {
	provider: "llama.cpp",
	id: "LiquidAI/d1-omni-600M-GGUF:Q8_0",
	baseUrl: "http://127.0.0.1:8080",
	noProxyHost: "127.0.0.1",
} as const;

export interface ExperimentArm {
	id: string;
	kind: "baseline" | "middlemanager";
	features: MiddlemanagerFeature[];
	shadow?: boolean;
}

export interface ExperimentCase {
	instanceId: string;
	repo: string;
	baseCommit: string;
	prompt: string;
	version: string;
	environmentSetupCommit?: string;
}

export interface SweBenchLiteTaskSet {
	schemaVersion: 1;
	benchmark: typeof SWE_BENCH_LITE_SOURCE;
	tasks: ExperimentCase[];
}

export interface PlannedExperimentTask {
	blockId: string;
	instanceId: string;
	armId: string;
	repetition: number;
	order: number;
}

export const MIDDLEMANAGER_EXTENSION_PATH = "packages/coding-agent/examples/extensions/middlemanager/index.ts";

const FEATURE_ENVIRONMENT: Record<MiddlemanagerFeature, string> = {
	task_difficulty: "PI_MIDDLEMANAGER_TASK_DIFFICULTY",
	memory_selection: "PI_MIDDLEMANAGER_MEMORY",
	bash_guardrails: "PI_MIDDLEMANAGER_BASH_GUARDRAILS",
	edit_alignment: "PI_MIDDLEMANAGER_EDIT_ALIGNMENT",
	goal_adherence: "PI_MIDDLEMANAGER_GOAL_ADHERENCE",
	bounded_autopilot: "PI_MIDDLEMANAGER_AUTOPILOT",
	visual_review: "PI_MIDDLEMANAGER_VISUAL_REVIEW",
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string, taskId: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new TypeError(`SWE-bench Lite task ${taskId} requires ${field}.`);
	}
	return value;
}

export function parseExperimentArms(value: unknown): ExperimentArm[] {
	if (!isRecord(value) || value.schemaVersion !== 2 || !Array.isArray(value.arms)) {
		throw new TypeError("Experiment arm matrix must use schemaVersion 2 and an arms array.");
	}
	const benchmark = value.benchmark;
	if (
		!isRecord(benchmark) ||
		benchmark.id !== SWE_BENCH_LITE_SOURCE.id ||
		benchmark.dataset !== SWE_BENCH_LITE_SOURCE.dataset ||
		benchmark.revision !== SWE_BENCH_LITE_SOURCE.revision ||
		benchmark.config !== SWE_BENCH_LITE_SOURCE.config ||
		benchmark.split !== SWE_BENCH_LITE_SOURCE.split ||
		benchmark.expectedInstances !== SWE_BENCH_LITE_SOURCE.expectedInstances
	) {
		throw new TypeError("Experiment arm matrix must target the pinned SWE-bench Lite test split.");
	}
	const identities = new Set<string>();
	const arms = value.arms.map((raw): ExperimentArm => {
		if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id.trim()) {
			throw new TypeError("Experiment arm requires an id.");
		}
		if (identities.has(raw.id)) throw new TypeError(`Duplicate experiment arm: ${raw.id}`);
		identities.add(raw.id);
		if (raw.kind !== "baseline" && raw.kind !== "middlemanager") {
			throw new TypeError(`Unknown experiment arm kind for ${raw.id}.`);
		}
		if (!Array.isArray(raw.features)) throw new TypeError(`Experiment arm ${raw.id} requires a feature list.`);
		const features = raw.features.map((feature) => {
			if (!MIDDLEMANAGER_FEATURES.includes(feature as MiddlemanagerFeature)) {
				throw new TypeError(`Unknown Middlemanager feature in ${raw.id}: ${String(feature)}`);
			}
			return feature as MiddlemanagerFeature;
		});
		if (new Set(features).size !== features.length)
			throw new TypeError(`Experiment arm ${raw.id} has duplicate features.`);
		if (raw.kind === "middlemanager" && typeof raw.shadow !== "boolean") {
			throw new TypeError(`Middlemanager arm ${raw.id} requires an explicit shadow setting.`);
		}
		return {
			id: raw.id,
			kind: raw.kind,
			features,
			...(typeof raw.shadow === "boolean" ? { shadow: raw.shadow } : {}),
		};
	});

	const byId = new Map(arms.map((arm) => [arm.id, arm]));
	const baseline = byId.get("pi-no-extensions");
	const full = byId.get("middlemanager-full");
	if (
		arms.length !== MIDDLEMANAGER_FEATURES.length + 2 ||
		baseline?.kind !== "baseline" ||
		baseline.features.length !== 0
	) {
		throw new TypeError("Arm matrix must include raw Pi, seven single-feature arms, and full Middlemanager.");
	}
	if (
		full?.kind !== "middlemanager" ||
		full.shadow !== false ||
		MIDDLEMANAGER_FEATURES.some((feature) => !full.features.includes(feature))
	) {
		throw new TypeError("Arm matrix must include an active middlemanager-full arm with all seven features.");
	}
	for (const feature of MIDDLEMANAGER_FEATURES) {
		const featureId = `middlemanager-add-${feature.replaceAll("_", "-")}`;
		const singleFeatureArm = byId.get(featureId);
		if (
			singleFeatureArm?.kind !== "middlemanager" ||
			singleFeatureArm.shadow !== false ||
			singleFeatureArm.features.length !== 1 ||
			singleFeatureArm.features[0] !== feature
		) {
			throw new TypeError(`Arm matrix is missing the one-feature arm for ${feature}.`);
		}
	}
	return arms;
}

export function createSweBenchLiteTaskSet(rows: readonly unknown[], totalRows: number): SweBenchLiteTaskSet {
	if (totalRows !== SWE_BENCH_LITE_SOURCE.expectedInstances || rows.length !== totalRows) {
		throw new TypeError(
			`Pinned SWE-bench Lite split must contain exactly ${SWE_BENCH_LITE_SOURCE.expectedInstances} rows.`,
		);
	}
	const tasks = rows.map((raw): ExperimentCase => {
		if (!isRecord(raw)) throw new TypeError("SWE-bench Lite row must be an object.");
		const instanceId = requiredString(raw.instance_id, "instance_id", "<unknown>");
		const repo = requiredString(raw.repo, "repo", instanceId);
		const baseCommit = requiredString(raw.base_commit, "base_commit", instanceId);
		const prompt = requiredString(raw.problem_statement, "problem_statement", instanceId);
		const version = requiredString(raw.version, "version", instanceId);
		const environmentSetupCommit =
			typeof raw.environment_setup_commit === "string" && raw.environment_setup_commit.trim()
				? raw.environment_setup_commit
				: undefined;
		if (!/^[a-f0-9]{40}$/i.test(baseCommit)) {
			throw new TypeError(`SWE-bench Lite task ${instanceId} has an invalid base commit.`);
		}
		if (environmentSetupCommit && !/^[a-f0-9]{40}$/i.test(environmentSetupCommit)) {
			throw new TypeError(`SWE-bench Lite task ${instanceId} has an invalid environment setup commit.`);
		}
		if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
			throw new TypeError(`SWE-bench Lite task ${instanceId} has an invalid repository.`);
		}
		return {
			instanceId,
			repo,
			baseCommit,
			prompt,
			version,
			...(environmentSetupCommit ? { environmentSetupCommit } : {}),
		};
	});
	if (new Set(tasks.map((task) => task.instanceId)).size !== tasks.length) {
		throw new TypeError("SWE-bench Lite instance ids must be unique.");
	}
	return { schemaVersion: 1, benchmark: SWE_BENCH_LITE_SOURCE, tasks };
}

export function parseSweBenchLiteTaskSet(value: unknown): SweBenchLiteTaskSet {
	if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.benchmark) || !Array.isArray(value.tasks)) {
		throw new TypeError("Task file must be a sanitized SWE-bench Lite task set.");
	}
	if (
		Object.keys(SWE_BENCH_LITE_SOURCE).some(
			(key) => value.benchmark[key] !== SWE_BENCH_LITE_SOURCE[key as keyof typeof SWE_BENCH_LITE_SOURCE],
		)
	) {
		throw new TypeError("Task file does not match the pinned SWE-bench Lite dataset revision and test split.");
	}
	if (value.tasks.length !== SWE_BENCH_LITE_SOURCE.expectedInstances) {
		throw new TypeError(
			`SWE-bench Lite task file must contain exactly ${SWE_BENCH_LITE_SOURCE.expectedInstances} tasks.`,
		);
	}
	const tasks = value.tasks.map((raw): ExperimentCase => {
		if (!isRecord(raw)) throw new TypeError("SWE-bench Lite task must be an object.");
		const instanceId = requiredString(raw.instanceId, "instanceId", "<unknown>");
		if (["patch", "test_patch", "FAIL_TO_PASS", "PASS_TO_PASS", "hints_text"].some((key) => key in raw)) {
			throw new TypeError(`SWE-bench Lite task ${instanceId} contains hidden evaluation data.`);
		}
		return {
			instanceId,
			repo: requiredString(raw.repo, "repo", instanceId),
			baseCommit: requiredString(raw.baseCommit, "baseCommit", instanceId),
			prompt: requiredString(raw.prompt, "prompt", instanceId),
			version: requiredString(raw.version, "version", instanceId),
			...(typeof raw.environmentSetupCommit === "string"
				? {
						environmentSetupCommit: requiredString(
							raw.environmentSetupCommit,
							"environmentSetupCommit",
							instanceId,
						),
					}
				: {}),
		};
	});
	if (new Set(tasks.map((task) => task.instanceId)).size !== tasks.length) {
		throw new TypeError("SWE-bench Lite instance ids must be unique.");
	}
	return { schemaVersion: 1, benchmark: SWE_BENCH_LITE_SOURCE, tasks };
}

export function parseModelIdentity(value: string): string {
	const model = value.trim();
	if (!model.includes("/") || model.startsWith("/") || model.endsWith("/")) {
		throw new TypeError("Model identity must contain both provider and model id.");
	}
	return model;
}

export function createMultiArmTaskPlan(
	cases: readonly ExperimentCase[],
	arms: readonly ExperimentArm[],
	repetitions: number,
	seed: number,
): PlannedExperimentTask[] {
	if (cases.length === 0) throw new TypeError("At least one experiment task is required.");
	if (!Number.isSafeInteger(repetitions) || repetitions < 1)
		throw new TypeError("Repetitions must be a positive integer.");
	if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
		throw new TypeError("Seed must be an integer between 0 and 4294967295.");
	}
	const uniqueInstanceIds = new Set(cases.map((experimentCase) => experimentCase.instanceId));
	if (uniqueInstanceIds.size !== cases.length) throw new TypeError("Experiment task ids must be unique.");
	let state = seed >>> 0;
	const random = () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state / 0x1_0000_0000;
	};
	const tasks: PlannedExperimentTask[] = [];
	const orderedCases = [...cases].sort((left, right) => left.instanceId.localeCompare(right.instanceId));
	for (const experimentCase of orderedCases) {
		for (let repetition = 1; repetition <= repetitions; repetition += 1) {
			const randomizedArms = [...arms];
			for (let index = randomizedArms.length - 1; index > 0; index -= 1) {
				const swapIndex = Math.floor(random() * (index + 1));
				[randomizedArms[index], randomizedArms[swapIndex]] = [randomizedArms[swapIndex], randomizedArms[index]];
			}
			const blockId = `${experimentCase.instanceId}#${repetition}`;
			for (const [order, arm] of randomizedArms.entries()) {
				tasks.push({
					blockId,
					instanceId: experimentCase.instanceId,
					armId: arm.id,
					repetition,
					order,
				});
			}
		}
	}
	return tasks;
}

export function createArmEnvironment(arm: ExperimentArm, classifierModel: string): Record<string, string> {
	const environment: Record<string, string> = { PI_EXPERIMENT_ARM: arm.id };
	if (arm.kind !== "middlemanager") return environment;
	const classifier = parseModelIdentity(classifierModel);
	environment.PI_MIDDLEMANAGER_MODEL = classifier;
	environment.PI_MIDDLEMANAGER_SHADOW = String(arm.shadow);
	for (const feature of MIDDLEMANAGER_FEATURES) {
		const variable = FEATURE_ENVIRONMENT[feature];
		environment[variable] = String(arm.features.includes(feature));
	}
	environment.PI_MIDDLEMANAGER_VISUAL_REVIEW = arm.features.includes("visual_review") ? "auto" : "off";
	return environment;
}

export function createArmLaunchConfig(arm: ExperimentArm, classifierModel: string) {
	return {
		args: [
			"--no-extensions",
			...(arm.kind === "middlemanager"
				? ["--extension", "builtin:llama.cpp", "--extension", MIDDLEMANAGER_EXTENSION_PATH]
				: []),
		],
		environment: createArmEnvironment(arm, classifierModel),
	};
}
