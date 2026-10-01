import { setTimeout as sleep } from 'node:timers/promises';
import {
	getConvexClient,
	fn,
	type CodeWorkTask,
	type CodeTaskStopReason,
	type CodeTaskWorkerVerdict,
} from './convexClient.js';
import { createPullRequest, findPullRequest } from './github.js';
import {
	buildAddArgs,
	buildBranchName,
	buildCommitArgs,
	buildCommitMessage,
	buildHeadShaArgs,
	buildPushArgs,
	buildRemoteBranchArgs,
	buildStagedChangesArgs,
	defaultWorkspaceOps,
	removeWorkspace,
	runCodingAgent,
	runTests,
	setupWorkspace,
	taskRunnerConfigFromEnv,
	taskWorkspacePaths,
	type SandboxTaskOptions,
	type TaskRunnerConfig,
	type WorkspaceOps,
} from './taskRunner.js';
import {
	describeUnexpectedBranch,
	findOrCreatePullRequest,
	findPriorPublication,
	parseRemoteBranchSha,
	type PullRequestApi,
} from './publication.js';
import { log } from './log.js';

/**
 * One code task, end to end: claim → reconcile an earlier publication →
 * workspace → agent → change check → commit → tests → checkpoint → push → PR →
 * acknowledgement.
 *
 * Every step after the claim runs on behalf of one attempt. The backend refuses
 * a callback from an attempt that was cancelled or superseded, and a watch
 * polls the same verdict while the sandbox runs, so a cancel reaps the agent or
 * the tests at once and nothing after it reaches GitHub or moves the task.
 */

type ConvexLike = Pick<ReturnType<typeof getConvexClient>, 'query' | 'mutation'>;

/** How often a running attempt asks whether it is still the live one. */
const ATTEMPT_CHECK_MS = 5_000;

/**
 * Backoff for the final report (completion or failure). A transient backend
 * outage at that point must not strand the row; after the last retry the
 * poller owes a reclaim instead (see `createCodeTaskPoller`).
 */
const REPORT_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000] as const;

export interface ProcessTaskDeps {
	client?: ConvexLike;
	config?: TaskRunnerConfig;
	workspaceOps?: WorkspaceOps;
	runAgent?: (
		workDir: string,
		description: string,
		sandbox: SandboxTaskOptions
	) => Promise<{ success: boolean; output: string }>;
	runTests?: (
		workDir: string,
		sandbox: SandboxTaskOptions
	) => Promise<{ passed: boolean; output: string }>;
	/** Null disables PR handling; the default uses GitHub when it is configured. */
	pullRequests?: PullRequestApi | null;
	attemptCheckMs?: number;
	reportRetryDelaysMs?: readonly number[];
}

/**
 * `acknowledged` is false when the backend never received the run's final
 * report, which leaves the task `running`/`testing` until a reclaim.
 */
interface ProcessTaskOutcome {
	acknowledged: boolean;
}

/** Raised when the backend says this attempt no longer owns the task. */
class AttemptStopped extends Error {
	constructor(readonly reason: CodeTaskStopReason) {
		super(`Attempt stopped: ${reason}`);
	}
}

/**
 * Watch one attempt: poll the backend verdict on an interval and abort the
 * sandbox (through `signal`) the moment it turns.
 */
function watchAttempt(client: ConvexLike, taskId: string, attempt: number, intervalMs: number) {
	const controller = new AbortController();
	let stopReason: CodeTaskStopReason | undefined;
	const apply = (verdict: CodeTaskWorkerVerdict | null | undefined) => {
		if (verdict && !verdict.ok && !stopReason) {
			stopReason = verdict.reason;
			controller.abort();
		}
	};
	const check = () => client.query(fn.checkAttempt, { taskId, attempt });
	const timer = setInterval(() => {
		check().then(apply, (error: unknown) =>
			log(`Attempt check failed for ${taskId}: ${String(error)}`)
		);
	}, intervalMs);

	return {
		signal: controller.signal,
		/** Apply a callback's verdict; throws once the attempt is stopped. */
		accept(verdict?: CodeTaskWorkerVerdict | null) {
			apply(verdict);
			if (stopReason) throw new AttemptStopped(stopReason);
		},
		/** Ask the backend now, right before an external effect. */
		async confirm() {
			this.accept(await check());
		},
		dispose() {
			clearInterval(timer);
		},
	};
}

type AttemptWatch = ReturnType<typeof watchAttempt>;

async function withRetries<T>(call: () => Promise<T>, delaysMs: readonly number[]): Promise<T> {
	for (let retry = 0; ; retry++) {
		try {
			return await call();
		} catch (error) {
			const delay = delaysMs[retry];
			if (delay === undefined) throw error;
			log(`Backend report failed (${String(error)}); retrying in ${delay}ms`);
			await sleep(delay);
		}
	}
}

/**
 * Report a failed run to the backend and log what it decided.
 *
 * The retry ceiling and the backoff schedule live in the backend
 * (`codeWorkTasks.markFailed`), which either requeues the task behind a delay
 * or makes the failure terminal; the worker just picks the task up again on a
 * later poll once the window has elapsed. `terminal` is the worker's statement
 * that a retry cannot change the outcome — it is the only side that knows, and
 * an attempt costs a whole clone/agent/test cycle. `attempt` fences the report
 * to the run that makes it. The client is injectable so the reporting can be
 * unit-tested without a deployment.
 */
export async function reportTaskFailure(
	taskId: string,
	errorMessage: string,
	client: ConvexLike = getConvexClient(),
	options: { terminal?: boolean; attempt?: number } = {}
): Promise<void> {
	const outcome = await client.mutation(fn.markFailed, {
		taskId,
		errorMessage,
		...(options.terminal ? { terminal: true } : {}),
		...(options.attempt !== undefined ? { attempt: options.attempt } : {}),
	});
	if (outcome?.ignored) {
		log(`Task ${taskId}: failure report not applied (${outcome.ignored})`);
		return;
	}
	if (outcome?.retried) {
		const waitSeconds = Math.max(0, Math.round(((outcome.nextAttemptAt ?? 0) - Date.now()) / 1000));
		log(`Task ${taskId} failed on attempt ${outcome.attempts}; retrying in ~${waitSeconds}s`);
		return;
	}
	log(`Task ${taskId} failed permanently after ${outcome?.attempts ?? 0} attempt(s)`);
}

function githubPullRequests(config: TaskRunnerConfig): PullRequestApi | null {
	const { githubOwner: owner, githubRepo: repo } = config;
	if (!owner || !repo) return null;
	return {
		find: (head, base) => findPullRequest({ owner, repo, head, base }),
		create: (details) => createPullRequest({ owner, repo, ...details }),
	};
}

function buildPullRequestBody(
	description: string,
	testOutput: string,
	passed: boolean | undefined
): string {
	const verdict =
		passed === undefined
			? 'Test output of the run that produced this branch:'
			: passed
				? 'All tests passed.'
				: 'Some tests failed (see details below).';
	return [
		'## Summary',
		'',
		description,
		'',
		'## Test Results',
		'',
		verdict,
		'',
		'```',
		testOutput.slice(-1000),
		'```',
		'',
		'---',
		'Generated by Owlat code-worker',
	].join('\n');
}

/**
 * Process a single code work task end-to-end.
 */
export async function processTask(
	task: CodeWorkTask,
	deps: ProcessTaskDeps = {}
): Promise<ProcessTaskOutcome> {
	const client = deps.client ?? getConvexClient();
	const config = deps.config ?? taskRunnerConfigFromEnv();
	const ops = deps.workspaceOps ?? defaultWorkspaceOps;
	const runAgent =
		deps.runAgent ??
		((workDir, description, sandbox) =>
			runCodingAgent(workDir, description, undefined, undefined, sandbox));
	const runTaskTests =
		deps.runTests ?? ((workDir, sandbox) => runTests(workDir, undefined, undefined, sandbox));
	const pullRequests =
		deps.pullRequests === undefined ? githubPullRequests(config) : deps.pullRequests;
	const retryDelays = deps.reportRetryDelaysMs ?? REPORT_RETRY_DELAYS_MS;
	const taskId = task._id;
	const { workDir, homeDir } = taskWorkspacePaths(config.workspaceRoot, taskId);
	const branchName = buildBranchName(taskId);
	let attempt: number | undefined;
	let watch: AttemptWatch | undefined;

	/** Final failure report, retried; false when the backend never got it. */
	const fail = async (message: string, terminal = false): Promise<ProcessTaskOutcome> => {
		try {
			await withRetries(
				() => reportTaskFailure(taskId, message, client, { terminal, attempt }),
				retryDelays
			);
			return { acknowledged: true };
		} catch {
			log(`Failed to mark task ${taskId} as failed`);
			return { acknowledged: false };
		}
	};

	/** Final completion report, retried; the backend accepts a repeat. */
	const complete = async (
		prUrl: string,
		testResults: string | undefined
	): Promise<ProcessTaskOutcome> => {
		let verdict: CodeTaskWorkerVerdict;
		try {
			verdict = await withRetries(
				() =>
					client.mutation(fn.completeWithPR, {
						taskId,
						prUrl,
						attempt: attempt!,
						...(testResults !== undefined ? { testResults } : {}),
					}),
				retryDelays
			);
		} catch (error) {
			log(`Failed to record completion of task ${taskId} (${prUrl || 'no PR'}): ${String(error)}`);
			return { acknowledged: false };
		}
		if (!verdict.ok) {
			log(
				verdict.reason === 'cancelled'
					? `Task ${taskId} was cancelled while publishing; ${prUrl || branchName} is recorded on it`
					: `Task ${taskId} completion not applied (${verdict.reason})`
			);
			return { acknowledged: true };
		}
		log(`Task ${taskId} completed successfully${prUrl ? `: ${prUrl}` : ''}`);
		return { acknowledged: true };
	};

	const openPullRequest = async (testOutput: string, passed: boolean | undefined) => {
		if (!pullRequests) return '';
		log(`Creating PR for ${taskId}`);
		return await findOrCreatePullRequest(pullRequests, {
			title: `[code-worker] ${task.description.slice(0, 60)}`,
			body: buildPullRequestBody(task.description, testOutput, passed),
			head: branchName,
			base: config.baseBranch,
		});
	};

	try {
		// 1. Claim the task
		log(`Claiming task ${taskId}`);
		const claim = await client.mutation(fn.claim, { taskId });
		if (!claim?.claimed) {
			log(`Task ${taskId} already claimed, skipping`);
			return { acknowledged: true };
		}
		attempt = claim.attempt;
		watch = watchAttempt(client, taskId, attempt, deps.attemptCheckMs ?? ATTEMPT_CHECK_MS);

		// 2. Resume what an earlier attempt published. The first claim cannot have
		// published anything: the branch name is derived from this task's id.
		if (attempt > 1) {
			const prior = await findPriorPublication({
				branchName,
				baseBranch: config.baseBranch,
				checkpointSha: task.publishCommitSha,
				remoteBranchSha: () =>
					parseRemoteBranchSha(
						ops.git(buildRemoteBranchArgs(config.repoUrl, branchName), {
							encoding: 'utf-8',
							env: { ...process.env, ...config.gitAuthEnv },
						}) as string
					),
				pullRequests,
			});
			if (prior.kind === 'pull-request') {
				log(`Task ${taskId}: binding existing PR ${prior.prUrl}`);
				return await complete(prior.prUrl, task.testResults);
			}
			if (prior.kind === 'branch') {
				log(`Task ${taskId}: resuming publication of ${prior.commitSha} on ${branchName}`);
				await watch.confirm();
				return await complete(
					await openPullRequest(task.testResults ?? '', undefined),
					task.testResults
				);
			}
			if (prior.kind === 'unexpected') {
				return await fail(
					describeUnexpectedBranch(branchName, prior.remoteSha, prior.expectedSha),
					true
				);
			}
		}
		if (!claim.mayRunAgent) {
			const spent = `Publication of ${branchName} could not be confirmed and no attempts are left`;
			return await fail(spent, true);
		}

		// 3. Set up workspace & branch
		log(`Setting up workspace for ${taskId}`);
		setupWorkspace(taskId, config, ops);
		watch.accept(await client.mutation(fn.updateBranch, { taskId, branch: branchName, attempt }));

		// 4. Run coding agent. A cancel aborts `signal`, which reaps the sandbox.
		log(`Running coding agent for task: ${task.description}`);
		const agentResult = await runAgent(workDir, task.description, {
			homeDir,
			signal: watch.signal,
		});
		watch.accept();
		if (!agentResult.success) {
			return await fail(`Coding agent failed: ${agentResult.output.slice(0, 500)}`);
		}

		// 5. Stage everything, then ask whether the index differs from HEAD. Root
		// git reads the sandbox-owned working tree and writes only the root-owned
		// .git.
		ops.git(buildAddArgs(workDir), { stdio: 'inherit' });
		const staged = ops.git(buildStagedChangesArgs(workDir), { encoding: 'utf-8' }) as string;
		if (!staged) {
			// Deterministic: the agent finished and decided nothing needed changing,
			// so a retry reaches the same answer. Terminal, not requeued.
			return await fail('Coding agent produced no changes', true);
		}

		// 6. Commit changes. The commit message is built from the untrusted task
		// description and passed as a single `-m` argv element (shell:false).
		ops.git(buildCommitArgs(workDir, buildCommitMessage(task.description)), { stdio: 'inherit' });
		const commitSha = (ops.git(buildHeadShaArgs(workDir), { encoding: 'utf-8' }) as string).trim();

		// 7. Run tests
		log(`Running tests for ${taskId}`);
		watch.accept(await client.mutation(fn.markTesting, { taskId, attempt }));
		const testResult = await runTaskTests(workDir, { homeDir, signal: watch.signal });
		watch.accept();
		const testResults = testResult.output.slice(-2000);

		// 8. Checkpoint, then push. The checkpoint is also the last cancellation
		// check before anything leaves the worker. Auth is supplied through Git's
		// environment; the token was never written to workDir/.git/config. A plain
		// push: if the remote branch exists already it is rejected, and the next
		// attempt reconciles it instead of overwriting it.
		watch.accept(
			await client.mutation(fn.recordPublication, {
				taskId,
				attempt,
				branch: branchName,
				commitSha,
				testResults,
			})
		);
		log(`Pushing branch ${branchName}`);
		ops.git(buildPushArgs(workDir, branchName), {
			stdio: 'inherit',
			env: { ...process.env, ...config.gitAuthEnv },
		});

		// 9. Create (or find) the PR, then acknowledge it.
		await watch.confirm();
		const prUrl = await openPullRequest(testResult.output, testResult.passed);
		return await complete(prUrl, testResults);
	} catch (error) {
		if (error instanceof AttemptStopped) {
			log(`Task ${taskId} attempt ${attempt} stopped (${error.reason}); not reporting further`);
			return { acknowledged: true };
		}
		const errMsg = error instanceof Error ? error.message : String(error);
		log(`Task ${taskId} failed: ${errMsg}`);
		return await fail(errMsg.slice(0, 500));
	} finally {
		watch?.dispose();
		// Always reclaim the workspace and the scratch home. The per-task clone is
		// large and must never leak — regardless of success, failure, cancellation
		// or any early return above.
		removeWorkspace(workDir);
		removeWorkspace(homeDir);
	}
}

/**
 * One poll of the code-task queue, for the worker loop.
 *
 * When a run's final report never reached the backend, its row is still
 * `running`/`testing` and would otherwise wait for the next process start. The
 * poller then owes a reclaim and runs it before taking new work, once the
 * backend answers again. That is safe for the same reason the startup reclaim
 * is: one worker drains the queue one task at a time, and between tasks it
 * holds none. The reclaimed task is requeued and its next attempt reconciles
 * whatever the lost run published.
 */
export function createCodeTaskPoller(deps: ProcessTaskDeps = {}): () => Promise<void> {
	const resolved: ProcessTaskDeps = { ...deps, config: deps.config ?? taskRunnerConfigFromEnv() };
	let reclaimOwed = false;
	return async () => {
		const client = resolved.client ?? getConvexClient();
		if (reclaimOwed) {
			const { reclaimed } = await client.mutation(fn.reclaimStale, {});
			reclaimOwed = false;
			log(`Reclaimed ${reclaimed} unacknowledged code task(s)`);
		}

		const task = await client.query(fn.getNextQueued, {});
		if (!task) return;
		log(`Found queued task: ${task._id} — "${task.description.slice(0, 80)}"`);
		const outcome = await processTask(task, resolved);
		if (!outcome.acknowledged) reclaimOwed = true;
	};
}
