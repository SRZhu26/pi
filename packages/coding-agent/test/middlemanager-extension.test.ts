import type { ClassifierAnswer, ClassifierApi, ClassifierContext, ClassifierModel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import middlemanager, {
	chooseBoundedOption,
	rankMemoryFiles,
	requiresConfirmation,
} from "../examples/extensions/middlemanager/index.ts";

function createExtensionHarness() {
	const flags = new Map<string, boolean | string>();
	const handlers = new Map<string, (event: unknown, context: unknown) => Promise<unknown> | unknown>();
	const audit: unknown[] = [];
	const requests: ClassifierContext[] = [];
	let registeredTool: unknown;
	let userSelectedOption: string | undefined;
	let completionScore = 2;
	const model: ClassifierModel<ClassifierApi> = {
		type: "classifier",
		id: "decision",
		name: "Decision",
		api: "typesafe-system-one",
		provider: "test",
		baseUrl: "http://localhost",
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8_192,
	};
	const api = {
		registerFlag(name: string, options: { default?: boolean | string }) {
			flags.set(name, options.default ?? false);
		},
		getFlag(name: string) {
			return flags.get(name);
		},
		on(name: string, handler: unknown) {
			handlers.set(name, handler as (event: unknown, context: unknown) => Promise<unknown> | unknown);
			return () => {};
		},
		appendEntry(_name: string, data: unknown) {
			audit.push(data);
		},
		registerTool(tool: unknown) {
			registeredTool = tool;
		},
	} as unknown as ExtensionAPI;
	const modelRegistry = {
		findOfType: () => model,
		async classify(_model: ClassifierModel<ClassifierApi>, context: ClassifierContext) {
			requests.push(context);
			const answers: Record<string, ClassifierAnswer> = {};
			for (const [id, question] of Object.entries(context.questions)) {
				if (question.type === "choice") {
					const choice = Object.keys(question.criteria)[0] ?? "";
					answers[id] = { type: "choice", choice, probabilities: { [choice]: 0.95 }, confidence: 0.95 };
				} else if (question.type === "score") {
					answers[id] = { type: "score", score: id === "goal_completion" ? completionScore : 2, confidence: 0.95 };
				} else {
					answers[id] = { type: "bool", probability: 0.95 };
				}
			}
			return {
				api: model.api,
				provider: model.provider,
				model: model.id,
				answers,
				stopReason: "stop" as const,
				timestamp: Date.now(),
			};
		},
	};
	const context = {
		modelRegistry,
		hasUI: false,
		ui: {
			notify() {},
			async select() {
				return userSelectedOption;
			},
		},
		signal: undefined,
	} as unknown as ExtensionContext;
	middlemanager(api);
	flags.set("middlemanager-model", "test/decision");
	return {
		flags,
		handlers,
		audit,
		requests,
		context,
		registeredTool,
		setCompletionScore(score: number) {
			completionScore = score;
		},
		setUserSelectedOption(option: string | undefined) {
			userSelectedOption = option;
		},
	};
}

describe("middlemanager decision helpers", () => {
	it("ranks relevant preloaded memory while preserving other context", () => {
		const files = [
			{ path: "project/AGENTS.md", content: "Keep existing code conventions." },
			{ path: "memory/style.md", content: "Use established formatting and local utilities." },
			{ path: "memory/classifier.md", content: "Classifier heads return typed probability distributions." },
		];

		expect(rankMemoryFiles(files, "classifier probability heads", 100)).toEqual([files[0], files[2], files[1]]);
		expect(rankMemoryFiles(files, "classifier probability heads", 8)).toEqual([files[0]]);
	});

	it("selects only clear, reversible, low-consequence options", () => {
		const answer = {
			type: "choice" as const,
			choice: "cached",
			probabilities: { cached: 0.91, latest: 0.09 },
			confidence: 0.94,
		};
		const options = [{ id: "cached" }, { id: "latest" }];

		expect(chooseBoundedOption(answer, options, true, "low")).toBe("cached");
		expect(chooseBoundedOption(answer, options, false, "low")).toBeUndefined();
		expect(chooseBoundedOption(answer, options, true, "medium")).toBeUndefined();
		expect(
			chooseBoundedOption({ ...answer, probabilities: { cached: 0.58, latest: 0.42 } }, options, true, "low"),
		).toBeUndefined();
	});

	it("requires explicit approval for known high-impact commands", () => {
		expect(requiresConfirmation("sudo apt install package")).toBe(true);
		expect(requiresConfirmation("git push origin main")).toBe(true);
		expect(requiresConfirmation("git push --force origin main")).toBe(true);
		expect(requiresConfirmation("rm ./important.txt")).toBe(true);
		expect(requiresConfirmation("rm -rf ./build")).toBe(true);
		expect(requiresConfirmation("Remove-Item .\\build -Recurse -Force")).toBe(true);
		expect(requiresConfirmation("git status --short")).toBe(false);
	});

	it("asks the user when autopilot is unsafe and records a recommendation override", async () => {
		const harness = createExtensionHarness();
		const tool = harness.registeredTool as {
			execute: (...args: unknown[]) => Promise<{ details?: unknown }>;
		};
		harness.setUserSelectedOption("latest: Use the latest version");
		const result = await tool.execute(
			"choice-1",
			{
				question: "Which version should be used?",
				options: [
					{ id: "cached", description: "Use the cached version" },
					{ id: "latest", description: "Use the latest version" },
				],
				reversible: true,
				consequence: "low",
			},
			undefined,
			undefined,
			{ ...harness.context, hasUI: true },
		);

		expect(result.details).toEqual({
			status: "user_selected",
			choice: "latest",
			recommendation: "cached",
			userOverride: true,
		});
		expect(harness.audit.at(-1)).toMatchObject({ decision: "user_selected", userOverride: true });
	});

	it("records the outcome of a tool call after the shadow decision", async () => {
		const harness = createExtensionHarness();
		const toolCall = harness.handlers.get("tool_call");
		const toolResult = harness.handlers.get("tool_result");
		if (!toolCall || !toolResult) throw new Error("Middlemanager tool handlers were not registered");

		await toolCall(
			{
				toolName: "edit",
				toolCallId: "edit-1",
				input: { path: "src/cache.ts", oldText: "old", newText: "new" },
			},
			harness.context,
		);
		await toolResult({ toolCallId: "edit-1", isError: false }, harness.context);

		expect(harness.audit.at(-1)).toMatchObject({
			feature: "tool_gate",
			decision: "tool_succeeded",
			toolCallId: "edit-1",
		});
	});

	it("bundles intake heads, keeps shadow mode observational, and limits continuation", async () => {
		const harness = createExtensionHarness();
		const beforeAgentStart = harness.handlers.get("before_agent_start");
		const beforeSettle = harness.handlers.get("agent_before_settle");
		if (!beforeAgentStart || !beforeSettle) throw new Error("Middlemanager lifecycle handlers were not registered");

		const shadowEvent = {
			prompt: "Implement a bounded cache policy",
			systemPromptOptions: { contextFiles: [], sections: {} },
		};
		await beforeAgentStart(shadowEvent, harness.context);
		expect(Object.keys(harness.requests[0]?.questions ?? {})).toEqual(["task_type", "task_difficulty"]);
		expect(shadowEvent.systemPromptOptions.sections).toEqual({});

		harness.flags.set("middlemanager-shadow", false);
		const activeEvent = {
			prompt: "Implement a bounded cache policy",
			systemPromptOptions: { contextFiles: [], sections: {} },
		};
		await beforeAgentStart(activeEvent, harness.context);
		expect(activeEvent.systemPromptOptions.sections).toHaveProperty("middlemanager");

		harness.setCompletionScore(0);
		const settleEvent = {
			outcome: "completed",
			context: { canContinue: true, llmMessages: [] },
		};
		const continuation = await beforeSettle(settleEvent, harness.context);
		expect(continuation).toMatchObject({ continue: true });
		expect((continuation as { entries: unknown[] }).entries).toHaveLength(1);
		expect(await beforeSettle(settleEvent, harness.context)).toBeUndefined();
		expect(harness.audit).toHaveLength(6);
	});
});
