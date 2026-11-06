/**
 * Ask your mailbox in the palette: the question goes to the mail answer, and a
 * citation opens the message it cites, in the mailbox it lives in, after the
 * palette has closed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { getFunctionName, type FunctionReference } from 'convex/server';
import type { MailAskAnswer, MailAskCitation } from '../useCommandPaletteMailAsk';

let events: string[];
let navigations: unknown[];
let runArgs: unknown[];
let operation: string | null;
let result: MailAskAnswer;

const citation: MailAskCitation = {
	index: 1,
	messageId: 'message-1' as Id<'mailMessages'>,
	mailboxId: 'team-inbox' as Id<'mailboxes'>,
	folderId: 'folder-inbox' as Id<'mailFolders'>,
	threadId: 'thread-1' as Id<'mailThreads'>,
	subject: 'Lisbon flight',
	from: 'Airline',
	date: Date.parse('2026-10-02T09:00:00Z'),
};

beforeEach(() => {
	events = [];
	navigations = [];
	runArgs = [];
	operation = null;
	result = {
		answer: 'It leaves at 7:40 [1].',
		citations: [citation],
		bodySearchUsed: false,
		isTruncated: false,
	};
	vi.stubGlobal('useI18n', () => ({ t: (key: string) => key }));
	vi.stubGlobal('usePostboxActiveMailbox', () => ({
		activeMailboxId: ref(null),
		setActiveMailboxId: (id: string) => events.push(`mailbox:${id}`),
	}));
	vi.stubGlobal('useBackendOperation', (fn: FunctionReference<'action'>) => {
		operation = getFunctionName(fn);
		return {
			run: vi.fn(async (args: unknown) => {
				runArgs.push(args);
				return { ok: true, result };
			}),
			isLoading: ref(false),
		};
	});
	vi.stubGlobal('navigateTo', (to: unknown) => {
		events.push('navigate');
		navigations.push(to);
		return Promise.resolve();
	});
});

async function mailAsk() {
	vi.resetModules();
	const { useCommandPaletteMailAsk } = await import('../useCommandPaletteMailAsk');
	return useCommandPaletteMailAsk({ onNavigate: () => events.push('close') });
}

describe('useCommandPaletteMailAsk', () => {
	it('asks the mail answer, not the knowledge one, with the trimmed question', async () => {
		const scope = await mailAsk();
		await scope.ask('  When does my flight to Lisbon leave?  ');

		expect(operation).toBe(getFunctionName(api.mail.ai.askMailbox.askMailbox));
		expect(runArgs).toEqual([{ question: 'When does my flight to Lisbon leave?' }]);
		expect(scope.answer.value).toEqual(result);
		expect(scope.askedQuestion.value).toBe('When does my flight to Lisbon leave?');
	});

	it('does not ask an empty question', async () => {
		const scope = await mailAsk();
		await scope.ask('   ');
		expect(runArgs).toEqual([]);
	});

	it("opens a citation's message in its folder, after selecting its mailbox", async () => {
		const scope = await mailAsk();
		scope.openCitation(citation);

		expect(navigations).toEqual([{ path: '/dashboard/postbox/folder-inbox/message-1' }]);
		// The palette closes first; a team inbox message needs its mailbox
		// selected before the route opens, or the thread reads as not found.
		expect(events).toEqual(['close', 'mailbox:team-inbox', 'navigate']);
	});

	it('forgets the answer on reset', async () => {
		const scope = await mailAsk();
		await scope.ask('flight');
		scope.reset();
		expect(scope.answer.value).toBeNull();
		expect(scope.askedQuestion.value).toBe('');
	});
});
