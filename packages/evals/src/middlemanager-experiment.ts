export const EXPERIMENT_DOMAINS = ["optimization", "goal"] as const;
export type ExperimentDomain = (typeof EXPERIMENT_DOMAINS)[number];

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

export interface ExperimentArm {
	id: string;
	kind: "baseline" | "middlemanager" | "external";
	domains: ExperimentDomain[];
	features: MiddlemanagerFeature[];
	shadow?: boolean;
	ablates?: MiddlemanagerFeature;
	repository?: string;
	ref?: string;
}

export interface ExperimentCase {
	id: string;
	domain: ExperimentDomain;
	prompt: string;
	acceptanceCriteria: string[];
	rubric?: string;
	measurement?: {
		command: string;
		baseline: number;
		target: number;
		direction: "minimize" | "maximize";
		unit: string;
	};
}

export interface PlannedExperimentTask {
	blockId: string;
	caseId: string;
	domain: ExperimentDomain;
	armId: string;
	repetition: number;
	order: number;
}

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

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0);
}

function requireExperimentDomain(value: unknown): ExperimentDomain {
	if (value !== "optimization" && value !== "goal") {
		throw new TypeError(`Unknown experiment domain: ${String(value)}`);
	}
	return value;
}

function ablationId(feature: MiddlemanagerFeature): string {
	return `middlemanager-no-${feature.replaceAll("_", "-")}`;
}

export function parseExperimentArms(value: unknown): ExperimentArm[] {
	if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.arms)) {
		throw new TypeError("Experiment arm matrix must use schemaVersion 1 and an arms array.");
	}
	const identities = new Set<string>();
	const arms = value.arms.map((raw): ExperimentArm => {
		if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id.trim()) {
			throw new TypeError("Experiment arm requires an id.");
		}
		if (identities.has(raw.id)) throw new TypeError(`Duplicate experiment arm: ${raw.id}`);
		identities.add(raw.id);
		if (raw.kind !== "baseline" && raw.kind !== "middlemanager" && raw.kind !== "external") {
			throw new TypeError(`Unknown experiment arm kind for ${raw.id}.`);
		}
		if (!Array.isArray(raw.domains) || raw.domains.length === 0) {
			throw new TypeError(`Experiment arm ${raw.id} requires at least one domain.`);
		}
		const domains = raw.domains.map(requireExperimentDomain);
		if (new Set(domains).size !== domains.length) throw new TypeError(`Experiment arm ${raw.id} has duplicate domains.`);
		if (!Array.isArray(raw.features)) throw new TypeError(`Experiment arm ${raw.id} requires a feature list.`);
		const features = raw.features.map((feature) => {
			if (!MIDDLEMANAGER_FEATURES.includes(feature as MiddlemanagerFeature)) {
				throw new TypeError(`Unknown Middlemanager feature in ${raw.id}: ${String(feature)}`);
			}
			return feature as MiddlemanagerFeature;
		});
		if (new Set(features).size !== features.length) throw new TypeError(`Experiment arm ${raw.id} has duplicate features.`);
		if (raw.kind === "middlemanager" && typeof raw.shadow !== "boolean") {
			throw new TypeError(`Middlemanager arm ${raw.id} requires an explicit shadow setting.`);
		}
		if (raw.kind === "external" && (typeof raw.repository !== "string" || typeof raw.ref !== "string")) {
			throw new TypeError(`External arm ${raw.id} requires a repository and pinned ref.`);
		}
		return {
			id: raw.id,
			kind: raw.kind,
			domains,
			features,
			...(typeof raw.shadow === "boolean" ? { shadow: raw.shadow } : {}),
			...(typeof raw.ablates === "string" ? { ablates: raw.ablates as MiddlemanagerFeature } : {}),
			...(typeof raw.repository === "string" ? { repository: raw.repository } : {}),
			...(typeof raw.ref === "string" ? { ref: raw.ref } : {}),
		};
	});

	const byId = new Map(arms.map((arm) => [arm.id, arm]));
	const baseline = byId.get("vanilla-pi");
	const full = byId.get("middlemanager-full");
	if (baseline?.kind !== "baseline" || baseline.domains.length !== EXPERIMENT_DOMAINS.length) {
		throw new TypeError("Arm matrix must include vanilla-pi for both experiment domains.");
	}
	if (
		full?.kind !== "middlemanager" ||
		full.shadow !== false ||
		MIDDLEMANAGER_FEATURES.some((feature) => !full.features.includes(feature))
	) {
		throw new TypeError("Arm matrix must include an active middlemanager-full arm with all seven features.");
	}
	for (const feature of MIDDLEMANAGER_FEATURES) {
		const ablation = byId.get(ablationId(feature));
		if (
			ablation?.kind !== "middlemanager" ||
			ablation.shadow !== false ||
			ablation.ablates !== feature ||
			ablation.features.length !== MIDDLEMANAGER_FEATURES.length - 1 ||
			ablation.features.includes(feature) ||
			full.domains.some((domain) => !ablation.domains.includes(domain))
		) {
			throw new TypeError(`Arm matrix is missing the leave-one-out ablation for ${feature}.`);
		}
	}
	const autoresearch = byId.get("pi-autoresearch");
	const goalX = byId.get("pi-goal-x");
	if (
		autoresearch?.kind !== "external" ||
		!autoresearch.domains.includes("optimization") ||
		goalX?.kind !== "external" ||
		!goalX.domains.includes("goal")
	) {
		throw new TypeError("Arm matrix must include pi-autoresearch and pi-goal-x in their matching domains.");
	}
	return arms;
}

export function parseExperimentCases(value: unknown): ExperimentCase[] {
	if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.tasks)) {
		throw new TypeError("Experiment task file must use schemaVersion 1 and a tasks array.");
	}
	const identities = new Set<string>();
	return value.tasks.map((raw): ExperimentCase => {
		if (
			!isRecord(raw) ||
			typeof raw.id !== "string" ||
			!raw.id.trim() ||
			typeof raw.prompt !== "string" ||
			!raw.prompt.trim() ||
			!isStringArray(raw.acceptanceCriteria)
		) {
			throw new TypeError("Each experiment task requires id, prompt, and non-empty acceptanceCriteria.");
		}
		if (identities.has(raw.id)) throw new TypeError(`Duplicate experiment task: ${raw.id}`);
		identities.add(raw.id);
		const domain = requireExperimentDomain(raw.domain);
		if (domain === "optimization") {
			if (
				!isRecord(raw.measurement) ||
				typeof raw.measurement.command !== "string" ||
				!raw.measurement.command.trim() ||
				typeof raw.measurement.unit !== "string" ||
				!raw.measurement.unit.trim() ||
				!Number.isFinite(raw.measurement.baseline) ||
				!Number.isFinite(raw.measurement.target) ||
				(raw.measurement.direction !== "minimize" && raw.measurement.direction !== "maximize")
			) {
				throw new TypeError(`Optimization task ${raw.id} requires a measurable baseline, target, direction, and command.`);
			}
		} else if (typeof raw.rubric !== "string" || !raw.rubric.trim()) {
			throw new TypeError(`Goal task ${raw.id} requires a scoring rubric.`);
		}
		return {
			id: raw.id,
			domain,
			prompt: raw.prompt,
			acceptanceCriteria: raw.acceptanceCriteria,
			...(typeof raw.rubric === "string" ? { rubric: raw.rubric } : {}),
			...(isRecord(raw.measurement)
				? {
						measurement: {
							command: raw.measurement.command as string,
							baseline: raw.measurement.baseline as number,
							target: raw.measurement.target as number,
							direction: raw.measurement.direction as "minimize" | "maximize",
							unit: raw.measurement.unit as string,
						},
					}
				: {}),
		};
	});
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
	if (!Number.isSafeInteger(repetitions) || repetitions < 1) throw new TypeError("Repetitions must be a positive integer.");
	if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
		throw new TypeError("Seed must be an integer between 0 and 4294967295.");
	}
	const uniqueCaseIds = new Set(cases.map((experimentCase) => experimentCase.id));
	if (uniqueCaseIds.size !== cases.length) throw new TypeError("Experiment task ids must be unique.");
	let state = seed >>> 0;
	const random = () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state / 0x1_0000_0000;
	};
	const tasks: PlannedExperimentTask[] = [];
	const orderedCases = [...cases].sort((left, right) => left.domain.localeCompare(right.domain) || left.id.localeCompare(right.id));
	for (const experimentCase of orderedCases) {
		const eligibleArms = arms.filter((arm) => arm.domains.includes(experimentCase.domain));
		if (!eligibleArms.some((arm) => arm.id === "vanilla-pi") || !eligibleArms.some((arm) => arm.id === "middlemanager-full")) {
			throw new TypeError(`Task ${experimentCase.id} lacks a matched vanilla/full Middlemanager control.`);
		}
		for (let repetition = 1; repetition <= repetitions; repetition += 1) {
			const randomizedArms = [...eligibleArms];
			for (let index = randomizedArms.length - 1; index > 0; index -= 1) {
				const swapIndex = Math.floor(random() * (index + 1));
				[randomizedArms[index], randomizedArms[swapIndex]] = [randomizedArms[swapIndex], randomizedArms[index]];
			}
			const blockId = `${experimentCase.id}#${repetition}`;
			for (const [order, arm] of randomizedArms.entries()) {
				tasks.push({ blockId, caseId: experimentCase.id, domain: experimentCase.domain, armId: arm.id, repetition, order });
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