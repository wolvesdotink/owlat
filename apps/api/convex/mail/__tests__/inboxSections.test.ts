/**
 * Split inbox from filter rules (idea 24).
 *
 * The properties worth pinning:
 *   - `pinToSection` never moves mail. The message stays in the inbox and only
 *     gains a name, so a section is an arrangement, not a hiding place.
 *   - the section ORDER is the filter run order, and a name claimed twice is one
 *     section.
 *   - paging cannot starve a section: each section pages on its own limit, so a
 *     chatty section filling its page leaves a quiet one fully visible.
 *   - "Everything else" is the remainder and always exists, so a mailbox with no
 *     section filter reads exactly like the flat inbox.
 *   - the remainder is the true complement of the sections on screen: a row still
 *     stamped with a retired or over-cap name reads there, never nowhere.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api } from '../../_generated/api';
import { evaluateFilters } from '../filters';
import { resolveFilterOutcome } from '../deliveryPipeline/routing';
import {
	belongsToRemainder,
	DEFAULT_SECTION_LIMIT,
	MAX_SECTIONS,
	MAX_SECTION_LIMIT,
	resolveSectionLimit,
	sectionNamesFromFilters,
} from '../sections';
import { hasRetroactiveActions } from '../filterRun';
import { modules, seedMailbox, seedFolder, seedMessage } from './helpers.testlib';

const sessionMocks = vi.hoisted(() => ({
	userId: 'user-A',
	role: 'owner' as 'owner' | 'admin' | 'editor',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: sessionMocks.role,
		})),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: sessionMocks.role,
		})),
		getBetterAuthSessionWithRole: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: sessionMocks.role,
			activeOrganizationId: 'org-1',
		})),
	};
});

beforeEach(() => {
	sessionMocks.userId = 'user-A';
	sessionMocks.role = 'owner';
});

function filterRow(over: {
	priority: number;
	isEnabled?: boolean;
	actions: Array<{ type: string; sectionName?: string }>;
}) {
	return {
		isEnabled: over.isEnabled ?? true,
		priority: over.priority,
		actions: over.actions,
	} as Parameters<typeof sectionNamesFromFilters>[0][number];
}

describe('sectionNamesFromFilters', () => {
	it('orders sections by the filters run order, not by name', () => {
		const names = sectionNamesFromFilters([
			filterRow({ priority: 300, actions: [{ type: 'pinToSection', sectionName: 'Deploys' }] }),
			filterRow({ priority: 100, actions: [{ type: 'pinToSection', sectionName: 'Team' }] }),
		]);
		expect(names).toEqual(['Team', 'Deploys']);
	});

	it('folds two filters naming the same section into one', () => {
		const names = sectionNamesFromFilters([
			filterRow({ priority: 100, actions: [{ type: 'pinToSection', sectionName: 'Deploys' }] }),
			filterRow({ priority: 200, actions: [{ type: 'pinToSection', sectionName: 'Deploys' }] }),
		]);
		expect(names).toEqual(['Deploys']);
	});

	it('ignores disabled filters and non-section actions', () => {
		const names = sectionNamesFromFilters([
			filterRow({
				priority: 100,
				isEnabled: false,
				actions: [{ type: 'pinToSection', sectionName: 'Off' }],
			}),
			filterRow({ priority: 200, actions: [{ type: 'markRead' }] }),
			filterRow({ priority: 300, actions: [{ type: 'pinToSection', sectionName: 'Team' }] }),
		]);
		expect(names).toEqual(['Team']);
	});

	it('caps the section count so the per-section reads stay bounded', () => {
		const many = Array.from({ length: MAX_SECTIONS + 5 }, (_, i) =>
			filterRow({ priority: i, actions: [{ type: 'pinToSection', sectionName: `S${i}` }] })
		);
		expect(sectionNamesFromFilters(many)).toHaveLength(MAX_SECTIONS);
	});
});

describe('belongsToRemainder', () => {
	it('keeps unstamped mail and mail whose name no rendered section carries', () => {
		const rendered = new Set(['Team', 'Deploys']);
		expect(belongsToRemainder(undefined, rendered)).toBe(true);
		// Retired rule, renamed rule, or a name pushed past the section cap.
		expect(belongsToRemainder('Gone', rendered)).toBe(true);
		expect(belongsToRemainder('Team', rendered)).toBe(false);
	});

	it('holds the whole inbox when nothing is rendered', () => {
		expect(belongsToRemainder('Team', new Set())).toBe(true);
	});
});

describe('resolveSectionLimit', () => {
	it('falls back to the default for a section the client sent no limit for', () => {
		expect(resolveSectionLimit(undefined, 'Team')).toBe(DEFAULT_SECTION_LIMIT);
		expect(resolveSectionLimit([{ section: 'Other', limit: 80 }], 'Team')).toBe(
			DEFAULT_SECTION_LIMIT
		);
	});

	it('addresses "Everything else" by the empty-string key', () => {
		expect(resolveSectionLimit([{ section: '', limit: 40 }], null)).toBe(40);
	});

	it('clamps rather than trusting the client', () => {
		expect(resolveSectionLimit([{ section: 'Team', limit: 10_000 }], 'Team')).toBe(
			MAX_SECTION_LIMIT
		);
		expect(resolveSectionLimit([{ section: 'Team', limit: 0 }], 'Team')).toBe(1);
		expect(resolveSectionLimit([{ section: 'Team', limit: Number.NaN }], 'Team')).toBe(
			DEFAULT_SECTION_LIMIT
		);
	});
});

describe('pinToSection in the filter engine', () => {
	const message = {
		from: 'ci@example.com',
		to: ['me@hinterland.camp'],
		cc: [],
		subject: 'deploy #4112 green',
		bodyText: 'green',
		size: 100,
		hasAttachment: false,
	};

	function pinFilter(sectionName: string, priority = 100) {
		return {
			_id: `f${priority}` as Id<'mailFilters'>,
			isEnabled: true,
			priority,
			conditions: [{ field: 'from' as const, op: 'contains' as const, value: 'ci@' }],
			actions: [{ type: 'pinToSection' as const, sectionName }],
			stopProcessing: false,
		} as unknown as Parameters<typeof evaluateFilters>[0][number];
	}

	it('carries the section name through the evaluator', () => {
		const result = evaluateFilters([pinFilter('Deploys')], message);
		expect(result.actions).toEqual([
			expect.objectContaining({ type: 'pinToSection', sectionName: 'Deploys' }),
		]);
	});

	it('files the message into the first matching section and moves it nowhere', () => {
		const outcome = resolveFilterOutcome(
			[pinFilter('Deploys', 100), pinFilter('Noise', 200)],
			message
		);
		expect(outcome.pinnedSection).toBe('Deploys');
		// The whole point: no folder override, no trash, no discard.
		expect(outcome.folderId).toBeUndefined();
		expect(outcome.isTrashed).toBe(false);
		expect(outcome.isDiscarded).toBe(false);
	});

	it('is a safe action, so the retroactive sweep will apply it', () => {
		expect(
			hasRetroactiveActions({ actions: [{ type: 'pinToSection', sectionName: 'Deploys' }] })
		).toBe(true);
	});
});

describe('mail.filters.create with a pinToSection action', () => {
	it('normalises the section name and refuses one that is only whitespace', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);

		const filterId = await t.mutation(api.mail.filters.create, {
			mailboxId,
			name: 'Deploys',
			conditions: [{ field: 'from', op: 'contains', value: 'ci@' }],
			actions: [{ type: 'pinToSection', sectionName: '  Deploys   room ' }],
		});
		const stored = await t.run(async (ctx) => ctx.db.get(filterId));
		expect(stored?.actions[0]?.sectionName).toBe('Deploys room');

		await expect(
			t.mutation(api.mail.filters.create, {
				mailboxId,
				name: 'Nameless',
				conditions: [{ field: 'from', op: 'contains', value: 'ci@' }],
				actions: [{ type: 'pinToSection', sectionName: '   ' }],
			})
		).rejects.toThrow();
	});
});

describe('mail.sections.listSections', () => {
	async function seedSectionedInbox(t: TestConvex<typeof schema>): Promise<Id<'mailboxes'>> {
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);
		await t.mutation(api.mail.filters.create, {
			mailboxId,
			name: 'Team',
			priority: 100,
			conditions: [{ field: 'from', op: 'contains', value: 'ines' }],
			actions: [{ type: 'pinToSection', sectionName: 'Team' }],
		});
		await t.mutation(api.mail.filters.create, {
			mailboxId,
			name: 'Deploys',
			priority: 200,
			conditions: [{ field: 'from', op: 'contains', value: 'ci@' }],
			actions: [{ type: 'pinToSection', sectionName: 'Deploys' }],
		});
		return mailboxId;
	}

	it('returns the named sections in run order with "Everything else" last', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedSectionedInbox(t);
		await seedMessage(t, mailboxId, { subject: 'invoice', pinnedSection: 'Team' });
		await seedMessage(t, mailboxId, { subject: 'deploy', pinnedSection: 'Deploys' });
		await seedMessage(t, mailboxId, { subject: 'random' });

		const { sections } = await t.query(api.mail.sections.listSections, { mailboxId });
		expect(sections.map((s) => s.name)).toEqual(['Team', 'Deploys', null]);
		expect(sections[0]?.messages.map((m) => m.subject)).toEqual(['invoice']);
		expect(sections[2]?.messages.map((m) => m.subject)).toEqual(['random']);
	});

	it('counts unread per section and marks the count capped honestly', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedSectionedInbox(t);
		await seedMessage(t, mailboxId, { subject: 'a', pinnedSection: 'Team' });
		await seedMessage(t, mailboxId, { subject: 'b', pinnedSection: 'Team', flagSeen: true });

		const { sections } = await t.query(api.mail.sections.listSections, { mailboxId });
		const team = sections.find((s) => s.name === 'Team');
		expect(team?.unreadCount).toBe(1);
		expect(team?.isUnreadCapped).toBe(false);
	});

	it('does not starve a quiet section when a chatty one fills its page', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedSectionedInbox(t);
		// One quiet message, then a flood in the other section. Bucketing a single
		// shared page would push the quiet row out entirely.
		await seedMessage(t, mailboxId, {
			subject: 'quiet',
			pinnedSection: 'Team',
			receivedAt: 1_000,
		});
		for (let i = 0; i < 30; i++) {
			await seedMessage(t, mailboxId, {
				subject: `deploy ${i}`,
				pinnedSection: 'Deploys',
				receivedAt: 10_000 + i,
			});
		}

		const { sections } = await t.query(api.mail.sections.listSections, {
			mailboxId,
			limits: [{ section: 'Deploys', limit: 5 }],
		});
		const team = sections.find((s) => s.name === 'Team');
		const deploys = sections.find((s) => s.name === 'Deploys');
		expect(team?.messages.map((m) => m.subject)).toEqual(['quiet']);
		expect(deploys?.messages).toHaveLength(5);
		// …and the flooded section says so on its own, not on everyone's behalf.
		expect(deploys?.hasMore).toBe(true);
		expect(team?.hasMore).toBe(false);
	});

	it('folds mail from a retired section back into "Everything else"', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedSectionedInbox(t);
		// Stamped by a rule that no longer exists (deleted, disabled or renamed).
		// Nothing clears the stamp, so the read has to tolerate it.
		await seedMessage(t, mailboxId, { subject: 'from a retired rule', pinnedSection: 'Gone' });

		const { sections } = await t.query(api.mail.sections.listSections, { mailboxId });
		expect(sections.map((s) => s.name)).toEqual(['Team', 'Deploys', null]);
		expect(sections.flatMap((s) => s.messages.map((m) => m.subject))).toEqual([
			'from a retired rule',
		]);
		expect(sections[2]?.unreadCount).toBe(1);
	});

	it('keeps the mail visible after the rule that filed it is deleted', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);
		const filterId = await t.mutation(api.mail.filters.create, {
			mailboxId,
			name: 'Team',
			conditions: [{ field: 'from', op: 'contains', value: 'ines' }],
			actions: [{ type: 'pinToSection', sectionName: 'Team' }],
		});
		await seedMessage(t, mailboxId, { subject: 'standup', pinnedSection: 'Team' });

		await t.mutation(api.mail.filters.remove, { filterId });

		const { sections } = await t.query(api.mail.sections.listSections, { mailboxId });
		expect(sections.map((s) => s.name)).toEqual([null]);
		expect(sections[0]?.messages.map((m) => m.subject)).toEqual(['standup']);
	});

	it('shows mail stamped past the section cap instead of hiding it', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);
		// Delivery stamps ANY matching pin name; only the render is capped.
		for (let i = 0; i < MAX_SECTIONS + 1; i++) {
			await t.mutation(api.mail.filters.create, {
				mailboxId,
				name: `S${i}`,
				priority: 100 + i,
				conditions: [{ field: 'from', op: 'contains', value: `s${i}@` }],
				actions: [{ type: 'pinToSection', sectionName: `S${i}` }],
			});
		}
		const overCap = `S${MAX_SECTIONS}`;
		await seedMessage(t, mailboxId, { subject: 'over the cap', pinnedSection: overCap });

		const { sections } = await t.query(api.mail.sections.listSections, { mailboxId });
		expect(sections).toHaveLength(MAX_SECTIONS + 1);
		expect(sections.map((s) => s.name)).not.toContain(overCap);
		const rest = sections[sections.length - 1];
		expect(rest?.name).toBeNull();
		expect(rest?.messages.map((m) => m.subject)).toEqual(['over the cap']);
	});

	it('pages the remainder past pinned mail rather than counting it against the page', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedSectionedInbox(t);
		// A flood of pinned mail sits above the two unpinned rows in arrival order.
		for (let i = 0; i < 20; i++) {
			await seedMessage(t, mailboxId, {
				subject: `deploy ${i}`,
				pinnedSection: 'Deploys',
				receivedAt: 10_000 + i,
			});
		}
		await seedMessage(t, mailboxId, { subject: 'older a', receivedAt: 2_000 });
		await seedMessage(t, mailboxId, { subject: 'older b', receivedAt: 1_000 });

		const { sections } = await t.query(api.mail.sections.listSections, { mailboxId });
		const rest = sections.find((s) => s.name === null);
		expect(rest?.messages.map((m) => m.subject)).toEqual(['older a', 'older b']);
		expect(rest?.hasMore).toBe(false);
		expect(rest?.unreadCount).toBe(2);
	});

	it('degrades to one "Everything else" section when no filter names one', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);
		await seedMessage(t, mailboxId, { subject: 'plain' });

		const { sections } = await t.query(api.mail.sections.listSections, { mailboxId });
		expect(sections).toHaveLength(1);
		expect(sections[0]?.name).toBeNull();
		expect(sections[0]?.messages.map((m) => m.subject)).toEqual(['plain']);
	});

	it('reveals nothing to someone without access to the mailbox', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedSectionedInbox(t);
		await seedMessage(t, mailboxId, { subject: 'private', pinnedSection: 'Team' });

		// An org EDITOR who is not the mailbox owner and holds no membership row:
		// owner/admin act on behalf of the org, so they would (correctly) pass.
		sessionMocks.userId = 'user-B';
		sessionMocks.role = 'editor';
		const { sections } = await t.query(api.mail.sections.listSections, { mailboxId });
		expect(sections).toEqual([]);
	});
});
