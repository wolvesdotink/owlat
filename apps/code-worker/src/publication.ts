/**
 * Publication reconciliation for code tasks.
 *
 * Publishing a task is a sequence of external effects (push the task branch,
 * open the PR, acknowledge it to the backend) and any step can fail after the
 * remote side already applied it. A retry therefore looks at what an earlier
 * attempt left behind before it regenerates anything: an existing PR is bound
 * to the task, a branch at the recorded checkpoint commit gets its PR, and a
 * branch at any other commit is left alone and reported. Nothing here pushes,
 * and nothing ever force-pushes.
 */

/** The GitHub side of publication, injectable for tests. */
export interface PullRequestApi {
	/** URL of the newest PR from `head` into `base`, in any state, or null. */
	find(head: string, base: string): Promise<string | null>;
	create(details: { title: string; body: string; head: string; base: string }): Promise<string>;
}

/** What an earlier attempt of the task left published. */
type PriorPublication =
	| { kind: 'none' }
	| { kind: 'pull-request'; prUrl: string }
	/** The remote branch is at the task's checkpoint commit; no PR yet. */
	| { kind: 'branch'; commitSha: string }
	/** The remote branch exists at a commit the task never recorded. */
	| { kind: 'unexpected'; remoteSha: string; expectedSha?: string };

/** First SHA in `git ls-remote` output, or null when the branch does not exist. */
export function parseRemoteBranchSha(output: string): string | null {
	const sha = output.trim().split(/\s+/)[0];
	return sha ? sha : null;
}

export async function findPriorPublication(input: {
	branchName: string;
	baseBranch: string;
	/** `publishCommitSha` the task recorded before an earlier push. */
	checkpointSha?: string;
	remoteBranchSha: () => string | null;
	/** Null when no GitHub repository is configured. */
	pullRequests: PullRequestApi | null;
}): Promise<PriorPublication> {
	const prUrl = await input.pullRequests?.find(input.branchName, input.baseBranch);
	if (prUrl) return { kind: 'pull-request', prUrl };

	const remoteSha = input.remoteBranchSha();
	if (!remoteSha) return { kind: 'none' };
	if (remoteSha === input.checkpointSha) return { kind: 'branch', commitSha: remoteSha };
	return { kind: 'unexpected', remoteSha, expectedSha: input.checkpointSha };
}

/**
 * Open the task's PR unless it already exists. When creation fails, look again
 * before giving up: GitHub may have created the PR and lost only the response,
 * or a concurrent attempt may have opened it.
 */
export async function findOrCreatePullRequest(
	api: PullRequestApi,
	details: { title: string; body: string; head: string; base: string }
): Promise<string> {
	const existing = await api.find(details.head, details.base);
	if (existing) return existing;
	try {
		return await api.create(details);
	} catch (error) {
		const created = await api.find(details.head, details.base).catch(() => null);
		if (created) return created;
		throw error;
	}
}

/** Failure text for a remote task branch this task cannot account for. */
export function describeUnexpectedBranch(
	branchName: string,
	remoteSha: string,
	expectedSha: string | undefined
): string {
	const expected = expectedSha
		? `the recorded commit ${expectedSha.slice(0, 12)}`
		: 'no recorded commit';
	return (
		`Remote branch ${branchName} is at ${remoteSha.slice(0, 12)}, but this task has ${expected}. ` +
		'The branch was left untouched: review it and open a pull request by hand, or create a new task.'
	);
}
