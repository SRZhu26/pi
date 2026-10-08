import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readMiddlemanagerObservationLedger, readMiddlemanagerProtocol } from "./middlemanager-runner.ts";

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
const officialPath = values.get("--official");
if (!protocolPath || !ledgerPath || !officialPath) throw new Error("Pass --protocol, --ledger, and --official.");
const protocol = await readMiddlemanagerProtocol(resolve(protocolPath));
const ledger = await readMiddlemanagerObservationLedger(resolve(ledgerPath), protocol);
const official = JSON.parse(await readFile(resolve(officialPath), "utf8")) as {
	results?: Record<string, { official?: Record<string, unknown> }>;
};
const rows = protocol.arms.map((arm) => {
	const observations = ledger.observations.filter((observation) => observation.armId === arm.id);
	const officialResult = official.results?.[arm.id]?.official;
	const resolved = observations.filter((observation) => observation.metrics.resolved === true).length;
	const patches = observations.filter((observation) => observation.metrics.patchProduced === true).length;
	const errors = observations.filter((observation) => observation.status === "errored").length;
	return {
		arm: arm.id,
		features: arm.features.join(",") || "none",
		planned: protocol.cases.length * protocol.repetitions,
		observed: observations.length,
		patches,
		resolved,
		official: officialResult ?? null,
		errors,
	};
});
const outputPath = resolve(values.get("--output") ?? `${resolve(officialPath, "..")}/report.json`);
await writeFile(outputPath, `${JSON.stringify({ protocolDigest: protocol.protocolDigest, rows }, null, 2)}\n`);
console.log(["arm", "features", "planned", "observed", "patches", "resolved", "errors"].join("\t"));
for (const row of rows) console.log([row.arm, row.features, row.planned, row.observed, row.patches, row.resolved, row.errors].join("\t"));
console.log(`Report: ${outputPath}`);