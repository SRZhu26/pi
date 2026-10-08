import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	createArmEnvironment,
	createArmLaunchConfig,
	createMultiArmTaskPlan,
	createSweBenchLiteTaskSet,
	MIDDLEMANAGER_FEATURES,
	parseExperimentArms,
	parseSweBenchLiteTaskSet,
	SWE_BENCH_AGENT_MODEL,
	SWE_BENCH_LITE_SOURCE,
} from "../src/middlemanager-experiment.ts";

const armMatrix = parseExperimentArms(
	JSON.parse(readFileSync(new URL("../experiments/middlemanager/arms.json", import.meta.url), "utf8")),
);

function createTaskSet() {
	const rows = Array.from({ length: SWE_BENCH_LITE_SOURCE.expectedInstances }, (_unused, index) => ({
		instance_id: `django__django-${index + 1}`,
		repo: "django/django",
		base_commit: "a".repeat(40),
		problem_statement: `Resolve SWE-bench issue ${index + 1}.`,
		version: "4.2",
		environment_setup_commit: "b".repeat(40),
		patch: "hidden reference patch",
		test_patch: "hidden test patch",
		FAIL_TO_PASS: "hidden tests",
		PASS_TO_PASS: "hidden tests",
	}));
	return createSweBenchLiteTaskSet(rows, rows.length);
}

const taskSet = createTaskSet();

describe("Middlemanager experiment plan", () => {
	it("contains raw Pi, seven one-feature arms, and full Middlemanager", () => {
		expect(armMatrix).toHaveLength(9);
		expect(armMatrix.find((arm) => arm.id === "pi-no-extensions")).toMatchObject({ kind: "baseline", features: [] });
		expect(armMatrix.filter((arm) => arm.kind === "middlemanager" && arm.id !== "middlemanager-full")).toHaveLength(
			7,
		);
		for (const feature of MIDDLEMANAGER_FEATURES) {
			expect(
				armMatrix.find((arm) => arm.id === `middlemanager-add-${feature.replaceAll("_", "-")}`)?.features,
			).toEqual([feature]);
		}
		expect(armMatrix.find((arm) => arm.id === "middlemanager-full")?.features).toEqual(MIDDLEMANAGER_FEATURES);
	});

	it("creates deterministic randomized blocks pairing all arms per SWE-bench issue", () => {
		const cases = taskSet.tasks.slice(0, 2);
		const plan = createMultiArmTaskPlan(cases, armMatrix, 2, 42);
		const repeated = createMultiArmTaskPlan(cases, armMatrix, 2, 42);
		expect(plan).toEqual(repeated);
		expect(plan).toHaveLength(36);
		for (const blockId of new Set(plan.map((task) => task.blockId))) {
			const block = plan.filter((task) => task.blockId === blockId);
			expect(block).toHaveLength(9);
			expect(new Set(block.map((task) => task.armId)).size).toBe(9);
			expect(block.some((task) => task.armId === "pi-no-extensions")).toBe(true);
			expect(block.some((task) => task.armId === "middlemanager-full")).toBe(true);
			expect(block.every((task, index) => task.order === index)).toBe(true);
		}
	});

	it("keeps raw Pi extension-free and loads only Middlemanager for treatment arms", () => {
		const baseline = armMatrix.find((arm) => arm.id === "pi-no-extensions");
		const oneFeature = armMatrix.find((arm) => arm.id === "middlemanager-add-edit-alignment");
		if (!baseline || !oneFeature) throw new Error("required experiment arms are missing");

		expect(createArmLaunchConfig(baseline, "llama/decision").args).toEqual(["--no-extensions"]);
		expect(createArmLaunchConfig(oneFeature, "llama/decision").args).toEqual([
			"--no-extensions",
			"--extension",
			"packages/coding-agent/examples/extensions/middlemanager/index.ts",
		]);
	});

	it("freezes the requested local Qwen model settings", () => {
		expect(SWE_BENCH_AGENT_MODEL).toMatchObject({
			id: "Qwen3.8-Flash-Next-FP8",
			baseUrl: "http://172.16.125.60:30000/v1",
			contextWindow: 262_144,
			samplingParams: { temperature: 1 },
			maxConcurrentRuns: 1,
			noProxyHost: "172.16.125.60",
		});
	});

	it("sets only the assigned feature and records full-extension settings", () => {
		const full = armMatrix.find((arm) => arm.id === "middlemanager-full");
		const editOnly = armMatrix.find((arm) => arm.id === "middlemanager-add-edit-alignment");
		if (!full || !editOnly) throw new Error("required Middlemanager arms are missing");

		expect(createArmEnvironment(full, "llama/decision")).toMatchObject({
			PI_EXPERIMENT_ARM: "middlemanager-full",
			PI_MIDDLEMANAGER_MODEL: "llama/decision",
			PI_MIDDLEMANAGER_SHADOW: "false",
			PI_MIDDLEMANAGER_GOAL_ADHERENCE: "true",
			PI_MIDDLEMANAGER_VISUAL_REVIEW: "auto",
		});
		expect(createArmEnvironment(editOnly, "llama/decision")).toMatchObject({
			PI_MIDDLEMANAGER_EDIT_ALIGNMENT: "true",
			PI_MIDDLEMANAGER_GOAL_ADHERENCE: "false",
			PI_MIDDLEMANAGER_VISUAL_REVIEW: "off",
		});
	});

	it("pins and sanitizes the 300-instance dataset and rejects hidden evaluation data", () => {
		expect(taskSet.tasks).toHaveLength(300);
		expect(taskSet.benchmark).toEqual(SWE_BENCH_LITE_SOURCE);
		expect(taskSet.tasks[0]).not.toHaveProperty("patch");
		expect(taskSet.tasks[0]).not.toHaveProperty("test_patch");
		expect(taskSet.tasks[0]).not.toHaveProperty("hints_text");
		expect(parseSweBenchLiteTaskSet(taskSet).tasks).toHaveLength(300);
		expect(() =>
			parseSweBenchLiteTaskSet({ ...taskSet, benchmark: { ...taskSet.benchmark, revision: "main" } }),
		).toThrow("pinned SWE-bench Lite");
		expect(() =>
			parseSweBenchLiteTaskSet({
				...taskSet,
				tasks: taskSet.tasks.map((task, index) => (index === 0 ? { ...task, hints_text: "hidden" } : task)),
			}),
		).toThrow("hidden evaluation data");
		expect(() => createSweBenchLiteTaskSet(taskSet.tasks, 299)).toThrow("exactly 300 rows");
	});

	it("rejects incomplete or incorrectly configured arm matrices", () => {
		expect(() => parseExperimentArms({ schemaVersion: 2, benchmark: {}, arms: [] })).toThrow("pinned SWE-bench Lite");
		expect(() =>
			parseExperimentArms({
				schemaVersion: 2,
				benchmark: SWE_BENCH_LITE_SOURCE,
				arms: armMatrix.filter((arm) => arm.id !== "middlemanager-add-goal-adherence"),
			}),
		).toThrow("raw Pi, seven single-feature arms");
	});
});
