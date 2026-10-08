import { resolve } from "node:path";
import { executeMiddlemanagerProtocol, readMiddlemanagerProtocol } from "./middlemanager-runner.ts";
import { createDockerExecutor, assertDockerAvailable } from "./middlemanager-docker.ts";

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
if (!protocolPath) throw new Error("Pass --protocol <path>.");
const protocol = await readMiddlemanagerProtocol(resolve(protocolPath));
const artifactRoot = resolve(values.get("--artifacts") ?? ".eval/middlemanager/runs");
const image = values.get("--image") ?? "middlemanager-pi:node22";
const maxRuns = values.has("--max-runs") ? Number(values.get("--max-runs")) : Number.POSITIVE_INFINITY;
if (Number.isFinite(maxRuns) && (!Number.isSafeInteger(maxRuns) || maxRuns < 1)) {
	throw new Error("--max-runs must be a positive integer.");
}
const llamaBaseUrl = values.get("--llama-base-url") ?? process.env.LLAMA_BASE_URL ?? "http://127.0.0.1:8080";
await assertDockerAvailable();
const execute = createDockerExecutor({
	image,
	artifactRoot,
	piRoot: resolve("."),
	cliPath: "/opt/pi/packages/coding-agent/dist/bundle/cli.js",
	llamaBaseUrl,
});
const ledgerPath = resolve(values.get("--ledger") ?? `${artifactRoot}/observations.json`);
const ledger = await executeMiddlemanagerProtocol(protocol, ledgerPath, execute, {
	...(Number.isFinite(maxRuns) ? { maxRuns } : {}),
	onObservation: (observation) => {
		console.log(`${observation.instanceId} ${observation.armId} repetition=${observation.repetition} ${observation.status}`);
	},
});
console.log(`Ledger: ${ledgerPath}`);
console.log(`Observations: ${ledger.observations.length}/${protocol.tasks.length}`);