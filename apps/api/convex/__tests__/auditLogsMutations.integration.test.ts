/**
 * Audit-trail coverage for primary-table mutations that previously emitted no
 * audit log while their catalog literals sat dead (DX audit item `audit-logs`):
 *   - segments.create               → `segment.created`
 *   - webhooks.endpoints.regenerateSecret → `webhook.secret_rotated`
 *   - blockedEmails.add             → `blocklist.added`
 *
 * Each case asserts that exactly one audit row is written with the correct
 * action literal + resource + acting userId. These three are representative of
 * the broader set wired in the same change (segment update/remove, webhook
 * create/update/remove, blocklist remove); the lifecycle reducers already had
 * their own coverage, so this file targets the freshly-emitting handlers.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';

// Acting identity for every mutation under test. `requireOrgPermission` and
// `getMutationContext` are the only auth seams these three handlers touch; the
// real permission gate (hasPermission/requirePermission) is preserved because
// we hand back an `owner` role.
vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi
			.fn()
			.mockResolvedValue({ userId: 'audit-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('audit-user'),
		getMutationContext: vi
			.fn()
			.mockResolvedValue({ userId: 'audit-user', role: 'owner' }),
		requireOrgPermission: vi
			.fn()
			.mockResolvedValue({ userId: 'audit-user', role: 'owner' }),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(([path]) => !path.includes('sesActions')),
);

const auditRowsFor = async (
	t: TestConvex<typeof schema>,
	resourceId: string,
) =>
	t.run(async (ctx) =>
		(await ctx.db.query('auditLogs').collect()).filter(
			(l) => l.resourceId === resourceId,
		),
	);

describe('audit logs — primary-table mutations', () => {
	it('segments.create emits segment.created', async () => {
		const t = convexTest(schema, modules);

		const segmentId = await t.mutation(api.segments.create, {
			name: 'Active subscribers',
			filters: { logic: 'AND', conditions: [] },
		});

		const rows = await auditRowsFor(t, segmentId as unknown as string);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.action).toBe('segment.created');
		expect(rows[0]!.resource).toBe('segment');
		expect(rows[0]!.userId).toBe('audit-user');
		expect(rows[0]!.details).toMatchObject({ name: 'Active subscribers' });
	});

	it('webhooks.regenerateSecret emits webhook.secret_rotated', async () => {
		const t = convexTest(schema, modules);

		const created = await t.mutation(api.webhooks.endpoints.create, {
			name: 'Ops hook',
			url: 'https://example.com/webhook',
			events: ['email.sent'],
		});

		const { secret: rotatedSecret } = await t.mutation(
			api.webhooks.endpoints.regenerateSecret,
			{ webhookId: created.webhookId },
		);

		// The new secret differs from the original (rotation actually happened).
		expect(rotatedSecret).not.toBe(created.secret);

		const rows = await auditRowsFor(t, created.webhookId as unknown as string);
		const rotation = rows.filter((r) => r.action === 'webhook.secret_rotated');
		expect(rotation).toHaveLength(1);
		expect(rotation[0]!.resource).toBe('webhook');
		expect(rotation[0]!.userId).toBe('audit-user');
		expect(rotation[0]!.details).toMatchObject({ name: 'Ops hook' });
	});

	it('blockedEmails.add emits blocklist.added', async () => {
		const t = convexTest(schema, modules);

		const blockedEmailId = await t.mutation(api.blockedEmails.add, {
			email: 'Spammer@Example.com',
			reason: 'manual',
		});

		const rows = await auditRowsFor(t, blockedEmailId as unknown as string);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.action).toBe('blocklist.added');
		expect(rows[0]!.resource).toBe('blocklist');
		expect(rows[0]!.userId).toBe('audit-user');
		// Email is normalized (lowercased) before both block + audit.
		expect(rows[0]!.details).toMatchObject({
			email: 'spammer@example.com',
			reason: 'manual',
		});
	});
});
