import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionCtx } from '../../_generated/server';

const { enqueueGovernedTestEmail } = await import('../testSend');

const runMutation = vi.fn();
const ctx = { runMutation } as unknown as ActionCtx;
const params = {
	to: 'member@example.com',
	from: 'Owlat <sender@example.org>',
	replyTo: 'reply@example.org',
	subject: '[TEST] Hello',
	html: '<p>Hello</p>',
};

describe('campaign and template test-send routing', () => {
	beforeEach(() => runMutation.mockReset());

	it('creates a durable test Send and queues the normal governed worker path', async () => {
		runMutation.mockResolvedValue({ sendId: 'test-send-1' });

		const result = await enqueueGovernedTestEmail(ctx, params, 'org-1');
		expect(result).toEqual({ sendId: 'test-send-1' });
		expect(result).not.toHaveProperty('result');
		expect(runMutation).toHaveBeenCalledWith(expect.anything(), {
			email: params.to,
			organizationId: 'org-1',
			from: params.from,
			replyTo: params.replyTo,
			subject: params.subject,
			html: params.html,
		});
	});
});
