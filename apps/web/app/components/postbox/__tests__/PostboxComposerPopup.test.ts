// @vitest-environment happy-dom
/**
 * The floating popup hands its stack entry to the composer as the seed, whole,
 * and after a send only closes (issue #864, finding 6). The undo window is
 * armed by the composer's send(), so the popup must not arm it a second time.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, ref } from 'vue';
import { mount } from '@vue/test-utils';

import PostboxComposerPopup from '../PostboxComposerPopup.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import type { ComposerSpec } from '~/composables/postbox/usePostboxComposerStack';

const ComposerStub = defineComponent({
	name: 'PostboxComposer',
	props: {
		seed: { type: Object, required: true },
		replyAllRecipients: { type: Array, default: undefined },
	},
	emits: ['sent', 'discarded', 'minimize', 'maximise'],
	template: '<div data-testid="composer" />',
});

const stackClose = vi.fn();
const stackMinimize = vi.fn();
const undoArm = vi.fn();
const navigateTo = vi.fn();

beforeEach(() => {
	stackClose.mockClear();
	stackMinimize.mockClear();
	undoArm.mockClear();
	navigateTo.mockClear();
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('usePostboxComposerStack', () => ({
		close: stackClose,
		minimize: stackMinimize,
	}));
	const state = new Map<string, ReturnType<typeof ref>>();
	vi.stubGlobal('useState', (key: string, init: () => unknown) => {
		if (!state.has(key)) state.set(key, ref(init()));
		return state.get(key);
	});
	vi.stubGlobal('useRouter', () => ({
		currentRoute: ref({ path: '/dashboard/postbox/inbox', fullPath: '/dashboard/postbox/inbox' }),
	}));
	vi.stubGlobal('navigateTo', navigateTo);
	vi.stubGlobal('usePostboxComposerSize', () => ({
		size: ref({ width: 520, height: 560 }),
		setSize: vi.fn(),
	}));
	// Present only to prove the popup no longer arms undo-send on its own.
	vi.stubGlobal('usePostboxUndoSend', () => ({ arm: undoArm }));
});

const composer: ComposerSpec = {
	id: 'cmp-1',
	minimized: false,
	mailboxId: 'mbx-1' as ComposerSpec['mailboxId'],
	draftId: 'draft-1' as NonNullable<ComposerSpec['draftId']>,
	prefillTo: ['ada@example.com'],
	prefillAttachments: [
		{ storageId: 'st-1', filename: 'a.pdf', contentType: 'application/pdf', size: 10 } as never,
	],
	attachPendingKey: 'pending-1',
	replyAllRecipients: ['bob@example.com'],
};

function mountPopup() {
	return mount(PostboxComposerPopup, {
		props: { composer, slotIndex: 0 },
		global: {
			plugins: [createTestI18n()],
			components: { PostboxComposer: ComposerStub },
			stubs: { teleport: true },
		},
	});
}

describe('PostboxComposerPopup', () => {
	it('passes its stack entry to the composer as the seed', () => {
		const stub = mountPopup().getComponent(ComposerStub);
		expect(stub.props('seed')).toMatchObject({
			mailboxId: 'mbx-1',
			draftId: 'draft-1',
			prefillTo: ['ada@example.com'],
			prefillAttachments: composer.prefillAttachments,
			attachPendingKey: 'pending-1',
		});
		expect(stub.props('replyAllRecipients')).toEqual(['bob@example.com']);
	});

	it('docks on Esc, but not on an Esc a popover inside already claimed', () => {
		const root = mountPopup().get('[role="region"]').element;
		const claimed = new KeyboardEvent('keydown', {
			key: 'Escape',
			bubbles: true,
			cancelable: true,
		});
		claimed.preventDefault();
		root.dispatchEvent(claimed);
		expect(stackMinimize).not.toHaveBeenCalled();

		root.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
		);
		expect(stackMinimize).toHaveBeenCalledWith('cmp-1');
	});

	it('closes after a send without arming undo itself', () => {
		mountPopup().getComponent(ComposerStub).vm.$emit('sent', { scheduled: false });
		expect(stackClose).toHaveBeenCalledWith('cmp-1');
		expect(undoArm).not.toHaveBeenCalled();
	});

	it('is a resizable box anchored bottom right on a wide screen', () => {
		const box = mountPopup().get('[role="region"]');
		expect(box.attributes('data-geometry')).toBe('box');
		expect(box.attributes('style')).toContain('width: 520px');
		expect(box.find('.cursor-nwse-resize').exists()).toBe(true);
	});

	it('becomes a full-width bottom sheet without a resize grip on a phone', () => {
		const realMatchMedia = window.matchMedia;
		window.matchMedia = ((query: string) => ({
			matches: query.includes('max-width'),
			media: query,
			addEventListener: () => {},
			removeEventListener: () => {},
		})) as unknown as typeof window.matchMedia;
		try {
			const sheet = mountPopup().get('[role="region"]');
			expect(sheet.attributes('data-geometry')).toBe('sheet');
			expect(sheet.attributes('style')).toContain('left: 0px');
			expect(sheet.attributes('style')).not.toContain('width: 520px');
			expect(sheet.classes()).toContain('rounded-t-xl');
			expect(sheet.find('.cursor-nwse-resize').exists()).toBe(false);
		} finally {
			window.matchMedia = realMatchMedia;
		}
	});

	it('moves a reply into Answer mode on maximise, on the same draft', async () => {
		const wrapper = mount(PostboxComposerPopup, {
			props: { composer: { ...composer, inReplyToMessageId: 'msg-9' as never }, slotIndex: 0 },
			global: {
				plugins: [createTestI18n()],
				components: { PostboxComposer: ComposerStub },
				stubs: { teleport: true },
			},
		});
		wrapper.getComponent(ComposerStub).vm.$emit('maximise', 'draft-1');
		expect(stackClose).toHaveBeenCalledWith('cmp-1');
		expect(navigateTo).toHaveBeenCalledWith('/dashboard/answer/m/msg-9?draft=draft-1');
	});
});
