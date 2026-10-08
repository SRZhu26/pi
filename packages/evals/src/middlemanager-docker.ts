import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import type { ExperimentCase } from "./middlemanager-experiment.ts";
import type { MiddlemanagerProtocol, MiddlemanagerRunExecutor, MiddlemanagerObservation } from "./middlemanager-runner.ts";

const execFileAsync = promisify(execFile);

export type MiddlemanagerDockerOptions = {
	image: string;
	piRoot: string;
	artifactRoot: string;
	cliPath: string;
	llamaBaseUrl: string;
	dockerBinary?: string;
	timeoutMs?: number;
};

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function taskFor(protocol: MiddlemanagerProtocol, instanceId: string): ExperimentCase {
	const task = protocol.cases.find((candidate) => candidate.instanceId === instanceId);
	if (!task) throw new Error(`Task ${instanceId} is not present in the protocol.`);
	return task;
}

function runDirectory(root: string, task: { instanceId: string; armId: string; repetition: number }): string {
	return join(root, task.instanceId, task.armId, `repetition-${task.repetition}`);
}

export function createDockerExecutor(options: MiddlemanagerDockerOptions): MiddlemanagerRunExecutor {
	return async (planned, protocol): Promise<MiddlemanagerObservation> => {
		const task = taskFor(protocol, planned.instanceId);
		const launch = protocol.launchConfigByArm[planned.armId];
		if (!launch) throw new Error(`Launch configuration is missing for ${planned.armId}.`);
		const directory = runDirectory(options.artifactRoot, planned);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const inputPath = join(directory, "worker-input.json");
		const workerPath = join(directory, "worker.json");
		const patchPath = join(directory, "patch.diff");
		const stdoutPath = join(directory, "docker.stdout.log");
		const stderrPath = join(directory, "docker.stderr.log");
		const taskPath = "/work/task-repo";
		const environment = {
			...launch.environment,
			PI_MODEL_BASE_URL: protocol.modelConfiguration.baseUrl as string,
			LLAMA_BASE_URL: options.llamaBaseUrl,
			NO_PROXY: [launch.environment.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(","),
			no_proxy: [launch.environment.no_proxy, "127.0.0.1", "localhost"].filter(Boolean).join(","),
		};
		await writeFile(
			inputPath,
			`${JSON.stringify(
				{
					outputFile: "/artifacts/worker.json",
					cliPath: options.cliPath,
					cwd: taskPath,
					args: launch.args,
					environment,
					prompt: task.prompt,
					timeoutMs: options.timeoutMs ?? 3_600_000,
				},
				 null,
			)}\n`,
		);
		const envArgs = Object.entries(environment).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
		const command = [
			"set -eu",
			`rm -rf ${taskPath}`,
			`git clone --quiet ${shellQuote(`https://github.com/${task.repo}.git`)} ${taskPath}`,
			`cd ${taskPath}`,
			`git checkout --quiet ${shellQuote(task.baseCommit)}`,
			`mkdir -p /tmp/pi-agent /artifacts`,
			`node --experimental-strip-types /opt/pi/packages/evals/src/middlemanager-pi-worker.ts /artifacts/worker-input.json`,
			`git diff --binary --no-ext-diff > /artifacts/patch.diff`,
		].join("; ");
		const args = [
			"run",
			"--rm",
			"--network",
			"host",
			"--cpus",
			"3",
			...envArgs,
			"-v",
			`${directory}:/artifacts",
			options.image,
			"bash",
			"-lc",
			command,
		];
		try {
			const result = await execFileAsync(options.dockerBinary ?? "docker", args, {
				maxBuffer: 4 * 1024 * 1024,
				timeout: options.timeoutMs ?? 3_600_000,
			});
			await writeFile(stdoutPath, result.stdout);
			await writeFile(stderrPath, result.stderr);
		} catch (error) {
			const failure = error as { stdout?: string; stderr?: string; message?: string };
			await writeFile(stdoutPath, failure.stdout ?? "");
			await writeFile(stderrPath, failure.stderr ?? failure.message ?? String(error));
			throw new Error(`Docker task ${planned.instanceId}/${planned.armId} failed: ${failure.message ?? String(error)}`);
		}
		const worker = JSON.parse(await readFile(workerPath, "utf8")) as Record<string, unknown>;
		const patch = await readFile(patchPath, "utf8");
		const patchProduced = patch.trim().length > 0;
		const { status: workerStatus, error: workerError, ...metrics } = worker;
		return {
			...planned,
			status: workerStatus === "completed" ? "completed" : "errored",
			metrics: { ...metrics, patchProduced, patchBytes: patch.length, resolved: null },
			artifacts: { directory, patch: patchPath, worker: workerPath, stdout: stdoutPath, stderr: stderrPath },
			...(typeof workerError === "string" ? { error: workerError } : {}),
		};
	};
}

export async function assertDockerAvailable(dockerBinary = "docker"): Promise<void> {
	await execFileAsync(dockerBinary, ["version"], { maxBuffer: 1024 * 1024 });
}