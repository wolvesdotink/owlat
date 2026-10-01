import { Octokit } from '@octokit/rest';

let octokit: Octokit | null = null;

function getOctokit(): Octokit {
	if (!octokit) {
		const token = process.env['GITHUB_TOKEN'];
		if (!token) {
			throw new Error('GITHUB_TOKEN environment variable is required');
		}
		octokit = new Octokit({ auth: token });
	}
	return octokit;
}

export interface PRDetails {
	owner: string;
	repo: string;
	title: string;
	body: string;
	head: string;
	base: string;
}

/**
 * Create a pull request via the GitHub API.
 * Returns the PR URL.
 */
export async function createPullRequest(details: PRDetails): Promise<string> {
	const gh = getOctokit();

	const { data: pr } = await gh.pulls.create({
		owner: details.owner,
		repo: details.repo,
		title: details.title,
		body: details.body,
		head: details.head,
		base: details.base,
	});

	return pr.html_url;
}

/**
 * Find the pull request already opened from `head` into `base`, newest first,
 * in any state. Returns its URL, or null when there is none.
 *
 * A task's branch is derived from its id, so a PR from it can only be this
 * task's: finding one binds the existing artifact instead of opening a
 * duplicate after a response was lost.
 */
export async function findPullRequest(
	details: Pick<PRDetails, 'owner' | 'repo' | 'head' | 'base'>
): Promise<string | null> {
	const gh = getOctokit();

	const { data: prs } = await gh.pulls.list({
		owner: details.owner,
		repo: details.repo,
		head: `${details.owner}:${details.head}`,
		base: details.base,
		state: 'all',
		sort: 'created',
		direction: 'desc',
		per_page: 1,
	});

	return prs[0]?.html_url ?? null;
}
