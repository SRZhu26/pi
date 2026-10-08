import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import { createSweBenchLiteTaskSet, SWE_BENCH_LITE_SOURCE } from "./middlemanager-experiment.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_HF_ENDPOINT = "https://hf-mirror.com";
const SAFE_COLUMNS = ["instance_id", "repo", "base_commit", "problem_statement", "version", "environment_setup_commit"];

function parseOutputPath(args: readonly string[]): string {
	if (args.length !== 2 || args[0] !== "--output" || !args[1]) {
		throw new Error("Usage: eval:middlemanager:dataset -- --output <task-set.json>");
	}
	return resolve(packageRoot, args[1]);
}

const outputPath = parseOutputPath(process.argv.slice(2));
const endpoint = new URL(process.env.HF_ENDPOINT?.trim() || DEFAULT_HF_ENDPOINT);
if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
	throw new TypeError("HF_ENDPOINT must use HTTP or HTTPS.");
}
const artifactUrl = new URL(
	`datasets/${SWE_BENCH_LITE_SOURCE.dataset}/resolve/${SWE_BENCH_LITE_SOURCE.revision}/data/test-00000-of-00001.parquet`,
	`${endpoint.toString().replace(/\/+$/, "")}/`,
);
const response = await fetch(artifactUrl, { signal: AbortSignal.timeout(60_000) });
if (!response.ok) {
	throw new Error(`SWE-bench Lite mirror returned ${response.status} for the pinned test artifact.`);
}
const file = await response.arrayBuffer();
const rows = await parquetReadObjects({ file, columns: SAFE_COLUMNS, compressors });
const taskSet = createSweBenchLiteTaskSet(rows, rows.length);
const serialized = `${JSON.stringify(taskSet, null, 2)}\n`;
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, serialized);
console.log(`Task set: ${outputPath}`);
console.log(`Instances: ${taskSet.tasks.length}`);
console.log(`Task-set SHA-256: ${createHash("sha256").update(serialized).digest("hex")}`);
