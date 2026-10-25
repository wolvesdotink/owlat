import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import type * as SessionModule from '../lib/sessionOrganization';
import type { OrganizationRole } from '../lib/sessionOrganization';
import { createTestContact, createTestDomain } from './factories';

/**
 * The domains, delivery, contacts, campaigns, transactional and topics
 * endpoints take the session their builder's floor resolved instead of
 * resolving it again in the handler or in a shared guard.
 *
 * Every exported session resolver is replaced by a counting fake, so one call
 * through a registered function must resolve exactly once (the floor). The
 * permission checks run the real role map against the threaded session, so the
 * access decisions are pinned too: editors keep the
 * campaign pipeline, contact notes and the sender picker, and stay out of
 * topics, transactional templates, domains, contact properties and sender
 * curation.
 */

const ORG = 'org-a';
let mockRole: OrganizationRole = 'owner';
const resolutions: string[] = [];

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof SessionModule>('../lib/sessionOrganization');
	const { realPermissionGate } = await import('./helpers/permissionGateMock');
	const gate = realPermissionGate(actual, () => mockRole);
	const session = () => ({ userId: 'user-1', role: mockRole, activeOrganizationId: ORG });
	const resolver =
		<A extends unknown[], R>(name: string, check: (...args: A) => R) =>
		async (...args: A) => {
			resolutions.push(name);
			check(...args);
			return session();
		};
	const none = () => undefined;
	return {
		...actual,
		getSingletonOrganizationId: vi.fn(async () => ORG),
		isActiveOrgMember: vi.fn(async () => true),
		getBetterAuthSession: vi.fn(resolver('getBetterAuthSession', none)),
		getBetterAuthSessionWithRole: vi.fn(resolver('getBetterAuthSessionWithRole', none)),
		getUserIdFromSession: vi.fn(async () => {
			resolutions.push('getUserIdFromSession');
			return 'user-1';
		}),
		requireOrgMember: vi.fn(resolver('requireOrgMember', none)),
		getMutationContext: vi.fn(resolver('getMutationContext', none)),
		requireAdminContext: vi.fn(
			resolver('requireAdminContext', (_ctx: unknown, message?: string) =>
				gate('organization:manage', message ?? 'Only owners and admins can perform this action')
			)
		),
		requireOwnerContext: vi.fn(
			resolver('requireOwnerContext', (_ctx: unknown, message?: string) =>
				gate('organization:delete', message ?? 'Only owners can perform this action')
			)
		),
		requireOrgPermission: vi.fn(
			resolver('requireOrgPermission', (_ctx: unknown, permission: string, message?: string) =>
				gate(permission, message)
			)
		),
	};
});

const modules = import.meta.glob('../**/*.*s');

beforeEach(() => {
	mockRole = 'owner';
	resolutions.length = 0;
});

/** Run one call and return how many times it resolved the session. */
async function resolvedOnce<T>(call: () => Promise<T>): Promise<T> {
	resolutions.length = 0;
	const result = await call();
	expect(resolutions).toHaveLength(1);
	return result;
}

const FORBIDDEN = /"category":"forbidden"/;

async function seedContact(t: ReturnType<typeof convexTest>): Promise<Id<'contacts'>> {
	return t.run(async (ctx) => ctx.db.insert('contacts', createTestContact()));
}

describe('direct permission checks on the threaded session', () => {
	it('topics.create: one resolution; editors are refused and nothing is written', async () => {
		const t = convexTest(schema, modules);
		mockRole = 'admin';
		await resolvedOnce(() => t.mutation(api.topics.topics.create, { name: 'News' }));

		mockRole = 'editor';
		await expect(t.mutation(api.topics.topics.create, { name: 'Editor topic' })).rejects.toThrow(
			/Only owners and admins can create topics/
		);
		await t.run(async (ctx) => {
			const names = (await ctx.db.query('topics').collect()).map((topic) => topic.name);
			expect(names).toEqual(['News']);
		});
	});

	it('transactional.emails.create: one resolution; editors are refused', async () => {
		const t = convexTest(schema, modules);
		await resolvedOnce(() =>
			t.mutation(api.transactional.emails.create, { name: 'Welcome', slug: 'welcome' })
		);

		mockRole = 'editor';
		await expect(
			t.mutation(api.transactional.emails.create, { name: 'Reset', slug: 'reset' })
		).rejects.toThrow(/Only owners and admins can create transactional emails/);
		await t.run(async (ctx) => {
			expect(await ctx.db.query('transactionalEmails').collect()).toHaveLength(1);
		});
	});

	it('contacts.contacts.updateNotes: editors may annotate, with one resolution', async () => {
		const t = convexTest(schema, modules);
		const contactId = await seedContact(t);
		mockRole = 'editor';
		await resolvedOnce(() =>
			t.mutation(api.contacts.contacts.updateNotes, { contactId, notes: 'Met at the fair' })
		);
		await t.run(async (ctx) => {
			expect((await ctx.db.get(contactId))?.notes).toBe('Met at the fair');
		});
	});

	it('contacts.contacts.remove: editors cannot manage contacts', async () => {
		const t = convexTest(schema, modules);
		const contactId = await seedContact(t);
		mockRole = 'editor';
		await expect(t.mutation(api.contacts.contacts.remove, { contactId })).rejects.toThrow(
			/Only owners and admins can delete contacts/
		);
		await t.run(async (ctx) => {
			expect(await ctx.db.get(contactId)).not.toBeNull();
		});
	});

	it('campaigns.campaigns.create: editors run the campaign pipeline, with one resolution', async () => {
		const t = convexTest(schema, modules);
		mockRole = 'editor';
		const campaignId = await resolvedOnce(() =>
			t.mutation(api.campaigns.campaigns.create, { name: 'Spring' })
		);
		await t.run(async (ctx) => {
			expect((await ctx.db.get(campaignId))?.name).toBe('Spring');
		});
	});

	it('domains.domains.getInboundMailConfig: admin read with one resolution; editors are refused', async () => {
		const t = convexTest(schema, modules);
		mockRole = 'admin';
		await resolvedOnce(() => t.query(api.domains.domains.getInboundMailConfig, {}));

		mockRole = 'editor';
		await expect(t.query(api.domains.domains.getInboundMailConfig, {})).rejects.toThrow(FORBIDDEN);
	});

	it('domains.trackingDomains.removeTrackingDomain: editors are refused before the lookup', async () => {
		const t = convexTest(schema, modules);
		const trackingDomainId = await t.run(async (ctx) =>
			ctx.db.insert('trackingDomains', {
				domain: 'links.example.com',
				cnameTarget: 'track.owlat.example',
				isVerified: false,
				createdAt: 1,
			})
		);
		mockRole = 'editor';
		await expect(
			t.mutation(api.domains.trackingDomains.removeTrackingDomain, { trackingDomainId })
		).rejects.toThrow(/Only owners and admins can perform this action/);
		await t.run(async (ctx) => {
			expect(await ctx.db.get(trackingDomainId)).not.toBeNull();
		});

		mockRole = 'admin';
		await resolvedOnce(() =>
			t.mutation(api.domains.trackingDomains.removeTrackingDomain, { trackingDomainId })
		);
		await t.run(async (ctx) => {
			expect(await ctx.db.get(trackingDomainId)).toBeNull();
		});
	});
});

describe('membership-only reads rely on the floor alone', () => {
	it('contacts.propertyValues.listByContact resolves once for an editor', async () => {
		const t = convexTest(schema, modules);
		const contactId = await seedContact(t);
		mockRole = 'editor';
		await expect(
			resolvedOnce(() => t.query(api.contacts.propertyValues.listByContact, { contactId }))
		).resolves.toEqual([]);
	});

	it('delivery.health.getDeliveryHealth resolves once', async () => {
		const t = convexTest(schema, modules);
		mockRole = 'editor';
		await resolvedOnce(() => t.query(api.delivery.health.getDeliveryHealth, {}));
	});
});

describe('admin floors hand their session to the handler', () => {
	it('delivery.rampControls.setStreamPreset attributes the write to the floor user', async () => {
		const t = convexTest(schema, modules);
		mockRole = 'admin';
		await resolvedOnce(() =>
			t.mutation(api.delivery.rampControls.setStreamPreset, {
				stream: 'campaign',
				preset: 'conservative',
			})
		);
		await t.run(async (ctx) => {
			const [row] = await ctx.db.query('rampStreamPresets').collect();
			expect(row).toMatchObject({ organizationId: ORG, updatedByUserId: 'user-1' });
		});

		mockRole = 'editor';
		await expect(
			t.mutation(api.delivery.rampControls.setStreamPreset, { stream: 'campaign', preset: null })
		).rejects.toThrow(FORBIDDEN);
		await t.run(async (ctx) => {
			expect(await ctx.db.query('rampStreamPresets').collect()).toHaveLength(1);
		});
	});

	it('delivery.rampControls.setCellPause resolves its target from the threaded session', async () => {
		const t = convexTest(schema, modules);
		mockRole = 'admin';
		await expect(
			resolvedOnce(() =>
				t.mutation(api.delivery.rampControls.setCellPause, {
					stream: 'campaign',
					destinationProvider: 'gmail',
					isPaused: true,
				})
			)
		).resolves.toEqual({ applied: false, refusal: 'cell_not_ramp_managed' });
	});
});

describe('shared guards check the threaded session', () => {
	it('contacts.properties.create (requireContactsManage): one resolution; editors are refused', async () => {
		const t = convexTest(schema, modules);
		mockRole = 'admin';
		await resolvedOnce(() =>
			t.mutation(api.contacts.properties.create, { key: 'plan', label: 'Plan', type: 'string' })
		);

		mockRole = 'editor';
		await expect(
			t.mutation(api.contacts.properties.create, { key: 'tier', label: 'Tier', type: 'string' })
		).rejects.toThrow(/Only owners and admins can manage contacts/);
		await t.run(async (ctx) => {
			const keys = (await ctx.db.query('contactProperties').collect()).map((row) => row.key);
			expect(keys).toEqual(['plan']);
		});
	});

	it('campaigns.senders: curation stays admin-only, the picker stays member-readable', async () => {
		const t = convexTest(schema, modules);
		mockRole = 'admin';
		await resolvedOnce(() => t.query(api.campaigns.senders.list, {}));

		mockRole = 'editor';
		await expect(t.query(api.campaigns.senders.list, {})).rejects.toThrow(
			/Only owners and admins can manage campaign senders/
		);
		await expect(
			t.mutation(api.campaigns.senders.create, { email: 'news@example.com' })
		).rejects.toThrow(/Only owners and admins can manage campaign senders/);
		const picker = await resolvedOnce(() => t.query(api.campaigns.senders.listForPicker, {}));
		expect(picker.canManage).toBe(false);
	});

	it('campaigns.campaigns.updateBasics (requireDraftCampaign): editors edit drafts, with one resolution', async () => {
		const t = convexTest(schema, modules);
		mockRole = 'editor';
		const campaignId = await t.mutation(api.campaigns.campaigns.create, { name: 'Draft' });
		await resolvedOnce(() =>
			t.mutation(api.campaigns.campaigns.updateBasics, { campaignId, name: 'Renamed' })
		);
		await t.run(async (ctx) => {
			expect((await ctx.db.get(campaignId))?.name).toBe('Renamed');
		});
	});

	it('domains.yahooCfl.submitEnrollment (runEvent): audited as the floor session; editors are refused', async () => {
		const t = convexTest(schema, modules);
		const domainId = await t.run(async (ctx) =>
			ctx.db.insert('domains', createTestDomain({ domain: 'example.com' }))
		);

		mockRole = 'editor';
		await expect(t.mutation(api.domains.yahooCfl.submitEnrollment, { domainId })).rejects.toThrow(
			FORBIDDEN
		);
		await t.run(async (ctx) => {
			expect(await ctx.db.query('auditLogs').collect()).toHaveLength(0);
		});

		mockRole = 'admin';
		await resolvedOnce(() => t.mutation(api.domains.yahooCfl.submitEnrollment, { domainId }));
		await t.run(async (ctx) => {
			const audits = await ctx.db.query('auditLogs').collect();
			expect(audits).toHaveLength(1);
			expect(audits[0]).toMatchObject({
				userId: 'user-1',
				organizationId: ORG,
				action: 'sending_domain.yahoo_cfl_changed',
			});
		});
	});
});
