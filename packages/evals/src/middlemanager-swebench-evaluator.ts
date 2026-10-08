import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { readMiddlemanagerObservationLedger, readMiddlemanagerProtocol } from "./middlemanager-runner.ts";

const execFileAsync = promisify(execFile);
const values = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 1) {
	const argument = process.argv[index];
	const equals = argument.indexOf("=");
	const name = equals === -1 ? argument : argument.slice(0, equals);
	const value = equals === -1 ? process.argv[++index] : argument.slice(equals + 1);
	if (!value || !name.startsWith("--")) throw new Error(`Invalid or missing value for ${argument}.`);
	values.set(name, value);
}

const protocolPath = values.get("--protocol");
const ledgerPath = values.get("--ledger");
if (!protocolPath || !ledgerPath) throw new Error("Pass --protocol and --ledger.");
const protocol = await readMiddlemanagerProtocol(resolve(protocolPath));
const ledger = await readMiddlemanagerObservationLedger(resolve(ledgerPath), protocol);
const outputRoot = resolve(values.get("--output") ?? dirname(resolve(ledgerPath)), "official");
await mkdir(outputRoot, { recursive: true });
const predictionsByArm = new Map<string, Array<Record<string, string>>>();
for (const observation of ledger.observations) {
	const patchPath = observation.artifacts?.patch;
	const patch = patchPath ? await readFile(patchPath, "utf8").catch(() => "") : "";
	const predictions = predictionsByArm.get(observation.armId) ?? [];
	predictions.push({ instance_id: observation.instanceId, model_name_or_path: protocol.model, model_patch: patch });
	predictionsByArm.set(observation.armId, predictions);
}

const results: Record<string, unknown> = {};
for (const [armId, predictions] of predictionsByArm) {
	const predictionPath = resolve(outputRoot, `${armId}.json`);
	await writeFile(predictionPath, `${JSON.stringify(predictions, null, 2)}\n`);
	const runId = `middlemanager-${armId}-${protocol.protocolDigest.slice(0, 12)}`;
	const args = [
		"-m",
		"swebench.harness.run_evaluation",
		"--dataset_name",
		protocol.benchmark.dataset,
		"--predictions_path",
		predictionPath,
		"--max_workers",
		"1",
		"--run_id",
		runId,
	];
	try {
		const result = await execFileAsync(process.env.PYTHON ?? "python3", args, {
			cwd: outputRoot,
			maxBuffer: 8 * 1024 * 1024,
		});
		const resultPath = resolve(outputRoot, "logs", "evaluation", runId, "results.json");
		const official = await readFile(resultPath, "utf8").then((text) => JSON.parse(text)).catch(() => ({ stdout: result.stdout }));
		results[armId] = { runId, predictionPath, resultPath, official };
	} catch (error) {
		const failure = error as { stdout?: string; stderr?: string; message?: string };
		results[armId] = {
			runId,
			predictionPath,
			error: failure.message ?? String(error),
			stdout: failure.stdout ?? "",
			stderr: failure.stderr ?? "",
		};
	}
}
const outputPath = resolve(outputRoot, "results.json");
await writeFile(outputPath, `${JSON.stringify({ protocolDigest: protocol.protocolDigest, results }, null, 2)}\n`);
console.log(`Official results: ${outputPath}`);