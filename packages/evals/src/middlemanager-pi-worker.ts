import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { RpcClient } from "../../coding-agent/src/modes/rpc/rpc-client.ts";

type WorkerInput = {
	outputFile: string;
	cliPath: string;
	cwd: string;
	args: string[];
	environment: Record<string, string>;
	prompt: string;
	timeoutMs: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function addUsage(target: { input: number; output: number; cacheRead: number; cacheWrite: number }, value: unknown): void {
	if (!isRecord(value)) return;
	for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
		const number = numberValue(value[key]);
		if (number !== undefined) target[key] += number;
	}
}

async function resolveClassifierModel(environment: Record<string, string>): Promise<Record<string, string>> {
	const configured = environment.PI_MIDDLEMANAGER_MODEL;
	const baseUrl = environment.LLAMA_BASE_URL;
	if (!configured?.startsWith("llama.cpp/") || !baseUrl) return environment;
	try {
		const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`);
		if (!response.ok) return environment;
		const payload = (await response.json()) as { data?: unknown; models?: unknown };
		const models = [...(Array.isArray(payload.data) ? payload.data : []), ...(Array.isArray(payload.models) ? payload.models : [])].filter(
			isRecord,
		);
		const configuredId = configured.slice("llama.cpp/".length);
		const selected =
			models.find(
				(model) =>
					model.id === configuredId ||
					(Array.isArray(model.aliases) && model.aliases.includes(configuredId)),
			) ?? models.find((model) => typeof model.id === "string");
		if (typeof selected?.id === "string") {
			return { ...environment, PI_MIDDLEMANAGER_MODEL: `llama.cpp/${selected.id}` };
		}
	} catch {
		return environment;
	}
	return environment;
}

const inputPath = process.argv[2];
if (!inputPath) throw new Error("Usage: middlemanager-pi-worker.ts <input.json>");
const input = JSON.parse(await readFile(inputPath, "utf8")) as WorkerInput;
const startedAt = Date.now();
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const environment = await resolveClassifierModel(input.environment);
const client = new RpcClient({
	cliPath: input.cliPath,
	cwd: input.cwd,
	env: { ...environment, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR ?? "/tmp/pi-agent" },
	args: input.args,
});

let events: Array<Record<string, unknown>> = [];
let result: Record<string, unknown>;
try {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? "/tmp/pi-agent";
	await mkdir(agentDir, { recursive: true });
	const modelId = environment.PI_MODEL;
	const modelBaseUrl = environment.PI_MODEL_BASE_URL;
	if (modelId && modelBaseUrl) {
		await writeFile(
			`${agentDir}/models.json`,
			`${JSON.stringify(
				{
					providers: {
						openai: {
							baseUrl: modelBaseUrl,
							apiKey: "local",
							models: [{ id: modelId, api: "openai-completions", contextWindow: 262144, maxTokens: 32768 }],
						},
					},
				},
				null,
			)}\n`,
		);
	}
	await client.start();
	events = (await client.promptAndWait(input.prompt, undefined, input.timeoutMs)) as Array<Record<string, unknown>>;
	const stats = await client.getSessionStats();
	const entries = await client.getEntries();
	let classifierCalls = 0;
	let classifierLatencyMs = 0;
	let safetyBlocks = 0;
	const featureInvocations: Record<string, number> = {};
	for (const entry of entries.entries) {
		if (entry.type !== "custom" || entry.customType !== "middlemanager-audit" || !isRecord(entry.data)) continue;
		const feature = typeof entry.data.feature === "string" ? entry.data.feature : "unknown";
		featureInvocations[feature] = (featureInvocations[feature] ?? 0) + 1;
		if (typeof entry.data.model === "string") {
			classifierCalls += 1;
			const latency = numberValue(entry.data.latencyMs);
			if (latency !== undefined) classifierLatencyMs += latency;
		}
		if (entry.data.decision === "blocked" || entry.data.decision === "confirmation_required") safetyBlocks += 1;
		if (isRecord(entry.data.usage)) addUsage(usage, entry.data.usage);
	}
	result = {
		status: "completed",
		wallTimeMs: Date.now() - startedAt,
		codingModelInputTokens: stats.tokens.input,
		codingModelOutputTokens: stats.tokens.output,
		codingModelCost: stats.cost,
		classifierCalls,
		classifierInputTokens: usage.input,
		classifierOutputTokens: usage.output,
		classifierCost: 0,
		classifierLatencyMs,
		toolCalls: stats.toolCalls,
		userInterventions: 0,
		safetyBlocks,
		featureInvocations,
		eventCount: events.length,
	};
} catch (error) {
	result = {
		status: "errored",
		wallTimeMs: Date.now() - startedAt,
		error: error instanceof Error ? error.message : String(error),
	};
} finally {
	await client.stop();
}

await mkdir(dirname(input.outputFile), { recursive: true });
await writeFile(input.outputFile, `${JSON.stringify(result, null, 2)}\n`);