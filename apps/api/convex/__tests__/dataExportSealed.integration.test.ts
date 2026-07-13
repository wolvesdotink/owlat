/**
 * Sealed Mail E8b — per-contact data export DECRYPTS bodies (named gate c).
 *
 * A GDPR data-subject access bundle must be READABLE, so `exportContactData`
 * decrypts the sealed-at-rest message bodies before returning them. This is the
 * one documented place plaintext leaves the store (the owner's own data). The
 * test seals the bodies at rest, exports, and asserts the bundle carries the
 * plaintext — never the `atrest:` envelope.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import { sealAtRest } from '../lib/atRestBodies';
import type { Id } from '../_generated/dataModel';

const SECRET = 'test-instance-secret-value-for-aes-256-gcm-kdf';
const CANARY = 'CANARY-body-plaintext-9f3a-do-not-leak';

vi.stubEnv('INSTANCE_SECRET', SECRET);

// `exportContactData` is an authedQuery gated on `organization:manage`. Mocking
// the session read alone would NOT intercept the intra-module callers that
// actually gate the query: `authedQuery`'s auth floor calls `requireOrgMember`
// and the handler calls `requireOrgPermission`, both of which reference the real
// `getBetterAuthSessionWithRole` via their own lexical binding (a partial mock
// does not rewrite intra-module calls). So admit the owner directly at those two
// choke points — the same shape the established session-mocked tests use
// (see externalAccounts.integration.test.ts).
vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
	};
});

const allModules = import.meta.glob('../**/*.*s');

describe('contacts.dataExport — sealed bodies decrypt on export (c)', () => {
	it('returns plaintext inbound and unified bodies, never the sealed envelope', async () => {
		const t = convexTest(schema, allModules);
		const now = Date.now();

		const inboundText = `${CANARY} inbound export text`;
		const unifiedText = `${CANARY} unified export text`;

		const contactId = await t.run(async (ctx): Promise<Id<'contacts'>> => {
			const cId = await ctx.db.insert('contacts', {
				email: 'person@example.com',
				source: 'api',
				doiStatus: 'not_required',
				createdAt: now,
				updatedAt: now,
			});

			await ctx.db.insert('inboundMessages', {
				messageId: '<in@example.com>',
				from: 'person@example.com',
				to: 'me@example.com',
				subject: 's',
				textBody: await sealAtRest(SECRET, inboundText),
				htmlBody: await sealAtRest(SECRET, `<p>${CANARY} html</p>`),
				processingStatus: 'received',
				receivedAt: now,
				contactId: cId,
			});

			const threadId = await ctx.db.insert('conversationThreads', {
				subject: 's',
				normalizedSubject: 's',
				contactIdentifier: 'person@example.com',
				status: 'open',
				messageCount: 1,
				lastMessageAt: now,
				firstMessageAt: now,
				createdAt: now,
			});
			await ctx.db.insert('unifiedMessages', {
				threadId,
				channel: 'email',
				direction: 'inbound',
				content: await sealAtRest(SECRET, JSON.stringify({ text: unifiedText })),
				status: 'received',
				createdAt: now,
				contactId: cId,
			});

			return cId;
		});

		const bundle = await t.query(api.contacts.dataExport.exportContactData, { contactId });

		const inbound = bundle.inboundMessages.rows[0];
		expect(inbound).toBeDefined();
		expect(inbound!.textBody).toBe(inboundText);
		expect(inbound!.textBody).not.toContain('atrest:');
		expect(inbound!.htmlBody).toContain(CANARY);

		const unified = bundle.unifiedMessages.rows[0];
		expect(unified).toBeDefined();
		expect(unified!.content).not.toContain('atrest:');
		expect(JSON.parse(unified!.content).text).toBe(unifiedText);
	});
});
