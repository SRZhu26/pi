import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	createArmEnvironment,
	createMultiArmTaskPlan,
	parseExperimentArms,
	parseExperimentCases,
} from "../src/middlemanager-experiment.ts";

const armMatrix = parseExperimentArms(
	JSON.parse(readFileSync(new URL("../experiments/middlemanager/arms.json", import.meta.url), "utf8")),
);
const experimentCases = parseExperimentCases(
	JSON.parse(readFileSync(new URL("../experiments/middlemanager/tasks.template.json", import.meta.url), "utf8")),
);

describe("Middlemanager experiment plan", () => {
	it("includes vanilla, full, seven ablations, and domain-matched comparators", () => {
		expect(armMatrix).toHaveLength(11);
		expect(armMatrix.filter((arm) => arm.kind === "middlemanager")).toHaveLength(8);
		expect(armMatrix.find((arm) => arm.id === "pi-autoresearch")?.domains).toEqual(["optimization"]);
		expect(armMatrix.find((arm) => arm.id === "pi-goal-x")?.domains).toEqual(["goal"]);
	});

	it("creates deterministic randomized blocks with exact paired arm identities", () => {
		const plan = createMultiArmTaskPlan(experimentCases, armMatrix, 2, 42);
		const repeated = createMultiArmTaskPlan(experimentCases, armMatrix, 2, 42);
		expect(plan).toEqual(repeated);
		expect(plan).toHaveLength(40);
		for (const blockId of new Set(plan.map((task) => task.blockId))) {
			const block = plan.filter((task) => task.blockId === blockId);
			expect(new Set(block.map((task) => task.armId)).size).toBe(block.length);
			expect(block.some((task) => task.armId === "vanilla-pi")).toBe(true);
			expect(block.some((task) => task.armId === "middlemanager-full")).toBe(true);
			expect(block.every((task, index) => task.order === index)).toBe(true);
		}
	});

	it("emits environment settings for active arms and ablations", () => {
		const full = armMatrix.find((arm) => arm.id === "middlemanager-full");
		const noGoal = armMatrix.find((arm) => arm.id === "middlemanager-no-goal-adherence");
		if (!full || !noGoal) throw new Error("required Middlemanager arms are missing");

		expect(createArmEnvironment(full, "llama/decision")).toMatchObject({
			PI_EXPERIMENT_ARM: "middlemanager-full",
			PI_MIDDLEMANAGER_MODEL: "llama/decision",
			PI_MIDDLEMANAGER_SHADOW: "false",
			PI_MIDDLEMANAGER_GOAL_ADHERENCE: "true",
			PI_MIDDLEMANAGER_VISUAL_REVIEW: "auto",
		});
		expect(createArmEnvironment(noGoal, "llama/decision").PI_MIDDLEMANAGER_GOAL_ADHERENCE).toBe("false");
	});

	it("rejects incomplete optimization measurements and invalid arm matrices", () => {
		expect(() =>
			parseExperimentCases({
				schemaVersion: 1,
				tasks: [{ ...experimentCases[0], measurement: undefined }],
			}),
		).toThrow("measurable baseline");
		expect(() => parseExperimentArms({ schemaVersion: 1, arms: [armMatrix[0]] })).toThrow("middlemanager-full");
	});
});