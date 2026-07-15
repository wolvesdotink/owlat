/**
 * usePostboxReaderComposer × reply guard (Sealed Mail A3).
 *
 * Proves the sender-auth reply guard can't be side-stepped by the IN-COMPOSER
 * reply paths — the ones the reader's keyboard `r`/`a`, the pinned inline box,
 * and the list→reader hand-off all funnel through. Every reply / reply-all
 * entry point that lives in this composable must route through the injected
 * `guardReply`; forward must NOT.
 *
 * The heavy Nuxt/project auto-imports the composable leans on (the composer
 * stack, the compose-seed builders, the pending-compose state) are stubbed so
 * the test can isolate the guard routing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ref, computed, nextTick, effectScope, type EffectScope } from 'vue';
import type { PostboxPendingCompose } from '~/utils/postboxShortcuts';

const composerOpen = vi.fn();
const pendingCompose = ref<PostboxPendingCompose | null>(null);

// Each composer's watchers live in their own scope so they die with the test
// that created them — otherwise a leaked watcher from an earlier test would
// flush first and consume the shared `pendingCompose` intent (see round-2).
const scopes: EffectScope[] = [];

vi.stubGlobal('usePostboxComposerStack', () => ({ open: composerOpen }));
vi.stubGlobal('useState', () => pendingCompose);
vi.stubGlobal('POSTBOX_PENDING_COMPOSE_KEY', 'postbox:pending-compose');
vi.stubGlobal('resolveBodyFields', async (source: unknown) => source);
vi.stubGlobal('buildReplySpec', (mailboxId: string) => ({ mailboxId }));
vi.stubGlobal('buildForwardedBody', () => '');
// Faithful reimplementation of the pure helper (auto-imported in the composable).
vi.stubGlobal(
	'settlePendingCompose',
	(pending: PostboxPendingCompose | null, messageId: string, previousMessageId?: string) => {
		if (!pending) return { open: null, clear: false };
		if (pending.messageId === messageId) return { open: pending.mode, clear: true };
		return { open: null, clear: messageId !== previousMessageId };
	}
);

import { usePostboxReaderComposer } from '../usePostboxReaderComposer';

const MSG_ID = 'msg_1';

function makeComposer(guardReply: (run: () => void) => void) {
	const message = {
		_id: MSG_ID,
		mailboxId: 'mbx_1',
		threadId: 'thr_1',
		subject: 'Hi',
		fromAddress: 'sender@evil.example',
		fromName: 'Sender',
		toAddresses: [],
		ccAddresses: [],
		receivedAt: 0,
	};
	const scope = effectScope();
	scopes.push(scope);
	const composer = scope.run(() =>
		usePostboxReaderComposer({
			getMessage: () => message,
			latestMessage: computed(() => message),
			ownAddresses: computed(() => new Set<string>()),
			replyDefault: ref('reply'),
			guardReply,
		})
	);
	// `scope.run` returns undefined only if the scope is already inactive; a
	// freshly created scope always yields the composer.
	return composer!;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
	composerOpen.mockClear();
	pendingCompose.value = null;
});

afterEach(() => {
	// Tear down each composer's watchers so they can't leak into the next test
	// and consume its shared `pendingCompose` intent first.
	while (scopes.length > 0) scopes.pop()!.stop();
});

describe('usePostboxReaderComposer reply guard routing', () => {
	it('the keyboard/inline reply path runs through the guard, then opens the box', async () => {
		const guardReply = vi.fn();
		const { guardedExpandReply, inlineSpec } = makeComposer(guardReply);

		guardedExpandReply();
		expect(guardReply).toHaveBeenCalledTimes(1);
		// The box does not expand until the guard lets the reply through.
		expect(inlineSpec.value).toBeNull();

		await guardReply.mock.calls[0]![0]!();
		await flush();
		expect(inlineSpec.value).not.toBeNull();
	});

	it('the keyboard/inline reply-all path runs through the guard', async () => {
		const guardReply = vi.fn();
		const { guardedExpandReplyAll, inlineSpec } = makeComposer(guardReply);

		guardedExpandReplyAll();
		expect(guardReply).toHaveBeenCalledTimes(1);

		await guardReply.mock.calls[0]![0]!();
		await flush();
		expect(inlineSpec.value?.kind).toBe('replyAll');
	});

	it('the list→reader hand-off guards reply, but never forward', async () => {
		const guardReply = vi.fn();
		const { inlineSpec } = makeComposer(guardReply);

		// r on a list row: the pending intent is consumed here and guarded.
		pendingCompose.value = { messageId: MSG_ID, mode: 'reply' };
		await nextTick();
		expect(guardReply).toHaveBeenCalledTimes(1);

		// f on a list row: forward is a non-reply action and bypasses the guard.
		guardReply.mockClear();
		pendingCompose.value = { messageId: MSG_ID, mode: 'forward' };
		await nextTick();
		await flush();
		expect(guardReply).not.toHaveBeenCalled();
		expect(inlineSpec.value?.kind).toBe('forward');
	});
});
