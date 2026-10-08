import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createArmEnvironment,
	createMultiArmTaskPlan,
	parseExperimentArms,
	parseExperimentCases,
	parseModelIdentity,
} from "./middlemanager-experiment.ts";

interface CliOptions {
	tasksFile: string;
	armsFile: string;
	outputFile?: string;
	model: string;
	classifierModel: string;
	repetitions: number;
	seed: number;
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "..", "..");

function parsePositiveInteger(value: string, label: string): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer.`);
	return parsed;
}

function parseSeed(value: string): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 0xffff_ffff) {
		throw new Error("Seed must be an integer between 0 and 4294967295.");
	}
	return parsed;
}

function parseArgs(args: readonly string[], environment: NodeJS.ProcessEnv): CliOptions {
	const values = new Map<string, string>();
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		const equalsIndex = argument.indexOf("=");
		const name = equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);
		if (!new Set(["--tasks", "--arms", "--output", "--model", "--classifier-model", "--repetitions", "--seed"]).has(name)) {
			throw new Error(`Unsupported Middlemanager planner argument: ${argument}`);
		}
		const value = equalsIndex === -1 ? args[index + 1] : argument.slice(equalsIndex + 1);
		if (!value || (equalsIndex === -1 && value.startsWith("--"))) throw new Error(`Missing value for ${name}.`);
		values.set(name, value);
		if (equalsIndex === -1) index += 1;
	}

	const taskFile = values.get("--tasks");
	if (!taskFile) throw new Error("Pass --tasks with a frozen experiment task file; the template is not runnable.");
	const model = values.get("--model") ?? [environment.PI_PROVIDER, environment.PI_MODEL].filter(Boolean).join("/");
	const classifierModel = values.get("--classifier-model") ?? environment.PI_MIDDLEMANAGER_MODEL;
	if (!model) throw new Error("Pass --model provider/model-id or set PI_PROVIDER and PI_MODEL.");
	if (!classifierModel) throw new Error("Pass --classifier-model provider/model-id or set PI_MIDDLEMANAGER_MODEL.");
	const repetitionsText = values.get("--repetitions") ?? environment.PI_MIDDLEMANAGER_REPETITIONS ?? "1";
	const seedText = values.get("--seed") ?? environment.PI_MIDDLEMANAGER_SEED;
	if (seedText === undefined) throw new Error("Pass --seed or set PI_MIDDLEMANAGER_SEED to make arm order reproducible.");
	return {
		tasksFile: resolve(packageRoot, taskFile),
		armsFile: resolve(packageRoot, values.get("--arms") ?? "experiments/middlemanager/arms.json"),
		...(values.has("--output") ? { outputFile: resolve(packageRoot, values.get("--output") as string) } : {}),
		model: parseModelIdentity(model),
		classifierModel: parseModelIdentity(classifierModel),
		repetitions: parsePositiveInteger(repetitionsText, "Repetitions"),
		seed: parseSeed(seedText),
	};
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function currentCommit(): string {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
	} catch {
		return "unknown";
	}
}

function relativeToRepo(path: string): string {
	return isAbsolute(path) ? path : resolve(repoRoot, path);
}

const options = parseArgs(process.argv.slice(2), process.env);
const taskText = await readFile(options.tasksFile, "utf8");
const armText = await readFile(options.armsFile, "utf8");
const cases = parseExperimentCases(JSON.parse(taskText));
const arms = parseExperimentArms(JSON.parse(armText));
const tasks = createMultiArmTaskPlan(cases, arms, options.repetitions, options.seed);
const runId = `${new Date().toISOString().replaceAll(":", "-")}_${randomUUID()}`;
const outputFile = options.outputFile ?? resolve(packageRoot, ".eval", "middlemanager", runId, "protocol.json");
const inputHashes = {
	tasks: sha256(taskText),
	arms: sha256(armText),
};
const expectedObservations = tasks.map((task) => ({
	...task,
	status: "pending",
	metrics: {
		acceptancePassed: null,
		qualityScore: null,
		wallTimeMs: null,
		codingModelInputTokens: null,
		codingModelOutputTokens: null,
		codingModelCost: null,
		classifierCalls: null,
		classifierInputTokens: null,
		classifierOutputTokens: null,
		classifierCost: null,
		classifierLatencyMs: null,
		toolCalls: null,
		userInterventions: null,
		safetyBlocks: null,
		benchmarkValue: null,
	},
}));
const environmentByArm = Object.fromEntries(
	arms.map((arm) => [arm.id, createArmEnvironment(arm, options.classifierModel)]),
);
const protocolBody = {
	schemaVersion: 1,
	kind: "middlemanager-ablation-protocol",
	createdAt: new Date().toISOString(),
	piCommit: currentCommit(),
	model: options.model,
	classifierModel: options.classifierModel,
	repetitions: options.repetitions,
	seed: options.seed,
	inputFiles: {
		tasks: relativeToRepo(options.tasksFile),
		arms: relativeToRepo(options.armsFile),
	},
	inputHashes,
	cases,
	arms,
	environmentByArm,
	tasks,
	expectedObservations,
	metrics: [
		"acceptancePassed",
		"qualityScore",
		"wallTimeMs",
		"codingModelInputTokens",
		"codingModelOutputTokens",
		"codingModelCost",
		"classifierCalls",
		"classifierInputTokens",
		"classifierOutputTokens",
		"classifierCost",
		"classifierLatencyMs",
		"toolCalls",
		"userInterventions",
		"safetyBlocks",
		"benchmarkValue",
	],
};
const protocolDigest = sha256(JSON.stringify(protocolBody));
const protocol = { ...protocolBody, protocolDigest };
await mkdir(dirname(outputFile), { recursive: true });
await writeFile(outputFile, `${JSON.stringify(protocol, null, 2)}\n`);
await writeFile(outputFile.replace(/\.json$/i, ".expected-observations.json"), `${JSON.stringify(expectedObservations, null, 2)}\n`);
console.log(`Protocol: ${outputFile}`);
console.log(`Protocol SHA-256: ${protocolDigest}`);
console.log(`Tasks: ${cases.length}; planned runs: ${tasks.length}; seed: ${options.seed}`);