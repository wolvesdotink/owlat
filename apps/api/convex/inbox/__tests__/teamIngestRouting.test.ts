/**
 * Team ingest, the Phase 1c pieces of it (ADR-0073).
 *
 * L5: the MTA's spam verdict reaches the Team Inbox row. Ingest
 * (`inboundIngest.ingestFromWebhook` → `receiveInboundMail` →
 * `receiveMessage`) records `mtaSpamVerdict` and `mtaSpamScore` as the adapter
 * read them off the authenticated delivery; an MTA that sends none stores them
 * absent. Whether the verdict ends the run is the security scan's switch
 * (agent/steps/security_scan/__tests__/callOrder.test.ts).
 */

import { convexTest, type TestConvex } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { beforeEach, describe, expect, it } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { expectScheduledFailure } from '../../__tests__/helpers/scheduledFailures';
import { enableFeatures } from '../../__tests__/factories';

// See receiveMessageAuth.test.ts: the `../../**` glob omits the `inbox/` dir it
// climbed through, so merge a second glob rooted at `inbox/` and re-prefix its keys.
const rootGlob = import.meta.glob('../../**/*.*s');
const inboxGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../inbox/'),
		mod,
	])
);
const modules = Object.fromEntries(
	Object.entries({ ...rootGlob, ...inboxGlob }).filter(
		([path]) => !path.includes('agent/walker') && !path.includes('agent/steps/index')
	)
);

// The stored row is the subject here, not the pipeline it schedules.
beforeEach(() => expectScheduledFailure('agent/walker:start'));

function mail(messageId: string, verdict: { mtaSpamVerdict?: 'spam'; mtaSpamScore?: number }) {
	return {
		from: 'Bob <bob@example.com>',
		to: 'inbox@example.com',
		subject: 'subject',
		textBody: 'body',
		headers: {},
		messageId,
		attachments: [],
		timestamp: Date.now(),
		...verdict,
	};
}

async function rowFor(t: TestConvex<typeof schema>, messageId: string) {
	return t.run((ctx) =>
		ctx.db
			.query('inboundMessages')
			.withIndex('by_message_id', (q) => q.eq('messageId', messageId))
			.first()
	);
}

describe('Team ingest records the MTA spam verdict (L5)', () => {
	it('stores the verdict and score the delivery carried', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);

		await t.action(internal.inbox.inboundIngest.ingestFromWebhook, {
			mail: mail('<verdict-1@example.com>', { mtaSpamVerdict: 'spam', mtaSpamScore: 14 }),
		});

		const row = await rowFor(t, '<verdict-1@example.com>');
		expect(row?.mtaSpamVerdict).toBe('spam');
		expect(row?.mtaSpamScore).toBe(14);
		// Recorded, not acted on: ingest still hands the message to the pipeline.
		expect(row?.processingStatus).toBe('received');
	});

	it('stores them absent when the MTA sent none', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);

		await t.action(internal.inbox.inboundIngest.ingestFromWebhook, {
			mail: mail('<verdict-2@example.com>', {}),
		});

		const row = await rowFor(t, '<verdict-2@example.com>');
		expect(row).not.toBeNull();
		expect(row?.mtaSpamVerdict).toBeUndefined();
		expect(row?.mtaSpamScore).toBeUndefined();
	});
});

/**
 * M2 (ADR-0073): outcome sentiment keeps its own consumer policy. A reply that
 * reply generation suppresses (here: automated mail) still schedules the
 * outcome classifier, which re-checks inside that the reply answers an
 * auto-sent message. Reply-generation suppression must not be applied to it.
 */
describe('outcome sentiment keeps its own consumer policy (M2)', () => {
	it('is scheduled for a reply whose own pipeline run is suppressed', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai.agent']);

		await t.mutation(internal.inbox.messages.receiveMessage, {
			from: 'Alice <alice@customer.example>',
			to: 'support@org.example',
			subject: 'Re: your answer',
			textBody: 'This did not help at all.',
			headers: JSON.stringify({ 'Auto-Submitted': 'auto-replied' }),
			messageId: '<reply-1@customer.example>',
			inReplyTo: '<agent-1@org.example>',
			timestamp: Date.now(),
		});

		const scheduled = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
		const names = scheduled.map((f) => f.name);
		expect(
			names.some((n) => n.includes('outcomeFeedback') && n.includes('classifyReplyOutcome'))
		).toBe(true);
		// The reply itself is not handed to the agent pipeline.
		expect(names.some((n) => n.includes('walker'))).toBe(false);
	});
});
