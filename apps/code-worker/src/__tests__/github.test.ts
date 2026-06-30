import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * github.ts wraps `@octokit/rest`. We mock the SDK so no network is touched and
 * we can assert (a) the exact request shape handed to `pulls.create`, (b) that
 * the returned `html_url` is propagated, and (c) the `GITHUB_TOKEN` guard.
 *
 * The module lazily constructs and caches a single Octokit instance keyed off
 * `process.env.GITHUB_TOKEN` at first use, so each test resets the module
 * registry and re-imports to get a clean singleton + env read.
 */

// Hoisted mock state, shared between the vi.mock factory and the tests.
const mocks = vi.hoisted(() => {
	const create = vi.fn();
	const OctokitCtor = vi.fn();
	return { create, OctokitCtor };
});

vi.mock('@octokit/rest', () => ({
	Octokit: class {
		auth: unknown;
		pulls = { create: mocks.create };
		constructor(opts: { auth: string }) {
			// Record construction so we can assert the token was passed through.
			mocks.OctokitCtor(opts);
			this.auth = opts.auth;
		}
	},
}));

const PR_DETAILS = {
	owner: 'acme',
	repo: 'widgets',
	title: 'Add feature',
	body: 'This PR adds a feature.',
	head: 'code-worker/task-1',
	base: 'main',
};

describe('createPullRequest', () => {
	const ORIGINAL_TOKEN = process.env.GITHUB_TOKEN;

	beforeEach(() => {
		vi.resetModules();
		mocks.create.mockReset();
		mocks.OctokitCtor.mockReset();
		process.env.GITHUB_TOKEN = 'ghp_test_token';
	});

	afterEach(() => {
		if (ORIGINAL_TOKEN === undefined) {
			delete process.env.GITHUB_TOKEN;
		} else {
			process.env.GITHUB_TOKEN = ORIGINAL_TOKEN;
		}
	});

	it('sends the exact PR request shape and returns the html_url', async () => {
		mocks.create.mockResolvedValue({
			data: { html_url: 'https://github.com/acme/widgets/pull/42' },
		});

		const { createPullRequest } = await import('../github.js');
		const url = await createPullRequest(PR_DETAILS);

		// The Octokit client is constructed with the token from the environment.
		expect(mocks.OctokitCtor).toHaveBeenCalledTimes(1);
		expect(mocks.OctokitCtor).toHaveBeenCalledWith({ auth: 'ghp_test_token' });

		// pulls.create receives exactly the six fields from PRDetails, nothing more.
		expect(mocks.create).toHaveBeenCalledTimes(1);
		expect(mocks.create).toHaveBeenCalledWith({
			owner: 'acme',
			repo: 'widgets',
			title: 'Add feature',
			body: 'This PR adds a feature.',
			head: 'code-worker/task-1',
			base: 'main',
		});

		expect(url).toBe('https://github.com/acme/widgets/pull/42');
	});

	it('caches the Octokit client across calls (constructed once)', async () => {
		mocks.create.mockResolvedValue({
			data: { html_url: 'https://github.com/acme/widgets/pull/1' },
		});

		const { createPullRequest } = await import('../github.js');
		await createPullRequest(PR_DETAILS);
		await createPullRequest({ ...PR_DETAILS, title: 'Second' });

		expect(mocks.OctokitCtor).toHaveBeenCalledTimes(1);
		expect(mocks.create).toHaveBeenCalledTimes(2);
	});

	it('throws when GITHUB_TOKEN is not set and never constructs a client', async () => {
		delete process.env.GITHUB_TOKEN;

		const { createPullRequest } = await import('../github.js');

		await expect(createPullRequest(PR_DETAILS)).rejects.toThrow(
			'GITHUB_TOKEN environment variable is required',
		);
		expect(mocks.OctokitCtor).not.toHaveBeenCalled();
		expect(mocks.create).not.toHaveBeenCalled();
	});

	it('propagates errors from the GitHub API (e.g. duplicate PR / auth failure)', async () => {
		mocks.create.mockRejectedValue(new Error('Validation Failed: pull request already exists'));

		const { createPullRequest } = await import('../github.js');

		await expect(createPullRequest(PR_DETAILS)).rejects.toThrow(
			'Validation Failed: pull request already exists',
		);
		expect(mocks.create).toHaveBeenCalledTimes(1);
	});
});
