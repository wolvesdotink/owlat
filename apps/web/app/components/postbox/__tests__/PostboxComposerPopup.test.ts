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
	emits: ['sent', 'discarded', 'minimize'],
	template: '<div data-testid="composer" />',
});

const stackClose = vi.fn();
const undoArm = vi.fn();

beforeEach(() => {
	stackClose.mockClear();
	undoArm.mockClear();
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('usePostboxComposerStack', () => ({
		focusedId: ref(null),
		close: stackClose,
		minimize: vi.fn(),
		unfocus: vi.fn(),
	}));
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

	it('closes after a send without arming undo itself', () => {
		mountPopup().getComponent(ComposerStub).vm.$emit('sent', { scheduled: false });
		expect(stackClose).toHaveBeenCalledWith('cmp-1');
		expect(undoArm).not.toHaveBeenCalled();
	});
});
