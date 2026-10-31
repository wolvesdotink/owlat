/**
 * The hosted MX delivery decisions (`mail/deliveryPipeline/mailboxDecision.ts`)
 * for plain arguments and rows. The mutation is held to them by
 * `deliverToMailbox.characterization.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { Doc, Id } from '../../_generated/dataModel';
import type { MailboxDeliveryArgs } from '../deliveryPipeline/ingestFields';
import {
	deliveredMessageInput,
	deliveryAnswer,
	filterDelivery,
	postDeliveryHookArgs,
	routeDelivery,
	targetFolderRole,
} from '../deliveryPipeline/mailboxDecision';

const mailboxId = 'mailbox-1' as Id<'mailboxes'>;
const projectsId = 'folder-projects' as Id<'mailFolders'>;
const labelId = 'label-1' as Id<'mailLabels'>;
const messageId = 'message-1' as Id<'mailMessages'>;

const args = (overrides: Partial<MailboxDeliveryArgs> = {}): MailboxDeliveryArgs => ({
	rawStorageId: 'raw-1' as Id<'_storage'>,
	rawSize: 3,
	recipientAddress: 'me@owlat.test',
	from: 'News Desk <News@Example.com>',
	to: ['me@owlat.test'],
	cc: [],
	bcc: [],
	subject: 'Weekly notes',
	textBodyInline: 'Plain notes for the week.',
	messageId: '<weekly-1@example.com>',
	receivedAt: 1_700_000_000_000,
	attachments: [],
	...overrides,
});

const filter = (actions: Array<Record<string, unknown>>): Doc<'mailFilters'> =>
	({
		_id: 'filter-1',
		_creationTime: 0,
		mailboxId,
		name: 'news',
		isEnabled: true,
		priority: 1,
		conditions: [{ field: 'from', op: 'contains', value: 'news@' }],
		actions,
		stopProcessing: false,
		createdAt: 0,
		updatedAt: 0,
	}) as unknown as Doc<'mailFilters'>;

const mailbox = { _id: mailboxId, address: 'me@owlat.test' } as Doc<'mailboxes'>;
const folder = (role?: Doc<'mailFolders'>['role']) =>
	({ _id: projectsId, mailboxId, ...(role ? { role } : {}) }) as Doc<'mailFolders'>;

describe('filterDelivery', () => {
	it('normalises the sender, scores a missing verdict and keeps a supplied one', () => {
		expect(filterDelivery(args(), [])).toMatchObject({
			fromAddress: 'news@example.com',
			spamVerdict: 'ham',
		});
		expect(filterDelivery(args({ spamScore: 3, spamVerdict: 'quarantine' }), [])).toMatchObject({
			spamScore: 3,
			spamVerdict: 'quarantine',
		});
	});

	it("reduces the mailbox's filters to the delivery outcome", () => {
		const { filter: outcome } = filterDelivery(args(), [
			filter([
				{ type: 'moveToFolder', folderId: projectsId },
				{ type: 'addLabel', labelId },
			]),
		]);
		expect(outcome).toMatchObject({
			isDiscarded: false,
			folderId: projectsId,
			labelIds: [labelId],
		});
		expect(filterDelivery(args(), [filter([{ type: 'discard' }])]).filter.isDiscarded).toBe(true);
	});
});

describe('routeDelivery and targetFolderRole', () => {
	const route = (overrides: Partial<MailboxDeliveryArgs>, filters: Doc<'mailFilters'>[] = []) =>
		routeDelivery(args(overrides), filterDelivery(args(overrides), filters), undefined);

	it('quarantines spam, infected mail and an enforced DMARC fail into spam', () => {
		for (const overrides of [
			{ spamVerdict: 'spam' as const },
			{ virusVerdict: 'infected' as const },
			{ dmarcResult: 'fail', dmarcPolicy: 'reject' },
		]) {
			const routing = route(overrides);
			expect(routing).toMatchObject({ isQuarantined: true, isMovedByFilter: true });
			expect(targetFolderRole(routing, { status: 'auto_archive', filedTo: 'archive' })).toBe(
				'spam'
			);
		}
	});

	it('trashes a deleted message and lets sender status file the rest', () => {
		const trashed = route({}, [filter([{ type: 'delete' }])]);
		expect(trashed).toMatchObject({ isQuarantined: false, isMovedByFilter: true });
		expect(targetFolderRole(trashed, null)).toBe('trash');
		const plain = route({});
		expect(plain.isMovedByFilter).toBe(false);
		expect(targetFolderRole(plain, null)).toBe('inbox');
		expect(targetFolderRole(plain, { status: 'auto_archive', filedTo: 'archive' })).toBe('archive');
	});

	it('counts a filter folder as moved, so sender status keeps out', () => {
		const moved = route({}, [filter([{ type: 'moveToFolder', folderId: projectsId }])]);
		expect(moved).toMatchObject({ isQuarantined: false, isMovedByFilter: true });
	});
});

describe('the insert, the hook and the answer', () => {
	const filters = [
		filter([
			{ type: 'markRead' },
			{ type: 'pinToSection', sectionName: 'News' },
			{ type: 'forward', forwardTo: 'archive@owlat.example' },
		]),
	];
	const routing = routeDelivery(args(), filterDelivery(args(), filters), undefined);

	it('writes the filter flags, the section and the hosted-path markers', () => {
		const input = deliveredMessageInput(args(), routing, {
			mailbox,
			folder: folder('inbox'),
			senderStatus: null,
			senderHeuristics: undefined,
		});
		expect(input).toMatchObject({
			flagSeen: true,
			flagFlagged: false,
			pinnedSection: 'News',
			spamVerdict: 'ham',
			countUsedBytes: true,
			inboundOrigin: 'mx',
		});
		const unread = routeDelivery(args(), filterDelivery(args(), []), undefined);
		expect(
			deliveredMessageInput(args(), unread, {
				mailbox,
				folder: folder('inbox'),
				senderStatus: { status: 'auto_archive', filedTo: 'archive' },
				senderHeuristics: undefined,
			}).flagSeen
		).toBe(true);
	});

	it('hands the hook the forward targets and defaults the headers', () => {
		expect(postDeliveryHookArgs(args(), routing, mailbox, messageId)).toMatchObject({
			mailboxId,
			mailboxAddress: 'me@owlat.test',
			fromAddress: 'news@example.com',
			headers: {},
			filterForwardTo: ['archive@owlat.example'],
		});
	});

	it('answers with the folder role and verdict only when present', () => {
		expect(deliveryAnswer(messageId, routing, folder('inbox'))).toEqual({
			messageId,
			dmarcOverride: undefined,
			folderRole: 'inbox',
			spamVerdict: 'ham',
		});
		const noVerdict = { ...routing, spamVerdict: undefined };
		expect(deliveryAnswer(messageId, noVerdict, folder())).toEqual({
			messageId,
			dmarcOverride: undefined,
		});
	});

	it('gives the same plan for the same input', () => {
		expect(routeDelivery(args(), filterDelivery(args(), filters), [])).toEqual(
			routeDelivery(args(), filterDelivery(args(), filters), [])
		);
	});
});
