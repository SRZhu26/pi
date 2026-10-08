import type {
	ClassifierAnswer,
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierQuestion,
	ImageContent,
	Message,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const POLICY_VERSION = "middlemanager-policy/0.1.0";
const HEAD_VERSION = "middlemanager-heads/0.1.0";
const MEMORY_TOKEN_BUDGET = 3_000;
const MAX_STATE_CHARS = 12_000;
const SENSITIVE_COMMAND =
	/\b(?:sudo|shutdown|reboot|diskpart|format|terraform\s+destroy|kubectl\s+delete|npm\s+publish)\b|\bgit\s+push\b|\bgit\s+(?:clean|reset)\b.*(?:--hard|--force|\s-f\b)|\b(?:rm|remove-item|del|erase|rmdir)\b/i;

type VisualMode = "auto" | "on" | "off";
type Consequence = "low" | "medium" | "high";

interface MemoryFile {
	path: string;
	content: string;
}

function redactText(value: string, limit = MAX_STATE_CHARS): string {
	return value
		.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi, "[REDACTED KEY]")
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
		.replace(/\b((?:api[_-]?key|token|password|secret)\s*[:=])\s*[^\s,;]+/gi, "$1 [REDACTED]")
		.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED TOKEN]")
		.slice(0, limit);
}

function booleanEnvironment(name: string, fallback: boolean): boolean {
	const value = process.env[name]?.trim().toLowerCase();
	if (value === undefined || value === "") return fallback;
	if (["1", "true", "yes", "on"].includes(value)) return true;
	if (["0", "false", "no", "off"].includes(value)) return false;
	throw new Error(`${name} must be a boolean value.`);
}

function tokenize(value: string): string[] {
	return value.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [];
}

function isMemoryFile(path: string): boolean {
	return /(^|[\\/])(?:memory(?:s)?(?:[\\/]|\.md$)|\.pi[\\/]memory(?:[\\/]|$))/i.test(path);
}

/** Keeps non-memory context in place and ranks only preloaded memory files within a token budget. */
export function rankMemoryFiles(files: MemoryFile[], prompt: string, tokenBudget = MEMORY_TOKEN_BUDGET): MemoryFile[] {
	const query = new Set(tokenize(prompt));
	const fixed = files.filter((file) => !isMemoryFile(file.path));
	const candidates = files
		.filter((file) => isMemoryFile(file.path))
		.map((file, index) => ({
			file,
			index,
			score: tokenize(file.content).reduce((score, term) => score + (query.has(term) ? 1 : 0), 0),
		}))
		.sort((left, right) => right.score - left.score || left.index - right.index);

	let remainingTokens = tokenBudget;
	const selected: MemoryFile[] = [];
	for (const candidate of candidates) {
		const tokens = Math.ceil(candidate.file.content.length / 4);
		if (tokens > remainingTokens) continue;
		remainingTokens -= tokens;
		selected.push(candidate.file);
	}
	return [...fixed, ...selected];
}

/** Returns a choice only for a reversible, low-consequence decision with a clear probability margin. */
export function chooseBoundedOption(
	answer: ClassifierAnswer | undefined,
	options: readonly { id: string }[],
	reversible: boolean,
	consequence: Consequence,
): string | undefined {
	if (!reversible || consequence !== "low" || answer?.type !== "choice" || answer.confidence < 0.8) return undefined;
	const allowed = new Set(options.map((option) => option.id));
	const ranked = Object.entries(answer.probabilities)
		.filter(([id]) => allowed.has(id))
		.sort((left, right) => right[1] - left[1]);
	const [top, runnerUp] = ranked;
	if (!top || top[0] !== answer.choice || top[1] < 0.8 || top[1] - (runnerUp?.[1] ?? 0) < 0.2) return undefined;
	return top[0];
}

function classifierFor(pi: ExtensionAPI, ctx: ExtensionContext): ClassifierModel<ClassifierApi> | undefined {
	const configured = pi.getFlag("middlemanager-model");
	if (typeof configured !== "string") return undefined;
	const separator = configured.indexOf("/");
	if (separator < 1 || separator === configured.length - 1) return undefined;
	return ctx.modelRegistry.findOfType(
		"classifier",
		configured.slice(0, separator),
		configured.slice(separator + 1),
	);
}

function recordAudit(pi: ExtensionAPI, data: Record<string, unknown>): void {
	pi.appendEntry("middlemanager-audit", {
		version: 1,
		policy: POLICY_VERSION,
		heads: HEAD_VERSION,
		timestamp: Date.now(),
		...data,
	});
}

function summarizeAnswers(answers: Record<string, ClassifierAnswer>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(answers).map(([id, answer]) => [
			id,
			answer.type === "choice"
				? { type: answer.type, choice: answer.choice, probabilities: answer.probabilities, confidence: answer.confidence }
				: answer.type === "score"
					? { type: answer.type, score: answer.score, confidence: answer.confidence }
					: { type: answer.type, probability: answer.probability },
		]),
	);
}

async function classifyHeads(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	model: ClassifierModel<ClassifierApi>,
	feature: string,
	state: ClassifierContext["state"],
	questions: Record<string, ClassifierQuestion>,
	images?: ImageContent[],
): Promise<Record<string, ClassifierAnswer> | undefined> {
	const startedAt = Date.now();
	const result = await ctx.modelRegistry.classify(
		model,
		{ state, questions, ...(images?.length ? { images } : {}) },
		{ signal: ctx.signal },
	);
	recordAudit(pi, {
		feature,
		model: `${model.provider}/${model.id}`,
		latencyMs: Date.now() - startedAt,
		...(result.usage ? { usage: result.usage } : {}),
		answers: summarizeAnswers(result.answers),
		decision: result.stopReason === "stop" ? "classified" : "abstain",
		...(result.errorMessage ? { error: redactText(result.errorMessage, 500) } : {}),
	});
	return result.stopReason === "stop" ? result.answers : undefined;
}

function toolSummary(event: ToolCallEvent): string {
	return redactText(JSON.stringify(event.input) ?? "", 4_000);
}

function recentEvidence(messages: readonly Message[]): string {
	return redactText(
		messages
			.slice(-8)
			.map((message) => {
				const content = Array.isArray(message.content)
					? message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")
					: message.content;
				return `${message.role}: ${typeof content === "string" ? content : ""}`;
			})
			.join("\n"),
		5_000,
	);
}

function commandOf(event: ToolCallEvent): string | undefined {
	if (event.toolName !== "bash" && event.toolName !== "powershell") return undefined;
	return typeof event.input.command === "string" ? event.input.command : undefined;
}

export function requiresConfirmation(command: string): boolean {
	return SENSITIVE_COMMAND.test(command);
}

function isHighImpactOperation(event: ToolCallEvent): boolean {
	const command = commandOf(event);
	return command !== undefined && requiresConfirmation(command);
}

function requiresReview(answers: Record<string, ClassifierAnswer> | undefined): boolean {
	if (!answers) return true;
	for (const [id, answer] of Object.entries(answers)) {
		if (id === "action_risk") {
			if (answer.type !== "choice" || answer.confidence < 0.75 || answer.choice !== "low") return true;
		} else if (answer.type !== "score" || answer.confidence < 0.75 || answer.score < 2) {
			return true;
		}
	}
	return false;
}

const BoundedChoiceParams = Type.Object({
	question: Type.String({ description: "The decision to make from the supplied bounded options" }),
	options: Type.Array(
		Type.Object({ id: Type.String(), description: Type.String() }),
		{ minItems: 2, maxItems: 8 },
	),
	reversible: Type.Boolean({ description: "Whether the selected option can be undone without lasting impact" }),
	consequence: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
});

export default function middlemanager(pi: ExtensionAPI) {
	pi.registerFlag("middlemanager-model", {
		type: "string",
		default: process.env.PI_MIDDLEMANAGER_MODEL ?? "",
		description: "Classifier model in provider/model-id form",
	});
	pi.registerFlag("middlemanager-shadow", {
		type: "boolean",
		default: booleanEnvironment("PI_MIDDLEMANAGER_SHADOW", true),
		description: "Log decisions without applying model policy",
	});
	pi.registerFlag("middlemanager-task-difficulty", {
		type: "boolean",
		default: booleanEnvironment("PI_MIDDLEMANAGER_TASK_DIFFICULTY", true),
	});
	pi.registerFlag("middlemanager-memory", {
		type: "boolean",
		default: booleanEnvironment("PI_MIDDLEMANAGER_MEMORY", false),
	});
	pi.registerFlag("middlemanager-bash-guardrails", {
		type: "boolean",
		default: booleanEnvironment("PI_MIDDLEMANAGER_BASH_GUARDRAILS", true),
	});
	pi.registerFlag("middlemanager-edit-alignment", {
		type: "boolean",
		default: booleanEnvironment("PI_MIDDLEMANAGER_EDIT_ALIGNMENT", true),
	});
	pi.registerFlag("middlemanager-goal-adherence", {
		type: "boolean",
		default: booleanEnvironment("PI_MIDDLEMANAGER_GOAL_ADHERENCE", true),
	});
	pi.registerFlag("middlemanager-autopilot", {
		type: "boolean",
		default: booleanEnvironment("PI_MIDDLEMANAGER_AUTOPILOT", false),
	});
	pi.registerFlag("middlemanager-visual-review", {
		type: "string",
		default: process.env.PI_MIDDLEMANAGER_VISUAL_REVIEW ?? "auto",
	});

	let objective = "";
	let goalContinuationCount = 0;
	const pendingToolOutcomes = new Map<string, { feature: string; tool: string }>();

	pi.on("before_agent_start", async (event, ctx) => {
		objective = redactText(event.prompt);
		goalContinuationCount = 0;
		const memoryEnabled = pi.getFlag("middlemanager-memory") === true;
		const shadow = pi.getFlag("middlemanager-shadow") !== false;
		if (memoryEnabled && !shadow) {
			const before = event.systemPromptOptions.contextFiles;
			const ranked = rankMemoryFiles(before, objective);
			if (ranked.length !== before.length || ranked.some((file, index) => file !== before[index])) {
				event.systemPromptOptions.contextFiles = ranked;
				recordAudit(pi, {
					feature: "memory_selection",
					selected: ranked.filter((file) => isMemoryFile(file.path)).map((file) => file.path.split(/[\\/]/).at(-1)),
					decision: "ranked",
				});
			}
		}

		const model = classifierFor(pi, ctx);
		const visualMode = pi.getFlag("middlemanager-visual-review");
		if (visualMode === "on" && !model) {
			recordAudit(pi, { feature: "visual_review", decision: "unavailable", reason: "no classifier is configured" });
			ctx.ui.notify("Middlemanager visual review unavailable: no classifier is configured", "warning");
			return undefined;
		}
		if (visualMode === "auto" && event.images?.length && !model) {
			recordAudit(pi, { feature: "visual_review", decision: "disabled", reason: "no classifier is configured" });
		}
		if (!model) return undefined;
		const questions: Record<string, ClassifierQuestion> = {};
		if (pi.getFlag("middlemanager-task-difficulty") !== false) {
			questions.task_type = {
				type: "choice",
				instructions: "Classify the requested software task.",
				criteria: {
					feature: "Implement new behavior",
					bug: "Fix incorrect behavior",
					review: "Inspect or critique existing work",
					question: "Answer or explain without a code change",
					other: "None of the above",
				},
			};
			questions.task_difficulty = {
				type: "score",
				instructions: "Rate the task difficulty from routine to unusually complex.",
				criteria: ["routine", "moderate", "complex", "high-stakes"],
			};
		}

		const wantsVisual = visualMode === "on" || visualMode === "auto";
		const canSeeImages = model.input.includes("image");
		const useImages = wantsVisual && canSeeImages && Boolean(event.images?.length);
		if (visualMode === "auto" && event.images?.length && !canSeeImages) {
			recordAudit(pi, { feature: "visual_review", decision: "disabled", reason: "selected classifier does not support images" });
		}
		if (visualMode === "on" && (!canSeeImages || !event.images?.length)) {
			const reason = !canSeeImages ? "selected classifier does not support images" : "no image was supplied";
			recordAudit(pi, { feature: "visual_review", decision: "unavailable", reason });
			ctx.ui.notify(`Middlemanager visual review unavailable: ${reason}`, "warning");
		}
		if (useImages) {
			questions.visual_review = {
				type: "choice",
				instructions: "Judge only whether the supplied visual evidence matches the stated objective.",
				criteria: {
					absent: "The requested result is not visible",
					present_correct: "The requested result is visible and correct",
					present_incorrect: "The result is visible but incorrect",
					inconclusive: "The image does not provide enough evidence",
				},
			};
		}
		if (Object.keys(questions).length === 0) return undefined;

		const answers = await classifyHeads(
			pi,
			ctx,
			model,
			"task_intake",
			{ objective, phase: "task_intake" },
			questions,
			useImages ? event.images : undefined,
		);
		if (!answers || shadow) return undefined;

		const lines: string[] = [];
		const taskType = answers.task_type;
		if (taskType?.type === "choice" && taskType.confidence >= 0.65) lines.push(`Task type estimate: ${taskType.choice}.`);
		const difficulty = answers.task_difficulty;
		if (difficulty?.type === "score" && difficulty.confidence >= 0.65) {
			const level = ["routine", "moderate", "complex", "high-stakes"][Math.max(0, Math.min(3, Math.round(difficulty.score)))];
			lines.push(`Task difficulty estimate: ${level}.`);
		}
		const visual = answers.visual_review;
		if (visual?.type === "choice" && visual.confidence >= 0.65) lines.push(`Visual evidence estimate: ${visual.choice}.`);
		if (lines.length > 0) event.systemPromptOptions.sections.middlemanager = lines.join("\n");
		return undefined;
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		if (
			pi.getFlag("middlemanager-goal-adherence") === false ||
			event.outcome !== "completed"
		) {
			return undefined;
		}
		const shadow = pi.getFlag("middlemanager-shadow") !== false;
		const model = classifierFor(pi, ctx);
		if (!model) return undefined;
		const answers = await classifyHeads(pi, ctx, model, "goal_completion", {
			objective,
			phase: "settlement",
			evidence: recentEvidence(event.context.llmMessages),
		}, {
			goal_completion: {
				type: "score",
				instructions: "Rate whether the conversation provides evidence that the user's stated objective is complete.",
				criteria: ["unmet", "partly met", "met"],
			},
		});
		const completion = answers?.goal_completion;
		if (completion?.type !== "score" || completion.confidence < 0.75) {
			recordAudit(pi, { feature: "goal_completion", decision: "abstain" });
			if (!shadow) ctx.ui.notify("Middlemanager could not verify that the objective is complete; review the result.", "warning");
			return undefined;
		}
		if (completion.score >= 2) {
			recordAudit(pi, { feature: "goal_completion", decision: "complete" });
			return undefined;
		}
		if (shadow) {
			recordAudit(pi, { feature: "goal_completion", decision: "shadow_unmet" });
			return undefined;
		}
		if (goalContinuationCount >= 1) {
			recordAudit(pi, { feature: "goal_completion", decision: "unmet_after_continuation_limit" });
			ctx.ui.notify("Middlemanager still sees unmet criteria after its one continuation; review the result.", "warning");
			return undefined;
		}
		if (!event.context.canContinue) {
			recordAudit(pi, { feature: "goal_completion", decision: "unmet_no_runnable_context" });
			ctx.ui.notify("Middlemanager found possible unmet criteria, but Pi has no runnable context to continue.", "warning");
			return undefined;
		}

		goalContinuationCount += 1;
		recordAudit(pi, { feature: "goal_completion", decision: "one_bounded_continuation" });
		return {
			entries: [
				{
					type: "custom_message",
					customType: "middlemanager-goal-check",
					content:
						"The goal check found possible unmet criteria. Take one narrowly scoped action to address an unmet criterion, then report concrete evidence. Do not expand scope.",
					display: false,
				},
			],
			continue: true,
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		if (isHighImpactOperation(event)) {
			const command = redactText(commandOf(event) ?? "", 500);
			const approved = ctx.hasUI && (await ctx.ui.confirm("Confirm high-impact operation", command));
			recordAudit(pi, {
				feature: "deterministic_guardrail",
				decision: approved ? "approved_by_user" : "blocked",
				userOverride: approved,
				tool: event.toolName,
			});
			if (!approved) return { block: true, reason: "High-impact operation requires explicit user approval" };
		}

		const shellTool = event.toolName === "bash" || event.toolName === "powershell";
		const editTool = event.toolName === "edit" || event.toolName === "write";
		if (!shellTool && !editTool) return undefined;
		const checkBash = shellTool && pi.getFlag("middlemanager-bash-guardrails") !== false;
		const checkEdit = editTool && pi.getFlag("middlemanager-edit-alignment") !== false;
		const checkGoal = pi.getFlag("middlemanager-goal-adherence") !== false;
		if (!checkBash && !checkEdit && !checkGoal) return undefined;
		const model = classifierFor(pi, ctx);
		const shadow = pi.getFlag("middlemanager-shadow") !== false;
		if (!model) {
			recordAudit(pi, { feature: "tool_gate", decision: shadow ? "shadow_no_classifier" : "abstain_no_classifier", tool: event.toolName });
			if (shadow) return undefined;
			const approved = ctx.hasUI && (await ctx.ui.confirm("Middlemanager has no classifier; allow this action?", toolSummary(event).slice(0, 1_000)));
			recordAudit(pi, { feature: "tool_gate", decision: approved ? "approved_by_user" : "blocked", userOverride: approved, tool: event.toolName });
			if (!approved) return { block: true, reason: "Middlemanager has no classifier; explicit user approval is required" };
			pendingToolOutcomes.set(event.toolCallId, { feature: "tool_gate", tool: event.toolName });
			return undefined;
		}

		const questions: Record<string, ClassifierQuestion> = {};
		if (checkBash || checkEdit) {
			questions.action_risk = {
				type: "choice",
				instructions: "Rate the operational risk of the proposed tool action.",
				criteria: { low: "Reversible and local", review: "Unclear or externally visible", high: "Destructive or difficult to reverse" },
			};
		}
		if (checkGoal) {
			questions.goal_alignment = {
				type: "score",
				instructions: "Rate whether this action advances the user's stated objective without expanding scope.",
				criteria: ["conflicts", "weakly related", "aligned"],
			};
		}
		if (checkEdit) {
			questions.edit_alignment = {
				type: "score",
				instructions: "Rate whether this proposed edit is semantically aligned with the objective and requested scope.",
				criteria: ["conflicts", "weakly related", "aligned"],
			};
		}

		const answers = await classifyHeads(pi, ctx, model, "tool_gate", {
			objective,
			phase: "tool_call",
			tool: event.toolName,
			proposal: toolSummary(event),
		}, questions);
		const review = requiresReview(answers);
		if (shadow) {
			recordAudit(pi, { feature: "tool_gate", decision: review ? "shadow_would_escalate" : "shadow_allow", tool: event.toolName });
			pendingToolOutcomes.set(event.toolCallId, { feature: "tool_gate", tool: event.toolName });
			return undefined;
		}
		if (!review) {
			recordAudit(pi, { feature: "tool_gate", decision: "allow", tool: event.toolName });
			pendingToolOutcomes.set(event.toolCallId, { feature: "tool_gate", tool: event.toolName });
			return undefined;
		}
		const approved = ctx.hasUI && (await ctx.ui.confirm("Review proposed tool action", toolSummary(event).slice(0, 1_000)));
		recordAudit(pi, {
			feature: "tool_gate",
			decision: approved ? "approved_by_user" : "blocked",
			userOverride: approved,
			tool: event.toolName,
		});
		if (!approved) return { block: true, reason: "Middlemanager abstained; explicit user approval is required" };
		pendingToolOutcomes.set(event.toolCallId, { feature: "tool_gate", tool: event.toolName });
		return undefined;
	});

	pi.on("tool_result", (event) => {
		const pending = pendingToolOutcomes.get(event.toolCallId);
		if (!pending) return undefined;
		pendingToolOutcomes.delete(event.toolCallId);
		recordAudit(pi, {
			feature: pending.feature,
			decision: event.isError ? "tool_error" : "tool_succeeded",
			tool: pending.tool,
			toolCallId: event.toolCallId,
		});
		return undefined;
	});

	pi.registerTool({
		name: "middlemanager_choose",
		label: "Bounded decision",
		description:
			"Assess a bounded user decision. Only reversible, low-consequence choices can be selected automatically; otherwise ask the user.",
		parameters: BoundedChoiceParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const model = classifierFor(pi, ctx);
			const answers = model
				? await classifyHeads(
						pi,
						ctx,
						model,
						"bounded_choice",
						{
							objective,
							phase: "user_choice",
							question: redactText(params.question, 1_000),
							options: params.options
								.map((option) => `${option.id}: ${redactText(option.description, 500)}`)
								.join("\n"),
						},
						{
							decision: {
								type: "choice",
								instructions: "Choose the option best supported by the user's stated preference and task context.",
								criteria: Object.fromEntries(params.options.map((option) => [option.id, option.description])),
							},
						},
					)
				: undefined;
			const selected = chooseBoundedOption(answers?.decision, params.options, params.reversible, params.consequence);
			const automatic = selected !== undefined && pi.getFlag("middlemanager-autopilot") === true && pi.getFlag("middlemanager-shadow") === false;
			let output: { status: string; choice?: string; recommendation?: string; userOverride?: boolean };
			if (automatic) {
				output = { status: "selected", choice: selected };
			} else if (ctx.hasUI) {
				const labels = params.options.map((option) => `${option.id}: ${redactText(option.description, 300)}`);
				const selectedLabel = await ctx.ui.select(params.question, labels);
				const selectedOption = params.options.find(
					(option, index) => labels[index] === selectedLabel,
				);
				output = selectedOption
					? {
							status: "user_selected",
							choice: selectedOption.id,
							...(selected ? { recommendation: selected, userOverride: selected !== selectedOption.id } : {}),
						}
					: { status: "cancelled" };
			} else {
				output = { status: "ask_user", ...(selected ? { recommendation: selected } : {}) };
			}
			recordAudit(pi, {
				feature: "bounded_choice",
				decision: output.status,
				...(output.choice ? { choice: output.choice } : {}),
				...(output.recommendation ? { recommendation: output.recommendation } : {}),
				...(output.userOverride === undefined ? {} : { userOverride: output.userOverride }),
				consequence: params.consequence,
				reversible: params.reversible,
			});
			return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
		},
	});
}