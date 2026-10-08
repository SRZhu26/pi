import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
	createMultiArmTaskPlan,
	parseExperimentArms,
	parseModelIdentity,
	type ExperimentArm,
	type ExperimentCase,
	type PlannedExperimentTask,
	SWE_BENCH_LITE_SOURCE,
} from "./middlemanager-experiment.ts";

export type MiddlemanagerObservationStatus = "pending" | "running" | "completed" | "blocked" | "errored";

export type MiddlemanagerObservation = PlannedExperimentTask & {
	status: MiddlemanagerObservationStatus;
	metrics: Record<string, unknown>;
	artifacts?: Record<string, string>;
	error?: string;
};

export type MiddlemanagerProtocol = {
	schemaVersion: 2;
	kind: "middlemanager-swebench-lite-ablation-protocol";
	createdAt: string;
	piCommit: string;
	benchmark: typeof SWE_BENCH_LITE_SOURCE;
	model: string;
	classifierModel: string;
	modelConfiguration: Record<string, unknown>;
	repetitions: number;
	seed: number;
	maxConcurrentRuns: number;
	noProxyHosts: string[];
	inputFiles: { tasks: string; arms: string };
	inputHashes: { tasks: string; arms: string };
	cases: ExperimentCase[];
	arms: ExperimentArm[];
	launchConfigByArm: Record<string, { args: string[]; environment: Record<string, string> }>;
	execution: {
		primaryMetric: string;
		evaluator: string;
		pairedBy: string;
		plannedRuns: number;
	};
	tasks: PlannedExperimentTask[];
	expectedObservations: MiddlemanagerObservation[];
	metrics: string[];
	protocolDigest: string;
};

export type MiddlemanagerObservationLedger = {
	schemaVersion: 1;
	kind: "middlemanager-swebench-lite-observations";
	protocolDigest: string;
	observations: MiddlemanagerObservation[];
};

export type MiddlemanagerRunExecutor = (
	task: PlannedExperimentTask,
	protocol: MiddlemanagerProtocol,
) => Promise<MiddlemanagerObservation>;

export type MiddlemanagerRunOptions = {
	maxRuns?: number;
	onObservation?: (observation: MiddlemanagerObservation) => void | Promise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field} must be a non-empty string.`);
	return value;
}

function requiredPositiveInteger(value: unknown, field: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) {
		throw new TypeError(`${field} must be a positive integer.`);
	}
	return value as number;
}

function hashProtocolBody(protocol: Record<string, unknown>): string {
	const { protocolDigest: _protocolDigest, ...body } = protocol;
	return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

function validateCase(value: unknown): ExperimentCase {
	if (!isRecord(value)) throw new TypeError("Protocol case must be an object.");
	const instanceId = requiredString(value.instanceId, "case.instanceId");
	const repo = requiredString(value.repo, `case ${instanceId}.repo`);
	const baseCommit = requiredString(value.baseCommit, `case ${instanceId}.baseCommit`);
	const prompt = requiredString(value.prompt, `case ${instanceId}.prompt`);
	const version = requiredString(value.version, `case ${instanceId}.version`);
	if (!/^[a-f0-9]{40}$/i.test(baseCommit)) throw new TypeError(`case ${instanceId}.baseCommit is invalid.`);
	if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new TypeError(`case ${instanceId}.repo is invalid.`);
	const environmentSetupCommit = value.environmentSetupCommit;
	if (environmentSetupCommit !== undefined) {
		requiredString(environmentSetupCommit, `case ${instanceId}.environmentSetupCommit`);
		if (!/^[a-f0-9]{40}$/i.test(environmentSetupCommit as string)) {
			throw new TypeError(`case ${instanceId}.environmentSetupCommit is invalid.`);
		}
	}
	return {
		instanceId,
		repo,
		baseCommit,
		prompt,
		version,
		...(environmentSetupCommit === undefined ? {} : { environmentSetupCommit: environmentSetupCommit as string }),
	};
}

function validatePlannedTask(value: unknown): PlannedExperimentTask {
	if (!isRecord(value)) throw new TypeError("Protocol task must be an object.");
	const order = value.order;
	if (!Number.isSafeInteger(order) || (order as number) < 0) throw new TypeError("task.order must be a non-negative integer.");
	return {
		blockId: requiredString(value.blockId, "task.blockId"),
		instanceId: requiredString(value.instanceId, "task.instanceId"),
		armId: requiredString(value.armId, "task.armId"),
		repetition: requiredPositiveInteger(value.repetition, "task.repetition"),
		order: order as number,
	};
}

function observationKey(observation: Pick<PlannedExperimentTask, "instanceId" | "armId" | "repetition">): string {
	return JSON.stringify([observation.instanceId, observation.armId, observation.repetition]);
}

function validateObservation(value: unknown): MiddlemanagerObservation {
	if (!isRecord(value)) throw new TypeError("Observation must be an object.");
	const task = validatePlannedTask(value);
	const status = value.status;
	if (status !== "pending" && status !== "running" && status !== "completed" && status !== "blocked" && status !== "errored") {
		throw new TypeError(`Unknown observation status: ${String(status)}`);
	}
	if (!isRecord(value.metrics)) throw new TypeError("Observation metrics must be an object.");
	return {
		...task,
		status,
		metrics: value.metrics,
		...(isRecord(value.artifacts)
			? {
					artifacts: Object.fromEntries(
						Object.entries(value.artifacts).map(([key, item]) => [key, requiredString(item, `artifact ${key}`)]),
					),
				}
			: {}),
		...(value.error === undefined ? {} : { error: requiredString(value.error, "observation.error") }),
	};
}

function assertUniqueTasks(tasks: readonly PlannedExperimentTask[], label: string): void {
	const keys = new Set<string>();
	for (const task of tasks) {
		const key = observationKey(task);
		if (keys.has(key)) throw new TypeError(`${label} contains duplicate run ${key}.`);
		keys.add(key);
	}
}

export function parseMiddlemanagerProtocol(value: unknown): MiddlemanagerProtocol {
	if (!isRecord(value)) throw new TypeError("Middlemanager protocol must be an object.");
	if (value.schemaVersion !== 2 || value.kind !== "middlemanager-swebench-lite-ablation-protocol") {
		throw new TypeError("Unsupported Middlemanager protocol schema.");
	}
	const protocolDigest = requiredString(value.protocolDigest, "protocolDigest");
	if (!/^[a-f0-9]{64}$/.test(protocolDigest)) throw new TypeError("protocolDigest must be a SHA-256 digest.");
	if (hashProtocolBody(value) !== protocolDigest) throw new TypeError("Protocol digest does not match its contents.");
	if (!isRecord(value.benchmark)) throw new TypeError("Protocol benchmark is missing.");
	for (const key of Object.keys(SWE_BENCH_LITE_SOURCE)) {
		if (value.benchmark[key] !== SWE_BENCH_LITE_SOURCE[key as keyof typeof SWE_BENCH_LITE_SOURCE]) {
			throw new TypeError("Protocol does not target the pinned SWE-bench Lite split.");
		}
	}
	const model = parseModelIdentity(requiredString(value.model, "model"));
	const classifierModel = parseModelIdentity(requiredString(value.classifierModel, "classifierModel"));
	if (!Array.isArray(value.cases) || value.cases.length !== SWE_BENCH_LITE_SOURCE.expectedInstances) {
		throw new TypeError("Protocol must contain exactly 300 cases.");
	}
	const cases = value.cases.map(validateCase);
	if (new Set(cases.map((item) => item.instanceId)).size !== cases.length) {
		throw new TypeError("Protocol case ids must be unique.");
	}
	const arms = parseExperimentArms({
		schemaVersion: 2,
		benchmark: SWE_BENCH_LITE_SOURCE,
		arms: value.arms,
	});
	const repetitions = requiredPositiveInteger(value.repetitions, "repetitions");
	if (!Number.isSafeInteger(value.seed) || (value.seed as number) < 0 || (value.seed as number) > 0xffff_ffff) {
		throw new TypeError("Protocol seed is invalid.");
	}
	if (value.maxConcurrentRuns !== 1) throw new TypeError("Middlemanager execution currently requires concurrency 1.");
	if (!Array.isArray(value.tasks)) throw new TypeError("Protocol tasks are missing.");
	const tasks = value.tasks.map(validatePlannedTask);
	assertUniqueTasks(tasks, "Protocol tasks");
	const expectedTasks = createMultiArmTaskPlan(cases, arms, repetitions, value.seed as number);
	if (JSON.stringify(tasks) !== JSON.stringify(expectedTasks)) throw new TypeError("Protocol task plan is not reproducible.");
	if (!isRecord(value.execution)) throw new TypeError("Protocol execution metadata is missing.");
	if (value.execution.plannedRuns !== tasks.length) throw new TypeError("Protocol planned run count is incorrect.");
	if (value.execution.primaryMetric !== "resolved") throw new TypeError("Protocol primary metric must be resolved.");
	if (!Array.isArray(value.expectedObservations) || value.expectedObservations.length !== tasks.length) {
		throw new TypeError("Protocol expected observations do not match its task plan.");
	}
	const expectedObservations = value.expectedObservations.map(validateObservation);
	if (
		JSON.stringify(expectedObservations.map(({ status: _status, metrics: _metrics, ...task }) => task)) !==
		JSON.stringify(tasks)
	) {
		throw new TypeError("Protocol expected observation identities do not match its task plan.");
	}
	return {
		schemaVersion: 2,
		kind: "middlemanager-swebench-lite-ablation-protocol",
		createdAt: requiredString(value.createdAt, "createdAt"),
		piCommit: requiredString(value.piCommit, "piCommit"),
		benchmark: value.benchmark as typeof SWE_BENCH_LITE_SOURCE,
		model,
		classifierModel,
		modelConfiguration: isRecord(value.modelConfiguration) ? value.modelConfiguration : {},
		repetitions,
		seed: value.seed as number,
		maxConcurrentRuns: 1,
		noProxyHosts: Array.isArray(value.noProxyHosts)
			? value.noProxyHosts.map((item) => requiredString(item, "noProxyHost"))
			: [],
		inputFiles: value.inputFiles as MiddlemanagerProtocol["inputFiles"],
		inputHashes: value.inputHashes as MiddlemanagerProtocol["inputHashes"],
		cases,
		arms,
		launchConfigByArm: value.launchConfigByArm as MiddlemanagerProtocol["launchConfigByArm"],
		execution: value.execution as MiddlemanagerProtocol["execution"],
		tasks,
		expectedObservations,
		metrics: Array.isArray(value.metrics) ? value.metrics.map((item) => requiredString(item, "metric")) : [],
		protocolDigest,
	};
}

export async function readMiddlemanagerProtocol(path: string): Promise<MiddlemanagerProtocol> {
	return parseMiddlemanagerProtocol(JSON.parse(await readFile(path, "utf8")));
}

export function createEmptyObservationLedger(protocol: MiddlemanagerProtocol): MiddlemanagerObservationLedger {
	return {
		schemaVersion: 1,
		kind: "middlemanager-swebench-lite-observations",
		protocolDigest: protocol.protocolDigest,
		observations: [],
	};
}

export function parseMiddlemanagerObservationLedger(
	value: unknown,
	protocol: MiddlemanagerProtocol,
): MiddlemanagerObservationLedger {
	if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== "middlemanager-swebench-lite-observations") {
		throw new TypeError("Unsupported Middlemanager observation ledger schema.");
	}
	if (value.protocolDigest !== protocol.protocolDigest) throw new TypeError("Observation ledger protocol digest differs.");
	if (!Array.isArray(value.observations)) throw new TypeError("Observation ledger observations are missing.");
	const observations = value.observations.map(validateObservation);
	assertUniqueTasks(observations, "Observation ledger");
	const planned = new Set(protocol.tasks.map(observationKey));
	for (const observation of observations) {
		if (!planned.has(observationKey(observation))) throw new TypeError("Observation is not present in the protocol task plan.");
	}
	return {
		schemaVersion: 1,
		kind: "middlemanager-swebench-lite-observations",
		protocolDigest: protocol.protocolDigest,
		observations,
	};
}

export async function readMiddlemanagerObservationLedger(
	path: string,
	protocol: MiddlemanagerProtocol,
): Promise<MiddlemanagerObservationLedger> {
	try {
		return parseMiddlemanagerObservationLedger(JSON.parse(await readFile(path, "utf8")), protocol);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return createEmptyObservationLedger(protocol);
		throw error;
	}
}

export function nextMiddlemanagerTask(
	protocol: MiddlemanagerProtocol,
	ledger: MiddlemanagerObservationLedger,
): PlannedExperimentTask | undefined {
	const observed = new Set(ledger.observations.map(observationKey));
	return protocol.tasks.find((task) => !observed.has(observationKey(task)));
}

export async function writeMiddlemanagerObservationLedger(
	path: string,
	ledger: MiddlemanagerObservationLedger,
): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
	await writeFile(temporaryPath, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
	await rename(temporaryPath, path);
}

export async function recordMiddlemanagerObservation(
	path: string,
	protocol: MiddlemanagerProtocol,
	observation: MiddlemanagerObservation,
): Promise<MiddlemanagerObservationLedger> {
	const ledger = await readMiddlemanagerObservationLedger(path, protocol);
	const parsedObservation = validateObservation(observation);
	const key = observationKey(parsedObservation);
	if (!protocol.tasks.some((task) => observationKey(task) === key)) {
		throw new TypeError("Observation is not present in the protocol task plan.");
	}
	if (ledger.observations.some((item) => observationKey(item) === key)) {
		throw new TypeError(`Observation already exists for ${key}.`);
	}
	const next = { ...ledger, observations: [...ledger.observations, parsedObservation] };
	await writeMiddlemanagerObservationLedger(path, next);
	return next;
}

export async function executeMiddlemanagerProtocol(
	protocol: MiddlemanagerProtocol,
	path: string,
	execute: MiddlemanagerRunExecutor,
	options: MiddlemanagerRunOptions = {},
): Promise<MiddlemanagerObservationLedger> {
	const maxRuns = options.maxRuns ?? Number.POSITIVE_INFINITY;
	if (!Number.isSafeInteger(maxRuns) || maxRuns < 1) throw new TypeError("maxRuns must be a positive integer.");
	let ledger = await readMiddlemanagerObservationLedger(path, protocol);
	let executed = 0;
	while (executed < maxRuns) {
		const task = nextMiddlemanagerTask(protocol, ledger);
		if (!task) break;
		let observation: MiddlemanagerObservation;
		try {
			observation = await execute(task, protocol);
		} catch (error) {
			observation = {
				...task,
				status: "errored",
				metrics: {},
				error: error instanceof Error ? error.message : String(error),
			};
		}
		ledger = await recordMiddlemanagerObservation(path, protocol, observation);
		await options.onObservation?.(observation);
		executed += 1;
	}
	return ledger;
}