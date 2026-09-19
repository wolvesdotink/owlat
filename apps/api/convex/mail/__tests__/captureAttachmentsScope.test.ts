/**
 * `captureAttachments` — who a captured file is scoped to, and which parts are
 * eligible to be captured at all.
 *
 * Proven here:
 *   · a sender with an existing contact scopes the file to that contact;
 *   · a soft-deleted (GDPR-erased) contact reads as absent, so the file is
 *     written org-general and the message is still captured — an unknown sender
 *     is never a reason to drop anything;
 *   · an unparseable From header lands org-general too;
 *   · a part over `MAX_AI_INGEST_ATTACHMENT_BYTES` is not indexed while a
 *     sibling under it in the same .eml is;
 *   · the `ATTACHMENT_COMPOSE_LIMITS.maxCount` cap still holds.
 *
 * The last two drive `captureAttachments` with a ctx whose `storage.store` and
 * `semanticFiles.ingest` are counted rather than executed: convex-test
 * mis-tracks transaction state across an action's sub-operations, so a second
 * `ctx.storage.store` inside one action throws "Write outside of transaction"
 * (still the case in 0.0.55). The AI-ingest budget charge and the contact
 * lookup run for real against the live components in every case.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { getFunctionName, type FunctionReference } from 'convex/server';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { ActionCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import {
	ATTACHMENT_COMPOSE_LIMITS,
	MAX_AI_INGEST_ATTACHMENT_BYTES,
} from '@owlat/shared/attachments';
import { captureAttachments } from '../deliveryPipeline/ingest';

const modules = import.meta.glob('../../**/*.*s');

function setupTest() {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

type IngestArgs = { filename: string; fileSize: number; contactIds?: Id<'contacts'>[] };

/** Build a multipart/mixed message whose leaves are the given text bodies. */
function buildEml(messageId: string, leaves: Array<{ name: string; body: string }>): string {
	const boundary = 'scope-b0undary';
	const lines = [
		'From: Bob <bob@example.com>',
		'To: inbox@example.com',
		`Subject: ${messageId}`,
		`Message-ID: <${messageId}>`,
		`Content-Type: multipart/mixed; boundary="${boundary}"`,
		'',
		`--${boundary}`,
		'Content-Type: text/plain; charset=utf-8',
		'',
		'Body text.',
		'',
	];
	for (const leaf of leaves) {
		lines.push(
			`--${boundary}`,
			`Content-Type: text/plain; name="${leaf.name}"`,
			`Content-Disposition: attachment; filename="${leaf.name}"`,
			'Content-Transfer-Encoding: base64',
			'',
			Buffer.from(leaf.body).toString('base64'),
			''
		);
	}
	lines.push(`--${boundary}--`, '');
	return lines.join('\r\n');
}

/**
 * Drive `captureAttachments` with a counting ctx. The contact lookup and the
 * AI-ingest budget are real; only the blob store and the `semanticFiles.ingest`
 * call are recorded.
 */
async function capture(
	t: ReturnType<typeof setupTest>,
	raw: string,
	messageId: string,
	fromRaw: string
): Promise<{ stored: number; ingested: IngestArgs[] }> {
	let stored = 0;
	const ingested: IngestArgs[] = [];
	await captureAttachments(
		{
			storage: {
				store: async () => `storage-${stored++}` as Id<'_storage'>,
			},
			runQuery: (async (ref: unknown, args: unknown) =>
				await t.query(
					ref as FunctionReference<'query', 'internal'>,
					args as Record<string, unknown>
				)) as unknown as ActionCtx['runQuery'],
			runMutation: (async (ref: unknown, args: unknown) => {
				if (
					getFunctionName(ref as FunctionReference<'mutation'>) ===
					getFunctionName(internal.semanticFiles.ingest)
				) {
					ingested.push(args as IngestArgs);
					return null;
				}
				return await t.mutation(
					ref as FunctionReference<'mutation', 'internal'>,
					args as Record<string, unknown>
				);
			}) as unknown as ActionCtx['runMutation'],
		},
		raw,
		messageId,
		fromRaw
	);
	return { stored, ingested };
}

async function seedContact(
	t: ReturnType<typeof setupTest>,
	email: string,
	options: { deleted?: boolean } = {}
): Promise<Id<'contacts'>> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		return await ctx.db.insert('contacts', {
			email,
			source: 'inbound',
			doiStatus: 'not_required',
			searchableText: email,
			createdAt: now,
			updatedAt: now,
			...(options.deleted ? { deletedAt: now } : {}),
		});
	});
}

describe('captureAttachments — contact scoping', () => {
	it('scopes a captured file to the sender contact when one exists', async () => {
		const t = setupTest();
		const contactId = await seedContact(t, 'bob@example.com');

		const { ingested } = await capture(
			t,
			buildEml('scope-1@example.com', [{ name: 'notes.txt', body: 'a real document' }]),
			'<scope-1@example.com>',
			'Bob <bob@example.com>'
		);

		expect(ingested).toHaveLength(1);
		expect(ingested[0]!.contactIds).toEqual([contactId]);
	});

	it('falls back to org-general when the sender contact was erased', async () => {
		const t = setupTest();
		// A soft-deleted contact is a gravestone: `getByEmailForTeam` filters it
		// out, so the sender reads as unknown — and unknown must still capture.
		await seedContact(t, 'bob@example.com', { deleted: true });

		const { ingested } = await capture(
			t,
			buildEml('scope-2@example.com', [{ name: 'notes.txt', body: 'a real document' }]),
			'<scope-2@example.com>',
			'Bob <bob@example.com>'
		);

		expect(ingested).toHaveLength(1);
		expect(ingested[0]!.contactIds).toBeUndefined();
	});

	it('falls back to org-general when the From header has no address in it', async () => {
		const t = setupTest();

		const { ingested } = await capture(
			t,
			buildEml('scope-3@example.com', [{ name: 'notes.txt', body: 'a real document' }]),
			'<scope-3@example.com>',
			'not an address at all'
		);

		expect(ingested).toHaveLength(1);
		expect(ingested[0]!.contactIds).toBeUndefined();
	});
});

describe('captureAttachments — eligibility ceilings', () => {
	it('skips a part over the AI-ingest ceiling while capturing its sibling under it', async () => {
		const t = setupTest();
		const oversized = 'x'.repeat(MAX_AI_INGEST_ATTACHMENT_BYTES + 1);

		const { ingested } = await capture(
			t,
			buildEml('ceiling-1@example.com', [
				{ name: 'huge.txt', body: oversized },
				{ name: 'small.txt', body: 'under the ceiling' },
			]),
			'<ceiling-1@example.com>',
			'Bob <bob@example.com>'
		);

		expect(ingested.map((f) => f.filename)).toEqual(['small.txt']);
		// The big part is not dropped from the message — it is only not indexed.
		// Its bytes stay in the raw .eml the reader downloads from.
		expect(ingested[0]!.fileSize).toBeLessThanOrEqual(MAX_AI_INGEST_ATTACHMENT_BYTES);
	});

	it('captures at most the per-message part cap', async () => {
		const t = setupTest();
		const leafCount = ATTACHMENT_COMPOSE_LIMITS.maxCount + 2;
		const leaves = Array.from({ length: leafCount }, (_, i) => ({
			name: `doc-${i}.txt`,
			body: `document number ${i}`,
		}));

		const { stored, ingested } = await capture(
			t,
			buildEml('cap-1@example.com', leaves),
			'<cap-1@example.com>',
			'Bob <bob@example.com>'
		);

		expect(stored).toBe(ATTACHMENT_COMPOSE_LIMITS.maxCount);
		expect(ingested).toHaveLength(ATTACHMENT_COMPOSE_LIMITS.maxCount);
	});
});
