/**
 * Conformance pins for the open conversation's palette verbs (Postbox reader and
 * Team Inbox thread page): which verbs show in which state, that a verb with a
 * parameter is ONE row with a submenu, and that every row runs the handler it
 * was given (the reader's own action, never a broadcast).
 */
import { describe, it, expect, vi } from 'vitest';
import type { PaletteArgumentOption, PaletteItem } from '../commandPalette';
import { flattenGroups, mergeGroups } from '../commandPalette';
import { resolvePaletteGroups } from '../commandPaletteRegistry';
import {
	POSTBOX_THREAD_COMMAND_GROUP_KEY,
	POSTBOX_THREAD_COMMAND_PROVIDER_PRIORITY,
	TEAM_THREAD_COMMAND_GROUP_KEY,
	type TeamThreadSurfaceDeps,
	type ThreadSurfaceDeps,
	buildTeamThreadSurfaceGroups,
	buildThreadSurfaceGroups,
} from '../commandPaletteThreadSurfaces';
import { POSTBOX_COMMAND_PROVIDER_PRIORITY } from '~/composables/postbox/usePostboxCommandSurface';
import { createTestI18n } from '~/__tests__/i18n';

const { t } = createTestI18n().global;
const translate = (key: string) => t(key);

function option(id: string, run = vi.fn()): PaletteArgumentOption {
	return { id, label: id, run };
}

function postboxDeps(overrides: Partial<ThreadSurfaceDeps> = {}): ThreadSurfaceDeps {
	return {
		subject: () => 'Invoice #12',
		t: translate,
		isMuted: () => false,
		isAlerted: () => false,
		isPinned: () => false,
		followUp: () => 'none',
		canTranslate: () => true,
		snoozeOptions: () => [option('snooze-0')],
		labelOptions: () => [option('label-work')],
		folderOptions: () => [option('folder-archive')],
		followUpOptions: () => [option('follow-up-tomorrow')],
		onReply: vi.fn(),
		onArchive: vi.fn(),
		onForward: vi.fn(),
		onMarkUnread: vi.fn(),
		onToggleMute: vi.fn(),
		onToggleAlert: vi.fn(),
		onTogglePin: vi.fn(),
		onCancelFollowUp: vi.fn(),
		onShowOriginal: vi.fn(),
		onTranslate: vi.fn(),
		onCopyLink: vi.fn(),
		canShareInChat: () => true,
		onShareInChat: vi.fn(),
		...overrides,
	};
}

function postboxItems(query = '', overrides: Partial<ThreadSurfaceDeps> = {}): PaletteItem[] {
	const [group] = buildThreadSurfaceGroups(postboxDeps(overrides), query);
	return group?.items ?? [];
}

const byId = (items: PaletteItem[], id: string) => items.find((item) => item.id === id);

describe('buildThreadSurfaceGroups (Postbox reader)', () => {
	it('offers every verb of the open conversation, in the reader’s order', () => {
		expect(postboxItems().map((item) => [item.id, item.label])).toEqual([
			['postbox:thread-reply', 'Reply'],
			['postbox:thread-archive', 'Archive conversation'],
			['postbox:thread-snooze', 'Snooze…'],
			['postbox:forward', 'Forward'],
			['postbox:thread-mark-unread', 'Mark as unread'],
			['postbox:thread-mute', 'Mute conversation'],
			['postbox:thread-alert', 'Notify me when they reply'],
			['postbox:thread-pin', 'Pin conversation'],
			['postbox:label-as', 'Label as…'],
			['postbox:move', 'Move to…'],
			['postbox:thread-translate', 'Translate'],
			['postbox:thread-original', 'Download original (.eml)'],
			['postbox:thread-copy-link', 'Copy link'],
			['postbox:thread-share-in-chat', 'Share in chat…'],
		]);
	});

	it('claims the commands mode at order 0, the full list once typed, six rows idle', () => {
		const [idle] = buildThreadSurfaceGroups(postboxDeps(), '');
		expect(idle).toMatchObject({
			key: POSTBOX_THREAD_COMMAND_GROUP_KEY,
			order: 0,
			mode: 'commands',
		});
		expect(idle?.cap).toBe(6);
		const [typed] = buildThreadSurfaceGroups(postboxDeps(), 'o');
		expect(typed?.cap).toBeGreaterThanOrEqual(postboxItems().length);
		// `>` with nothing typed yet asked for the commands: all of them.
		const [asked] = buildThreadSurfaceGroups(postboxDeps(), '', 'commands');
		expect(asked?.cap).toBeGreaterThanOrEqual(postboxItems().length);
	});

	it('names the state each toggle leads to', () => {
		const items = postboxItems('', {
			isMuted: () => true,
			isAlerted: () => true,
			isPinned: () => true,
		});
		expect(byId(items, 'postbox:thread-mute')?.label).toBe('Unmute conversation');
		expect(byId(items, 'postbox:thread-alert')?.label).toBe('Stop notifying me on reply');
		expect(byId(items, 'postbox:thread-pin')?.label).toBe('Unpin conversation');
	});

	it('makes each parameter verb ONE row with a submenu, and never runs the row itself', () => {
		const items = postboxItems();
		for (const id of ['postbox:thread-snooze', 'postbox:label-as', 'postbox:move']) {
			const row = byId(items, id)!;
			expect(row.argument?.options.length).toBeGreaterThan(0);
			expect(t(row.argument!.promptKey)).not.toBe(row.argument!.promptKey);
		}
		const run = vi.fn();
		const snooze = byId(
			postboxItems('', { snoozeOptions: () => [option('snooze-0', run)] }),
			'postbox:thread-snooze'
		);
		snooze?.argument?.options[0]?.run();
		expect(run).toHaveBeenCalledTimes(1);
	});

	it('leaves out a submenu verb with nothing to choose from', () => {
		const items = postboxItems('', { labelOptions: () => [], folderOptions: () => [] });
		expect(byId(items, 'postbox:label-as')).toBeUndefined();
		expect(byId(items, 'postbox:move')).toBeUndefined();
	});

	it('offers the reply reminder by state: arm on our own last mail, cancel once armed', () => {
		expect(byId(postboxItems(), 'postbox:thread-follow-up')).toBeUndefined();
		const armable = byId(
			postboxItems('', { followUp: () => 'armable' }),
			'postbox:thread-follow-up'
		);
		expect(armable?.label).toBe('Remind me if no reply…');
		expect(armable?.argument?.options.map((o) => o.id)).toEqual(['follow-up-tomorrow']);
		const onCancelFollowUp = vi.fn();
		const armed = byId(
			postboxItems('', { followUp: () => 'armed', onCancelFollowUp }),
			'postbox:thread-follow-up'
		);
		expect(armed?.label).toBe('Cancel reply reminder');
		armed?.run();
		expect(onCancelFollowUp).toHaveBeenCalledTimes(1);
	});

	it('offers Translate only when translation is available', () => {
		expect(
			byId(postboxItems('', { canTranslate: () => false }), 'postbox:thread-translate')
		).toBeUndefined();
	});

	it('runs exactly the handler each row was handed', () => {
		const deps = postboxDeps();
		const all = buildThreadSurfaceGroups(deps, '')[0]!.items;
		const handlers: Array<[string, keyof ThreadSurfaceDeps]> = [
			['postbox:thread-reply', 'onReply'],
			['postbox:thread-archive', 'onArchive'],
			['postbox:forward', 'onForward'],
			['postbox:thread-mark-unread', 'onMarkUnread'],
			['postbox:thread-mute', 'onToggleMute'],
			['postbox:thread-alert', 'onToggleAlert'],
			['postbox:thread-pin', 'onTogglePin'],
			['postbox:thread-translate', 'onTranslate'],
			['postbox:thread-original', 'onShowOriginal'],
			['postbox:thread-copy-link', 'onCopyLink'],
			['postbox:thread-share-in-chat', 'onShareInChat'],
		];
		for (const [id, handler] of handlers) {
			byId(all, id)!.run();
			expect(deps[handler], id).toHaveBeenCalledTimes(1);
		}
	});

	it('names the reader keys of the verbs that have one, for the row chips', () => {
		const items = postboxItems();
		expect(byId(items, 'postbox:thread-reply')?.shortcutId).toBe('postbox.reply');
		expect(byId(items, 'postbox:thread-archive')?.shortcutId).toBe('postbox.archive');
		expect(byId(items, 'postbox:forward')?.shortcutId).toBe('postbox.forward');
		expect(byId(items, 'postbox:thread-mark-unread')?.shortcutId).toBe('postbox.markUnread');
	});

	it('offers Share in chat only while chat is on', () => {
		expect(
			byId(postboxItems('', { canShareInChat: () => false }), 'postbox:thread-share-in-chat')
		).toBeUndefined();
		expect(
			byId(postboxItems('', { canShareInChat: () => false }), 'postbox:thread-copy-link')
		).toBeDefined();
	});

	it('drops the subject line when the message has no subject', () => {
		expect(
			postboxItems('', { subject: () => '   ' }).every((item) => item.subtitle === undefined)
		).toBe(true);
	});

	it('filters itself by the palette query', () => {
		expect(postboxItems('copy').map((item) => item.id)).toEqual(['postbox:thread-copy-link']);
	});

	it('is consulted before the mailbox provider, so its shared ids win over the broadcast twins', () => {
		expect(POSTBOX_THREAD_COMMAND_PROVIDER_PRIORITY).toBeLessThan(
			POSTBOX_COMMAND_PROVIDER_PRIORITY
		);
		const onForward = vi.fn();
		const broadcast = vi.fn();
		const groups = resolvePaletteGroups(
			[],
			[
				{
					id: 'surface:postbox',
					priority: POSTBOX_COMMAND_PROVIDER_PRIORITY,
					build: () => [
						{
							key: 'postbox-actions',
							heading: 'Mailbox',
							order: 0,
							items: [
								{ id: 'postbox:forward', label: 'Forward', icon: 'lucide:forward', run: broadcast },
							],
						},
					],
				},
				{
					id: 'surface:postbox-thread:1',
					priority: POSTBOX_THREAD_COMMAND_PROVIDER_PRIORITY,
					build: ({ query }) => buildThreadSurfaceGroups(postboxDeps({ onForward }), query),
				},
			],
			{ path: '/dashboard/postbox/inbox/m1', isFlagEnabled: () => true },
			{ query: 'forward', mode: 'all' }
		);
		const rows = flattenGroups(mergeGroups(groups)).filter((item) => item.id === 'postbox:forward');
		expect(rows).toHaveLength(1);
		rows[0]!.run();
		expect(onForward).toHaveBeenCalledTimes(1);
		expect(broadcast).not.toHaveBeenCalled();
	});
});

function teamDeps(overrides: Partial<TeamThreadSurfaceDeps> = {}): TeamThreadSurfaceDeps {
	return {
		subject: () => 'Invoice 4471',
		t: translate,
		isMine: () => false,
		isResolved: () => false,
		isSnoozed: () => false,
		assignOptions: () => [option('assign-u1')],
		snoozeOptions: () => [option('snooze-0')],
		priorityOptions: () => [option('priority-urgent')],
		onReply: vi.fn(),
		onClaim: vi.fn(),
		onClose: vi.fn(),
		onReopen: vi.fn(),
		onUnsnooze: vi.fn(),
		onAddNote: vi.fn(),
		onCopyLink: vi.fn(),
		canShareInChat: () => true,
		onShareInChat: vi.fn(),
		...overrides,
	};
}

function teamItems(overrides: Partial<TeamThreadSurfaceDeps> = {}, query = ''): PaletteItem[] {
	const [group] = buildTeamThreadSurfaceGroups(teamDeps(overrides), query);
	return group?.items ?? [];
}

describe('buildTeamThreadSurfaceGroups (Team Inbox thread)', () => {
	it('offers reply, assign ›, claim, resolve, snooze ›, a note, priority › and its link', () => {
		const [group] = buildTeamThreadSurfaceGroups(teamDeps(), '');
		expect(group).toMatchObject({ key: TEAM_THREAD_COMMAND_GROUP_KEY, order: 0, mode: 'commands' });
		expect(teamItems().map((item) => [item.id, item.label, !!item.argument])).toEqual([
			['inbox:thread-reply', 'Reply', false],
			['inbox:thread-assign', 'Assign to…', true],
			['inbox:thread-claim', 'Assign to me', false],
			['inbox:thread-status', 'Mark as resolved', false],
			['inbox:thread-snooze', 'Snooze…', true],
			['inbox:thread-note', 'Add internal note', false],
			['inbox:thread-priority', 'Set priority…', true],
			['inbox:thread-copy-link', 'Copy link', false],
			['inbox:thread-share-in-chat', 'Share in chat…', false],
		]);
		expect(
			byId(teamItems({ canShareInChat: () => false }), 'inbox:thread-share-in-chat')
		).toBeUndefined();
	});

	it('follows the thread’s state: no claim once mine, reopen once resolved, wake once snoozed', () => {
		const deps = teamDeps({ isMine: () => true, isResolved: () => true, isSnoozed: () => true });
		const items = buildTeamThreadSurfaceGroups(deps, '')[0]!.items;
		expect(byId(items, 'inbox:thread-claim')).toBeUndefined();
		const status = byId(items, 'inbox:thread-status')!;
		expect(status.label).toBe('Reopen conversation');
		status.run();
		expect(deps.onReopen).toHaveBeenCalledTimes(1);
		const snooze = byId(items, 'inbox:thread-snooze')!;
		expect(snooze.label).toBe('Unsnooze');
		expect(snooze.argument).toBeUndefined();
		snooze.run();
		expect(deps.onUnsnooze).toHaveBeenCalledTimes(1);
	});

	it('runs each handler once', () => {
		const deps = teamDeps();
		const items = buildTeamThreadSurfaceGroups(deps, '')[0]!.items;
		byId(items, 'inbox:thread-reply')!.run();
		byId(items, 'inbox:thread-claim')!.run();
		byId(items, 'inbox:thread-status')!.run();
		byId(items, 'inbox:thread-note')!.run();
		byId(items, 'inbox:thread-copy-link')!.run();
		byId(items, 'inbox:thread-share-in-chat')!.run();
		expect(deps.onCopyLink).toHaveBeenCalledTimes(1);
		expect(deps.onShareInChat).toHaveBeenCalledTimes(1);
		expect(deps.onReply).toHaveBeenCalledTimes(1);
		expect(deps.onClaim).toHaveBeenCalledTimes(1);
		expect(deps.onClose).toHaveBeenCalledTimes(1);
		expect(deps.onAddNote).toHaveBeenCalledTimes(1);
	});

	it('filters itself by the palette query', () => {
		expect(teamItems({}, 'priority').map((item) => item.id)).toEqual(['inbox:thread-priority']);
	});
});
