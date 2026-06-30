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
