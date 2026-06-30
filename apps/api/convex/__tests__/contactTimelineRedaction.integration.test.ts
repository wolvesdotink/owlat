import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';

// ADR-0040 (docs/adr/0040-shared-inbox-admin-only.md): inbound shared-inbox email
// CONTENT is owner/admin-only. The same bodies are mirrored into unifiedMessages
// (inbox/messages.ts recordInboundMirror) and surface in the contact timeline, so
// getTimeline must withhold the inbound *email* body from non-admin members while
// keeping the row + its subject/metadata. These tests drive that gate by varying
// the soft role read (getBetterAuthSessionWithRole) the handler performs.

// `role` is flipped per-test. We mock both the membership floor (requireOrgMember,
// which authedQuery calls) so an 'editor' still passes as a member and receives the
// timeline, AND the handler's own soft role read (getBetterAuthSessionWithRole),
// which decides whether the inbound-email body is redacted. An 'editor' lacks
// `organization:manage`, so its body must be withheld.
let currentRole: 'owner' | 'admin' | 'editor' = 'owner';

vi.mock('../lib/sessionOrganization', async () => {
	const actual =
		await vi.importActual<typeof import('../lib/sessionOrganization')>(
			'../lib/sessionOrganization',
		);
	return {
		...actual,
		requireOrgMember: vi.fn(async () => ({ userId: 'test-user', role: currentRole })),
		getBetterAuthSessionWithRole: vi.fn(async () => ({
			userId: 'test-user',
			activeOrganizationId: 'org-1',
			role: currentRole,
		})),
	};
});

const modules = import.meta.glob('../**/*.*s');

const testIdentity = {
	subject: 'test-user',
	issuer: 'https://test.issuer.com',
	tokenIdentifier: 'https://test.issuer.com|test-user',
};

interface TimelineContent {
	text?: string;
	html?: string;
	subject?: string;
	redacted?: boolean;
}
type MessageRow = {
	type: 'message';
	timestamp: number;
	data: {
		_id: string;
		channel: string;
		direction: string;
		content: TimelineContent;
		status: string;
	};
};
type TimelineRow = { type: string; data: { _id: string } };

const INBOUND_BODY = 'Confidential customer reply — account number 12345.';
const INBOUND_SUBJECT = 'Re: my order';
const SMS_BODY = 'Inbound SMS text that stays visible';

async function seed(t: ReturnType<typeof convexTest>) {
	return t.run(async (ctx) => {
		const contactId = await ctx.db.insert('contacts', {
			email: 'cust@x.com',
			source: 'api' as const,
			doiStatus: 'not_required' as const,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		const threadId = await ctx.db.insert('conversationThreads', {
			subject: INBOUND_SUBJECT,
			normalizedSubject: 'my order',
			contactId,
			contactIdentifier: 'cust@x.com',
			status: 'open' as const,
			messageCount: 2,
			lastMessageAt: 2_000,
			firstMessageAt: 1_000,
			createdAt: Date.now(),
		});

		// Inbound shared-inbox email (mirrored shape from recordInboundMirror).
		const emailRowId = await ctx.db.insert('unifiedMessages', {
			threadId,
			channel: 'email' as const,
			direction: 'inbound' as const,
			contactId,
			content: JSON.stringify({ text: INBOUND_BODY, subject: INBOUND_SUBJECT }),
			status: 'received' as const,
			createdAt: 2_000,
		});
		// Inbound non-email row — must stay fully visible regardless of role.
		const smsRowId = await ctx.db.insert('unifiedMessages', {
			threadId,
			channel: 'sms' as const,
			direction: 'inbound' as const,
			contactId,
			content: JSON.stringify({ text: SMS_BODY }),
			status: 'received' as const,
			createdAt: 1_000,
		});

		return { contactId, emailRowId, smsRowId };
	});
}

function messageRows(rows: TimelineRow[]): MessageRow[] {
	return rows.filter((r): r is MessageRow => r.type === 'message');
}

describe('getTimeline inbound-email redaction (ADR-0040)', () => {
	it('shows the inbound email body to an owner/admin', async () => {
		const t = convexTest(schema, modules);
		const { contactId, emailRowId } = await seed(t);

		for (const role of ['owner', 'admin'] as const) {
			currentRole = role;
			const rows = (await t
				.withIdentity(testIdentity)
				.query(api.contacts.timeline.getTimeline, { contactId })) as TimelineRow[];

			const email = messageRows(rows).find((r) => r.data._id === emailRowId);
			expect(email, `email row missing for ${role}`).toBeDefined();
			expect(email!.data.content.text).toBe(INBOUND_BODY);
			expect(email!.data.content.subject).toBe(INBOUND_SUBJECT);
			expect(email!.data.content.redacted).toBeUndefined();
		}
	});

	it('redacts the inbound email body for a non-admin member but keeps subject + metadata', async () => {
		const t = convexTest(schema, modules);
		const { contactId, emailRowId } = await seed(t);

		currentRole = 'editor';
		const rows = (await t
			.withIdentity(testIdentity)
			.query(api.contacts.timeline.getTimeline, { contactId })) as TimelineRow[];

		const email = messageRows(rows).find((r) => r.data._id === emailRowId);
		// Row is still present (we don't hide the whole timeline)...
		expect(email).toBeDefined();
		// ...but the body is withheld...
		expect(email!.data.content.text).toBeUndefined();
		expect(email!.data.content.html).toBeUndefined();
		expect(email!.data.content.redacted).toBe(true);
		// ...while subject + channel/direction/status metadata survive.
		expect(email!.data.content.subject).toBe(INBOUND_SUBJECT);
		expect(email!.data.channel).toBe('email');
		expect(email!.data.direction).toBe('inbound');
		expect(email!.data.status).toBe('received');
	});

	it('leaves a non-email inbound row fully visible to a non-admin member', async () => {
		const t = convexTest(schema, modules);
		const { contactId, smsRowId } = await seed(t);

		currentRole = 'editor';
		const rows = (await t
			.withIdentity(testIdentity)
			.query(api.contacts.timeline.getTimeline, { contactId })) as TimelineRow[];

		const sms = messageRows(rows).find((r) => r.data._id === smsRowId);
		expect(sms).toBeDefined();
		expect(sms!.data.content.text).toBe(SMS_BODY);
		expect(sms!.data.content.redacted).toBeUndefined();
	});
});
