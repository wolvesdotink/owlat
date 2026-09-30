/**
 * #916 cost contract: every execution of the wizard's subscribed recipient
 * count, and every step of the exact-count job, has a FIXED read budget, and
 * the job's result equals what the send resolver delivers.
 *
 * Driven over the counting reader (`helpers/instrumentedReader.ts`) because
 * convex-test reports nothing about reads. Before #916 one execution of the
 * readout read ~55,000 documents for a 50,000-member topic (stopping at the
 * 25,000-candidate ceiling) and ~270,000 for a zero-match segment over 100,000
 * contacts, far past the per-execution limits. The fixtures here are smaller to
 * keep the suite fast; the assertions are that cost does not GROW with the
 * audience. Full-size numbers: `metrics/916.md` of the perf run.
 */

import { describe, expect, it } from 'vitest';
import type { QueryCtx } from '../../_generated/server';
import type { Doc } from '../../_generated/dataModel';
import type { StoredAudience } from '../audience';
import {
	countRecipientsForAudience,
	resolveRecipientPage,
	type RecipientCountReadout,
} from '../audienceResolution';
import { advanceAudienceCount, planAudienceCountJob } from '../audienceCountJob';
import { createInstrumentedReader, type ReadCounters } from './helpers/instrumentedReader';

/** Convex per-execution limits: documents read and index ranges opened. */
const LIMITS = { documents: 16_384, queries: 4_096 };

const ZERO_MATCH = {
	logic: 'AND' as const,
	conditions: [
		{ kind: 'contact_property', field: 'plan', operator: 'equals', value: 'enterprise' },
		{ kind: 'topic_membership', topicId: 'topics:news', operator: 'equals' },
	],
};

function seedAudience(count: number) {
	type Row = Record<string, unknown>;
	const contacts: Row[] = [];
	const contactPropertyValues: Row[] = [];
	const contactTopics: Row[] = [];
	const blockedEmails: Row[] = [];
	for (let i = 0; i < count; i++) {
		const id = `contacts:${i}`;
		contacts.push({
			_id: id,
			email: `Person${i}@Example.com`,
			doiStatus: i % 7 === 0 ? 'pending' : 'confirmed',
			...(i % 50 === 0 ? { unsubscribedAt: 1 } : {}),
			...(i % 97 === 0 ? { deletedAt: 1 } : {}),
		});
		contactPropertyValues.push({
			contactId: id,
			propertyId: 'contactProperties:plan',
			value: i % 2 === 0 ? 'pro' : 'free',
		});
		contactTopics.push({
			contactId: id,
			topicId: 'topics:news',
			...(i % 11 === 0 ? { pendingDoiConfirmation: true } : {}),
		});
		if (i % 20 === 0) blockedEmails.push({ email: `person${i}@example.com` });
	}
	for (let j = 0; j < 3_000; j++) blockedEmails.push({ email: `gone${j}@elsewhere.test` });
	return {
		topics: [{ _id: 'topics:news', name: 'News', requireDoubleOptIn: true }],
		contactProperties: [
			{ _id: 'contactProperties:plan', key: 'plan', label: 'Plan', type: 'text' },
		],
		segments: [{ _id: 'segments:zero', name: 'Zero', filters: ZERO_MATCH }],
		contacts,
		contactPropertyValues,
		contactTopics,
		blockedEmails,
	};
}

const TOPIC: StoredAudience = { kind: 'topic', topicId: 'topics:news' as never };
const SEGMENT: StoredAudience = { kind: 'segment', segmentId: 'segments:zero' as never };

type Reader = ReturnType<typeof createInstrumentedReader>;

async function readout(reader: Reader, audience: StoredAudience) {
	reader.reset();
	const result: RecipientCountReadout = await countRecipientsForAudience(
		{ db: reader.db } as unknown as QueryCtx,
		audience
	);
	return { result, cost: { ...reader.counters } };
}

function expectWithinLimits(cost: ReadCounters) {
	expect(cost.documents).toBeLessThanOrEqual(LIMITS.documents);
	expect(cost.queries).toBeLessThanOrEqual(LIMITS.queries);
}

/** Walk the job the way the step mutation does, one execution per step. */
async function runJob(reader: Reader, audience: StoredAudience) {
	const ctx = { db: reader.db } as unknown as QueryCtx;
	const planned = await planAudienceCountJob(ctx, audience);
	let job = {
		...planned!.fields,
		status: 'counting' as Doc<'audienceCountJobs'>['status'],
		cursor: '',
		total: 0,
		eligible: 0,
		pages: 0,
	};
	const steps: ReadCounters[] = [];
	for (;;) {
		reader.reset();
		const outcome = await advanceAudienceCount(ctx, job);
		steps.push({ ...reader.counters });
		if (outcome.kind === 'abandoned') throw new Error('abandoned');
		job = { ...job, ...outcome.patch };
		if (outcome.kind === 'complete') return { job, steps };
	}
}

/** What a send would resolve: every page of the real resolver. */
async function sendResolution(reader: Reader, audience: StoredAudience) {
	const handler = (
		resolveRecipientPage as unknown as {
			_handler: (
				ctx: unknown,
				args: { audience: StoredAudience; cursor: string }
			) => Promise<{ recipients: unknown[]; nextCursor: string | null; pageCandidates: number }>;
		}
	)._handler;
	let total = 0;
	let eligible = 0;
	let cursor = '';
	for (;;) {
		const page = await handler({ db: reader.db }, { audience, cursor });
		total += page.pageCandidates;
		eligible += page.recipients.length;
		if (page.nextCursor === null) return { total, eligible };
		cursor = page.nextCursor;
	}
}

describe('wizard recipient count — fixed cost per execution (#916)', () => {
	it.each([
		['topic', TOPIC],
		['zero-match segment', SEGMENT],
	] as const)('one %s readout costs the same at 3,000 and 12,000 contacts', async (_, audience) => {
		const small = await readout(createInstrumentedReader(seedAudience(3_000)), audience);
		const large = await readout(createInstrumentedReader(seedAudience(12_000)), audience);
		expectWithinLimits(large.cost);
		// One budgeted page, whatever the population behind it.
		expect(large.cost.documents).toBeLessThanOrEqual(small.cost.documents * 1.05);
		expect(large.cost.queries).toBeLessThanOrEqual(small.cost.queries * 1.05);
		// And the page is honest about stopping short.
		expect(large.result.completeness).toBe('read_budget_exhausted');
		expect(large.result.background).toEqual({ status: 'unavailable' });
	});

	it.each([
		['topic', TOPIC],
		['zero-match segment', SEGMENT],
	] as const)(
		'the %s job finishes in bounded steps with the send resolver’s exact count',
		async (_, audience) => {
			const reader = createInstrumentedReader(seedAudience(12_000));
			const { job, steps } = await runJob(reader, audience);
			for (const step of steps) expectWithinLimits(step);
			expect(steps.length).toBeGreaterThan(1);
			expect({ total: job.total, eligible: job.eligible }).toEqual(
				await sendResolution(reader, audience)
			);

			// With the result stored, the subscribed readout is a lookup, not a scan.
			reader.insert('audienceCountJobs', {
				...job,
				generation: 1,
				startedAt: 1,
				updatedAt: 2,
				completedAt: 2,
			} satisfies Omit<Doc<'audienceCountJobs'>, '_id' | '_creationTime'>);
			const served = await readout(reader, audience);
			expect(served.result).toMatchObject({
				total: job.total,
				eligible: job.eligible,
				completeness: 'exact',
				background: { status: 'complete', countedAt: 2 },
			});
			expect(served.cost.documents).toBeLessThanOrEqual(2);
		}
	);
});
