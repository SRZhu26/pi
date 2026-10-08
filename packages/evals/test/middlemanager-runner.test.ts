import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createArmLaunchConfig, createMultiArmTaskPlan, parseExperimentArms, SWE_BENCH_LITE_SOURCE } from "../src/middlemanager-experiment.ts";
import {
	createEmptyObservationLedger,
	nextMiddlemanagerTask,
	parseMiddlemanagerProtocol,
	readMiddlemanagerObservationLedger,
	recordMiddlemanagerObservation,
	executeMiddlemanagerProtocol,
	type MiddlemanagerProtocol,
} from "../src/middlemanager-runner.ts";

const arms = parseExperimentArms(
	JSON.parse(readFileSync(new URL("../experiments/middlemanager/arms.json", import.meta.url), "utf8")),
);
const cases = Array.from({ length: 300 }, (_unused, index) => ({
	instanceId: `django__django-${index + 1}`,
	repo: "django/django",
	baseCommit: "a".repeat(40),
	prompt: `Resolve issue ${index + 1}.`,
	version: "4.2",
}));

function createProtocol(): MiddlemanagerProtocol {
	const tasks = createMultiArmTaskPlan(cases, arms, 1, 20261008);
	const expectedObservations = tasks.map((task) => ({ ...task, status: "pending" as const, metrics: {} }));
	const body = {
		schemaVersion: 2 as const,
		kind: "middlemanager-swebench-lite-ablation-protocol" as const,
		createdAt: "2026-10-08T00:00:00.000Z",
		piCommit: "a".repeat(40),
		benchmark: SWE_BENCH_LITE_SOURCE,
		model: "openai/coder",
		classifierModel: "openai/classifier",
		modelConfiguration: {},
		repetitions: 1,
		seed: 20261008,
		maxConcurrentRuns: 1,
		noProxyHosts: [],
		inputFiles: { tasks: "tasks.json", arms: "arms.json" },
		inputHashes: { tasks: "a".repeat(64), arms: "b".repeat(64) },
		cases,
		arms,
		launchConfigByArm: Object.fromEntries(arms.map((arm) => [arm.id, createArmLaunchConfig(arm, "openai/classifier")])),
		execution: {
			primaryMetric: "resolved",
			evaluator: "official",
			pairedBy: "instanceId#repetition",
			plannedRuns: tasks.length,
		},
		tasks,
		expectedObservations,
		metrics: ["resolved"],
	};
	const protocolDigest = createHash("sha256").update(JSON.stringify(body)).digest("hex");
	return parseMiddlemanagerProtocol({ ...body, protocolDigest });
}

describe("Middlemanager runner ledger", () => {
	it("validates a reproducible protocol and returns the first pending task", () => {
		const protocol = createProtocol();
		const ledger = createEmptyObservationLedger(protocol);
		expect(nextMiddlemanagerTask(protocol, ledger)).toEqual(protocol.tasks[0]);
	});

	it("persists one observation and resumes at the next task", async () => {
		const protocol = createProtocol();
		const directory = await mkdtemp(join(tmpdir(), "middlemanager-runner-"));
		try {
			const path = join(directory, "observations.json");
			const first = protocol.tasks[0];
			const ledger = await recordMiddlemanagerObservation(path, protocol, {
				...first,
				status: "completed",
				metrics: { resolved: true },
			});
			expect(ledger.observations).toHaveLength(1);
			expect(nextMiddlemanagerTask(protocol, ledger)).toEqual(protocol.tasks[1]);
			expect(JSON.parse(await readFile(path, "utf8")).protocolDigest).toBe(protocol.protocolDigest);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("rejects duplicate observations and tampered protocol content", async () => {
		const protocol = createProtocol();
		const directory = await mkdtemp(join(tmpdir(), "middlemanager-runner-"));
		try {
			const path = join(directory, "observations.json");
			const observation = { ...protocol.tasks[0], status: "errored" as const, metrics: {}, error: "timeout" };
			await recordMiddlemanagerObservation(path, protocol, observation);
			await expect(recordMiddlemanagerObservation(path, protocol, observation)).rejects.toThrow("already exists");
			expect(() => parseMiddlemanagerProtocol({ ...protocol, model: "tampered" })).toThrow("digest");
			await expect(readMiddlemanagerObservationLedger(join(directory, "missing.json"), protocol)).resolves.toMatchObject({ observations: [] });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("runs a bounded pilot and resumes without repeating completed tasks", async () => {
		const protocol = createProtocol();
		const directory = await mkdtemp(join(tmpdir(), "middlemanager-runner-"));
		try {
			const path = join(directory, "observations.json");
			const executed: string[] = [];
			const execute = async (task: (typeof protocol.tasks)[number]) => {
				executed.push(task.armId);
				return { ...task, status: "completed" as const, metrics: { resolved: false } };
			};
			await executeMiddlemanagerProtocol(protocol, path, execute, { maxRuns: 2 });
			await executeMiddlemanagerProtocol(protocol, path, execute, { maxRuns: 1 });
			expect(executed).toEqual([protocol.tasks[0].armId, protocol.tasks[1].armId, protocol.tasks[2].armId]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});