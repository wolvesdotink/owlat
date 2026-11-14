/**
 * Register a sending domain as verified. Every non-campaign send (automation
 * steps, agent replies, team follow-ups) is refused unless its From address
 * is on a verified sending domain, so a suite that sends from
 * `noreply@example.com` registers `example.com` first.
 */
import type { TestConvex } from 'convex-test';
import type schema from '../../schema';
import { createTestDomain } from '../factories';

export async function verifySendingDomain(
	t: TestConvex<typeof schema>,
	domain = 'example.com'
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert(
			'domains',
			createTestDomain({ domain, status: 'verified', lastVerifiedAt: Date.now() })
		);
	});
}
