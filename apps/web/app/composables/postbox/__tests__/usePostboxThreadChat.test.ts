/**
 * Which messages of a thread show as chat bubbles: only ordinary mail, never
 * a signed or encrypted message or one whose card must show, and a message
 * opened in full goes back to its bubble. The switch shows at once and
 * stores the choice for the thread.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';
import { createTestI18n } from '~/__tests__/i18n';
import { usePostboxThreadChat } from '../usePostboxThreadChat';
import type { PostboxReaderMessage } from '../postboxReaderMessage';

const i18n = createTestI18n();
const stored = ref<string | null | undefined>(undefined);
const run = vi.fn(async (_args: unknown) => ({ ok: true }));

beforeEach(() => {
	stored.value = 'chat';
	run.mockClear();
	vi.stubGlobal('useI18n', () => i18n.global);
	vi.stubGlobal('useConvexQuery', () => ({ data: stored }));
	vi.stubGlobal('useBackendOperation', () => ({ run, isLoading: ref(false) }));
});

function message(id: string, fromAddress = 'sam@fabrikam.example'): PostboxReaderMessage {
	return {
		_id: id,
		mailboxId: 'mb_1',
		threadId: 'th_1',
		fromAddress,
		toAddresses: [],
		ccAddresses: [],
		subject: 'Lunch',
		receivedAt: 0,
		hasAttachments: false,
		attachments: [],
	};
}

function setup(opts: { signed?: string[]; cards?: string[]; shared?: boolean } = {}) {
	const expanded = ref(new Set<string>());
	const scope = effectScope();
	const chat = scope.run(() =>
		usePostboxThreadChat({
			threadId: () => 'th_1',
			isShared: () => opts.shared ?? false,
			ownAddresses: ref(new Set(['dev@demo.localhost'])),
			expanded,
			toggleExpanded: (id) => {
				const next = new Set(expanded.value);
				if (next.has(id)) next.delete(id);
				else next.add(id);
				expanded.value = next;
			},
			isPlain: (msg) => !(opts.signed ?? []).includes(msg._id),
			needsCard: (id) => (opts.cards ?? []).includes(id),
			previewAttachment: vi.fn(),
			downloadAttachment: vi.fn(),
		})
	)!;
	return { chat, expanded };
}

describe('usePostboxThreadChat', () => {
	it('shows ordinary mail as bubbles and signed or encrypted mail as its card', () => {
		const { chat } = setup({ signed: ['m_signed'] });
		expect(chat.isBubble(message('m_plain'))).toBe(true);
		expect(chat.isBubble(message('m_signed'))).toBe(false);
		expect(chat.isShownFull('m_signed')).toBe(false);
	});

	it('keeps a card that must show, and one whose body turned out to be secure', () => {
		const { chat } = setup({ cards: ['m_cited'] });
		expect(chat.isBubble(message('m_cited'))).toBe(false);
		chat.keepCard('m_clearsigned');
		expect(chat.isBubble(message('m_clearsigned'))).toBe(false);
		// No "Back to chat" for it: the bubble would only hand it back again.
		expect(chat.isShownFull('m_clearsigned')).toBe(false);
	});

	it('opens one message in full, expanded, and takes it back to its bubble', () => {
		const { chat, expanded } = setup();
		chat.showFull('m_1');
		expect(chat.isBubble(message('m_1'))).toBe(false);
		expect(chat.isShownFull('m_1')).toBe(true);
		expect(expanded.value.has('m_1')).toBe(true);
		chat.showBubble('m_1');
		expect(chat.isBubble(message('m_1'))).toBe(true);
	});

	it('switches at once and stores the choice for the thread', async () => {
		const { chat } = setup();
		const done = chat.toggle();
		expect(chat.isOn.value).toBe(false);
		expect(chat.isBubble(message('m_1'))).toBe(false);
		await done;
		expect(run).toHaveBeenCalledWith({ threadId: 'th_1', view: 'conversation' });
	});

	it('offers nothing in a team inbox', () => {
		const { chat } = setup({ shared: true });
		expect(chat.isAvailable.value).toBe(false);
		expect(chat.isBubble(message('m_1'))).toBe(false);
	});

	it('knows the viewer’s own messages', () => {
		const { chat } = setup();
		expect(chat.isOwn(message('m_1', 'Dev Admin <dev@demo.localhost>'))).toBe(true);
		expect(chat.isOwn(message('m_2'))).toBe(false);
	});
});
