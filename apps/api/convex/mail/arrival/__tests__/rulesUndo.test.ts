/**
 * Undo of lane rules' operations, end to end through rules' own code (SPEC
 * §4.4, §6.2, §6.4): a `rule_apply` (flag, read, label, a placement on the
 * record with its guard, and the delayed archive it created) and a
 * `delayed_archive` (one message archived when its delay ran out).
 */

import { describe, expect, it, vi } from 'vitest';
import type { Id } from '../../../_generated/dataModel';
import { api } from '../../../_generated/api';
import { executeDelayedAction } from '../../rules/delayedActions';
import {
	deliverHosted,
	delayedOf,
	messageOf,
	operationsOf,
	recordOf,
	roleOf,
	seedFilter,
	seedLabel,
} from '../../rules/__tests__/rules.testlib';
import { learnTest, seedPersonalMailbox, type T } from './learn.testlib';

vi.mock('../../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../../lib/sessionOrganization');
	const session = { userId: 'user-A', role: 'owner' as const, activeOrganizationId: 'org-1' };
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => session),
		getBetterAuthSessionWithRole: vi.fn(async () => session),
	};
});

const undo = (t: T, operationId: Id<'mailArrivalOperations'>) =>
	t.mutation(api.mail.arrival.operations.undo, { operationId });

describe('undo of rules operations', () => {
	it('undoes a rule_apply: flag, read, label, section and the placement with its guard', async () => {
		const t = learnTest();
		const { mailboxId } = await seedPersonalMailbox(t);
		const labelId = await seedLabel(t, mailboxId);
		await seedFilter(t, mailboxId, {
			actions: [
				{ type: 'markFlagged' },
				{ type: 'markRead' },
				{ type: 'addLabel', labelId },
				{ type: 'pinToSection', sectionName: 'Shopping' },
				{ type: 'sendToDigest' },
			],
		});
		const id = (await deliverHosted(t))!;
		const [operation] = await operationsOf(t, mailboxId);
		expect(operation).toMatchObject({ kind: 'rule_apply', messageId: id });
		const kinds = operation!.changes.map((row) => row.change.kind).sort();
		expect(kinds).toEqual([
			'messageFlag',
			'messageLabel',
			'messageRead',
			'messageSection',
			'recordRulePlacement',
		]);
		expect((await messageOf(t, id)).pinnedSection).toBe('Shopping');
		const { threadId } = await messageOf(t, id);
		const why = () => t.query(api.mail.arrival.explain.forThread, { threadId });
		expect(await why()).toMatchObject({ decidedBy: 'rule', rulePlacement: 'digest' });

		const result = await undo(t, operation!._id);
		expect(result).toMatchObject({
			status: 'undone',
			kind: 'rule_apply',
			restored: kinds.length,
			skipped: 0,
			hasMore: false,
		});
		const after = await messageOf(t, id);
		expect(after.flagFlagged).toBe(false);
		expect(after.flagSeen).toBe(false);
		expect(after.labelIds).toEqual([]);
		expect(after.pinnedSection).toBeUndefined();
		expect((await recordOf(t, id))!.rulePlacement).toBeUndefined();
		// The projection was recomputed without the rule: its kind of mail decides now.
		const explained = await why();
		expect(explained?.decidedBy).toBe('category');
		expect(explained?.rulePlacement).toBeUndefined();
	});

	it('undoing a rule_apply cancels the pending delayed archive it created', async () => {
		const t = learnTest();
		const { mailboxId } = await seedPersonalMailbox(t);
		await seedFilter(t, mailboxId, {
			actions: [{ type: 'markRead' }, { type: 'archiveAfter', hours: 24 }],
		});
		const id = (await deliverHosted(t))!;
		const [operation] = await operationsOf(t, mailboxId);
		const [pending] = await delayedOf(t, id);
		expect(pending).toMatchObject({ state: 'pending', createdByOperationId: operation!._id });
		expect((await undo(t, operation!._id)).status).toBe('undone');
		expect((await delayedOf(t, id))[0]).toMatchObject({ state: 'cancelled', cancelledBy: 'undo' });
		expect((await messageOf(t, id)).flagSeen).toBe(false);
	});

	it('undoes a delayed_archive: the message comes back to the Inbox', async () => {
		const t = learnTest();
		const { mailboxId, folders } = await seedPersonalMailbox(t);
		await seedFilter(t, mailboxId, { actions: [{ type: 'archiveAfter', hours: 24 }] });
		const id = (await deliverHosted(t))!;
		const [row] = await delayedOf(t, id);
		expect(await t.run(async (ctx) => await executeDelayedAction(ctx, row!._id, row!.runAt))).toBe(
			'done'
		);
		expect(await roleOf(t, id)).toBe('archive');
		const archived = (await operationsOf(t, mailboxId)).find(
			(operation) => operation.kind === 'delayed_archive'
		)!;
		expect(archived.changes.map((change) => change.change)).toEqual([
			{ kind: 'messageFolder', messageId: id, before: folders.inbox, after: folders.archive },
		]);

		const result = await undo(t, archived._id);
		expect(result).toMatchObject({
			status: 'undone',
			kind: 'delayed_archive',
			restored: 1,
			hasMore: false,
		});
		expect(await roleOf(t, id)).toBe('inbox');
		// The executed row stays as it ran; nothing re-arms it.
		expect((await delayedOf(t, id))[0]!.state).toBe('done');
	});
});
