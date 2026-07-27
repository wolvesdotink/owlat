/**
 * THE OPERATOR SURFACE of the sunset policy (deliverability plan P4-4).
 *
 * `setSunsetPolicy` is the only control anybody has over an engine that
 * permanently stops mail to a contact, and `blockedEmails.remove` is the only
 * un-suppression control the UI actually offers — so both are covered here as
 * carefully as the decision core is.
 *
 * The properties that matter:
 *   - a PARTIAL save patches only what it was given (an omitted field patched to
 *     `undefined` DELETES it in Convex, which would silently re-arm the engine
 *     for a topic whose operator had turned it off);
 *   - the window floor and the suppress-after-reengage ordering are enforced,
 *     the ordering against the row the save PRODUCES and not just its arguments;
 *   - insert and upsert both work and both audit;
 *   - removing an `unengaged` blocklist row goes through the sunset restore
 *     path, so the visible "Remove" action does not undo itself at the next
 *     sweep;
 *   - the re-engagement track is enumerable.
 */

import { describe, it, expect, vi } from 'vitest';
import { api } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { createTestContact } from '../../__tests__/factories';
import { SUNSET_MIN_WINDOW_DAYS } from '../sunsetPolicy';
import { daysAgo, harness, type Harness } from './sunsetFixtures';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof import('../../lib/sessionOrganization')>(
		'../../lib/sessionOrganization'
	);
	const session = () => ({ userId: 'operator-1', role: 'admin' as const });
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session()),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('operator-1'),
		requireOrgPermission: vi.fn(async () => session()),
	};
});

const identity = { subject: 'operator-1', tokenIdentifier: 'test|operator-1' };

async function readPolicyRows(t: Harness) {
	return await t.run(async (ctx) => await ctx.db.query('sunsetPolicies').collect());
}

async function readPolicyAudits(t: Harness) {
	return await t.run(async (ctx) => {
		const logs = await ctx.db.query('auditLogs').collect();
		return logs.filter((log) => log.action === 'contact.sunset_policy_updated');
	});
}

describe('setSunsetPolicy — validation', () => {
	it('rejects a re-engagement window below the floor', async () => {
		const t = harness();
		await expect(
			t.withIdentity(identity).mutation(api.contacts.sunset.setSunsetPolicy, {
				reengageAfterDays: SUNSET_MIN_WINDOW_DAYS - 1,
			})
		).rejects.toThrow();
		expect(await readPolicyRows(t)).toHaveLength(0);
	});

	it('rejects a suppression window below the floor', async () => {
		const t = harness();
		await expect(
			t.withIdentity(identity).mutation(api.contacts.sunset.setSunsetPolicy, {
				suppressAfterDays: SUNSET_MIN_WINDOW_DAYS - 1,
			})
		).rejects.toThrow();
		expect(await readPolicyRows(t)).toHaveLength(0);
	});

	it('rejects a backwards pair sent together', async () => {
		const t = harness();
		await expect(
			t.withIdentity(identity).mutation(api.contacts.sunset.setSunsetPolicy, {
				reengageAfterDays: 300,
				suppressAfterDays: 100,
			})
		).rejects.toThrow();
	});

	it('rejects a backwards pair produced by MERGING with the stored row', async () => {
		const t = harness();
		await t
			.withIdentity(identity)
			.mutation(api.contacts.sunset.setSunsetPolicy, { reengageAfterDays: 200 });

		// On its own this value is legal; against the stored 200 it is backwards,
		// and the engine would hold on `invalid_policy` forever if it landed.
		await expect(
			t
				.withIdentity(identity)
				.mutation(api.contacts.sunset.setSunsetPolicy, { suppressAfterDays: 100 })
		).rejects.toThrow();

		const rows = await readPolicyRows(t);
		expect(rows[0]?.suppressAfterDays).toBeUndefined();
	});
});

describe('setSunsetPolicy — insert, upsert and the partial-save defect', () => {
	it('inserts a deployment-wide row when none exists', async () => {
		const t = harness();
		const policyId = await t.withIdentity(identity).mutation(api.contacts.sunset.setSunsetPolicy, {
			isEnabled: false,
			reengageAfterDays: 200,
			suppressAfterDays: 400,
		});

		const rows = await readPolicyRows(t);
		expect(rows).toHaveLength(1);
		expect(rows[0]?._id).toBe(policyId);
		expect(rows[0]?.topicId).toBeUndefined();
		expect(rows[0]).toMatchObject({
			isEnabled: false,
			reengageAfterDays: 200,
			suppressAfterDays: 400,
		});
	});

	it('upserts the same row rather than inserting a second one', async () => {
		const t = harness();
		const first = await t
			.withIdentity(identity)
			.mutation(api.contacts.sunset.setSunsetPolicy, { reengageAfterDays: 200 });
		const second = await t
			.withIdentity(identity)
			.mutation(api.contacts.sunset.setSunsetPolicy, { reengageAfterDays: 210 });

		expect(second).toBe(first);
		const rows = await readPolicyRows(t);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.reengageAfterDays).toBe(210);
	});

	it('keeps the deployment-wide and the per-topic row apart', async () => {
		const t = harness();
		const topicId = await t.run(
			async (ctx) => await ctx.db.insert('topics', { name: 'News', createdAt: daysAgo(10) })
		);

		await t
			.withIdentity(identity)
			.mutation(api.contacts.sunset.setSunsetPolicy, { reengageAfterDays: 200 });
		await t
			.withIdentity(identity)
			.mutation(api.contacts.sunset.setSunsetPolicy, { topicId, reengageAfterDays: 300 });

		const rows = await readPolicyRows(t);
		expect(rows).toHaveLength(2);
		expect(rows.filter((row) => row.topicId === undefined)[0]?.reengageAfterDays).toBe(200);
		expect(rows.filter((row) => row.topicId === topicId)[0]?.reengageAfterDays).toBe(300);
	});

	/**
	 * THE DEFECT THIS SUITE EXISTS FOR. Saving only a window on a row that says
	 * the engine is OFF must not clear the opt-out — patching a field to an
	 * explicit `undefined` deletes it in Convex, and the next sweep would then
	 * auto-suppress that topic's members with nothing in the audit trail
	 * explaining why the engine turned itself back on.
	 */
	it('a partial save never wipes the stored opt-out', async () => {
		const t = harness();
		await t
			.withIdentity(identity)
			.mutation(api.contacts.sunset.setSunsetPolicy, { isEnabled: false });

		await t
			.withIdentity(identity)
			.mutation(api.contacts.sunset.setSunsetPolicy, { reengageAfterDays: 200 });

		const rows = await readPolicyRows(t);
		expect(rows[0]?.isEnabled).toBe(false);
		expect(rows[0]?.reengageAfterDays).toBe(200);
	});

	it('a partial save never wipes a stored window either', async () => {
		const t = harness();
		await t.withIdentity(identity).mutation(api.contacts.sunset.setSunsetPolicy, {
			reengageAfterDays: 200,
			suppressAfterDays: 400,
		});

		await t
			.withIdentity(identity)
			.mutation(api.contacts.sunset.setSunsetPolicy, { isEnabled: true });

		expect(await readPolicyRows(t)).toMatchObject([
			{ isEnabled: true, reengageAfterDays: 200, suppressAfterDays: 400 },
		]);
	});
});

describe('setSunsetPolicy — the audit trail', () => {
	it('records the resulting row and which fields the save changed', async () => {
		const t = harness();
		await t
			.withIdentity(identity)
			.mutation(api.contacts.sunset.setSunsetPolicy, { isEnabled: false });
		await t
			.withIdentity(identity)
			.mutation(api.contacts.sunset.setSunsetPolicy, { reengageAfterDays: 200 });

		const audits = await readPolicyAudits(t);
		expect(audits).toHaveLength(2);

		const latest = audits[audits.length - 1];
		expect(latest?.userId).toBe('operator-1');
		expect(latest?.details).toMatchObject({
			topicId: 'global',
			changedFields: 'reengageAfterDays',
			// The value the row carries AFTER the save, not the (absent) argument:
			// the opt-out is still there and the entry says so.
			isEnabled: false,
			reengageAfterDays: 200,
		});
	});
});

describe('getSunsetPolicies — effective values, not sparse rows', () => {
	it('renders the defaults when nothing is configured', async () => {
		const t = harness();
		const result = await t.withIdentity(identity).query(api.contacts.sunset.getSunsetPolicies, {});
		expect(result.defaults).toEqual({
			isEnabled: true,
			reengageAfterDays: 180,
			suppressAfterDays: 270,
		});
		expect(result.global).toEqual(result.defaults);
		expect(result.topics).toEqual([]);
	});

	it('merges a per-topic override onto the deployment-wide row', async () => {
		const t = harness();
		const topicId = await t.run(
			async (ctx) => await ctx.db.insert('topics', { name: 'Slow list', createdAt: daysAgo(10) })
		);
		await t
			.withIdentity(identity)
			.mutation(api.contacts.sunset.setSunsetPolicy, { reengageAfterDays: 200 });
		await t
			.withIdentity(identity)
			.mutation(api.contacts.sunset.setSunsetPolicy, { topicId, suppressAfterDays: 540 });

		const result = await t.withIdentity(identity).query(api.contacts.sunset.getSunsetPolicies, {});
		expect(result.global.reengageAfterDays).toBe(200);
		expect(result.topics).toHaveLength(1);
		expect(result.topics[0]?.policy).toEqual({
			isEnabled: true,
			reengageAfterDays: 200,
			suppressAfterDays: 540,
		});
	});
});

describe('listSunsetStage — the re-engagement track is addressable', () => {
	async function seedStaged(t: Harness): Promise<Id<'contacts'>> {
		return await t.run(async (ctx) => {
			const onTrack = await ctx.db.insert(
				'contacts',
				createTestContact({
					email: 'on-track@example.com',
					createdAt: daysAgo(400),
					updatedAt: daysAgo(400),
					sunsetStage: 'reengagement',
					sunsetStageAt: daysAgo(1),
				})
			);
			await ctx.db.insert(
				'contacts',
				createTestContact({
					email: 'suppressed@example.com',
					createdAt: daysAgo(400),
					updatedAt: daysAgo(400),
					sunsetStage: 'suppressed',
				})
			);
			await ctx.db.insert(
				'contacts',
				createTestContact({ email: 'normal@example.com', createdAt: daysAgo(400) })
			);
			return onTrack;
		});
	}

	it('returns only the contacts on the requested stage', async () => {
		const t = harness();
		const onTrack = await seedStaged(t);

		const page = await t.withIdentity(identity).query(api.contacts.sunset.listSunsetStage, {
			stage: 'reengagement',
			paginationOpts: { numItems: 20, cursor: null },
		});

		expect(page.page).toHaveLength(1);
		expect(page.page[0]?.contactId).toBe(onTrack);
		expect(page.page[0]?.email).toBe('on-track@example.com');
		expect(page.page[0]?.sunsetStage).toBe('reengagement');
	});

	it('lists the suppressed stage separately', async () => {
		const t = harness();
		await seedStaged(t);

		const page = await t.withIdentity(identity).query(api.contacts.sunset.listSunsetStage, {
			stage: 'suppressed',
			paginationOpts: { numItems: 20, cursor: null },
		});
		expect(page.page.map((row) => row.email)).toEqual(['suppressed@example.com']);
	});

	it('omits soft-deleted contacts', async () => {
		const t = harness();
		const onTrack = await seedStaged(t);
		await t.run(async (ctx) => await ctx.db.patch(onTrack, { deletedAt: Date.now() }));

		const page = await t.withIdentity(identity).query(api.contacts.sunset.listSunsetStage, {
			stage: 'reengagement',
			paginationOpts: { numItems: 20, cursor: null },
		});
		expect(page.page).toHaveLength(0);
	});
});

describe('blockedEmails.remove — un-suppressing a sunset row does not undo itself', () => {
	async function seedSuppressed(t: Harness) {
		return await t.run(async (ctx) => {
			const contactId = await ctx.db.insert(
				'contacts',
				createTestContact({
					email: 'sunset@example.com',
					createdAt: daysAgo(500),
					updatedAt: daysAgo(500),
					sunsetStage: 'suppressed',
				})
			);
			const blockedEmailId = await ctx.db.insert('blockedEmails', {
				email: 'sunset@example.com',
				reason: 'unengaged',
				createdAt: daysAgo(1),
			});
			return { contactId, blockedEmailId };
		});
	}

	it('removes the row AND sets the operator override, audited as a restore', async () => {
		const t = harness();
		const { contactId, blockedEmailId } = await seedSuppressed(t);

		await t.withIdentity(identity).mutation(api.blockedEmails.remove, { blockedEmailId });

		await t.run(async (ctx) => {
			expect(await ctx.db.get(blockedEmailId)).toBeNull();
			const contact = await ctx.db.get(contactId);
			// Without the override the very next sweep re-suppresses the contact,
			// which is exactly the bug this routing exists to prevent.
			expect(contact?.sunsetExemptAt).toBeDefined();
			expect(contact?.sunsetStage).toBe('engaged');

			const audits = await ctx.db.query('auditLogs').collect();
			expect(audits.map((log) => log.action)).toContain('contact.sunset_restored');
		});
	});

	it('leaves a bounce suppression on the plain delete path', async () => {
		const t = harness();
		const { contactId, blockedEmailId } = await t.run(async (ctx) => {
			const id = await ctx.db.insert(
				'contacts',
				createTestContact({ email: 'bounced@example.com', createdAt: daysAgo(500) })
			);
			const blocked = await ctx.db.insert('blockedEmails', {
				email: 'bounced@example.com',
				reason: 'bounced',
				bounceType: 'hard',
				createdAt: daysAgo(1),
			});
			return { contactId: id, blockedEmailId: blocked };
		});

		await t.withIdentity(identity).mutation(api.blockedEmails.remove, { blockedEmailId });

		await t.run(async (ctx) => {
			expect(await ctx.db.get(blockedEmailId)).toBeNull();
			const contact = await ctx.db.get(contactId);
			// A bounce removal is not a sunset restore: no override is granted.
			expect(contact?.sunsetExemptAt).toBeUndefined();
			const audits = await ctx.db.query('auditLogs').collect();
			expect(audits.map((log) => log.action)).toContain('blocklist.removed');
			expect(audits.map((log) => log.action)).not.toContain('contact.sunset_restored');
		});
	});

	it('still deletes an orphaned unengaged row with no contact behind it', async () => {
		const t = harness();
		const blockedEmailId = await t.run(
			async (ctx) =>
				await ctx.db.insert('blockedEmails', {
					email: 'orphan@example.com',
					reason: 'unengaged',
					createdAt: daysAgo(1),
				})
		);

		await t.withIdentity(identity).mutation(api.blockedEmails.remove, { blockedEmailId });
		await t.run(async (ctx) => {
			expect(await ctx.db.get(blockedEmailId)).toBeNull();
		});
	});
});

describe('blockedEmails.getCountsByReason — the unengaged class is counted', () => {
	it('includes sunset suppressions in the breakdown and the total', async () => {
		const t = harness();
		await t.run(async (ctx) => {
			await ctx.db.insert('blockedEmails', {
				email: 'a@example.com',
				reason: 'bounced',
				createdAt: daysAgo(2),
			});
			await ctx.db.insert('blockedEmails', {
				email: 'b@example.com',
				reason: 'unengaged',
				createdAt: daysAgo(2),
			});
			await ctx.db.insert('blockedEmails', {
				email: 'c@example.com',
				reason: 'unengaged',
				createdAt: daysAgo(2),
			});
		});

		const counts = await t.withIdentity(identity).query(api.blockedEmails.getCountsByReason, {});
		expect(counts).toMatchObject({ total: 3, bounced: 1, complained: 0, manual: 0, unengaged: 2 });
	});

	it('can filter the list down to the unengaged class', async () => {
		const t = harness();
		await t.run(async (ctx) => {
			await ctx.db.insert('blockedEmails', {
				email: 'a@example.com',
				reason: 'manual',
				createdAt: daysAgo(2),
			});
			await ctx.db.insert('blockedEmails', {
				email: 'b@example.com',
				reason: 'unengaged',
				createdAt: daysAgo(2),
			});
		});

		const rows = await t
			.withIdentity(identity)
			.query(api.blockedEmails.listByTeam, { reason: 'unengaged' });
		expect(rows.map((row) => row.email)).toEqual(['b@example.com']);
	});
});
