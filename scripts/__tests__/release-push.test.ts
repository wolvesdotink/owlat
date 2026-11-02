import { expect, it } from 'vitest';
import type { Run } from '../ci/reuse';
import { pushCandidate } from '../release-push';

const run = { id: 7, run_attempt: 1, html_url: 'https://example.test/runs/7' } as Run;

function recorder(evidence: () => Promise<{ run?: Run; reason?: string }>) {
	const calls: string[] = [];
	const deps = {
		git: (...args: string[]) => {
			calls.push(args.join(' '));
			return args[0] === 'rev-parse' ? 'abc123' : '';
		},
		evidence: async (sha: string) => {
			calls.push(`evidence ${sha}`);
			return evidence();
		},
	};
	return { calls, deps };
}

it('pushes the tag only after main CI of its exact commit passed', async () => {
	const { calls, deps } = recorder(async () => ({ run }));
	await expect(pushCandidate('v1.2.3-rc.1', deps)).resolves.toEqual({ pushed: true, run });
	expect(calls).toEqual([
		'rev-parse refs/tags/v1.2.3-rc.1^{commit}',
		'push --no-follow-tags origin abc123:refs/heads/main',
		'evidence abc123',
		'push origin refs/tags/v1.2.3-rc.1',
	]);
});

it('keeps the tag local when no reusable main evidence turns up', async () => {
	const { calls, deps } = recorder(async () => ({ reason: 'No qualifying main run' }));
	await expect(pushCandidate('v1.2.3-rc.1', deps)).resolves.toEqual({
		pushed: false,
		reason: 'No qualifying main run',
	});
	expect(calls).not.toContain('push origin refs/tags/v1.2.3-rc.1');
});

it('keeps the tag local when main CI failed', async () => {
	const { calls, deps } = recorder(async () => {
		throw new Error('Main CI failed: https://example.test/runs/7');
	});
	await expect(pushCandidate('v1.2.3-rc.1', deps)).rejects.toThrow('Main CI failed');
	expect(calls).not.toContain('push origin refs/tags/v1.2.3-rc.1');
});
