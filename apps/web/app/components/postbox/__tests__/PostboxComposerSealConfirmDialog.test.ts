// @vitest-environment happy-dom
/**
 * PostboxComposerSealConfirmDialog — the unsealed-send decision (Sealed Mail E5).
 *
 * The load-bearing behaviour: a message that can't be sealed only goes out after
 * the sender proceeds HERE, with the reason and the cost of plaintext in front of
 * them, and cancelling closes without sending. States that are not the sender's
 * to override — willSeal, keyChanged, a draft with no recipients yet — render no
 * dialog at all, so there is no way to consent to something that was never asked.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

import PostboxComposerSealConfirmDialog from '../PostboxComposerSealConfirmDialog.vue';
import type { SealState } from '~/utils/sealComposer';

const confirmationDialogStub = {
	props: ['open', 'title', 'description', 'confirmText', 'cancelText', 'variant'],
	emits: ['update:open', 'confirm'],
	template: `<div v-if="open" data-testid="dialog">
		<h3 data-testid="dialog-title">{{ title }}</h3>
		<p data-testid="dialog-description">{{ description }}</p>
		<button data-testid="dialog-confirm" @click="$emit('confirm')">{{ confirmText }}</button>
		<button data-testid="dialog-cancel" @click="$emit('update:open', false)">{{ cancelText }}</button>
	</div>`,
};

// The prompt copy flows through vue-i18n now; `useI18n` is a Nuxt auto-import,
// so it has to exist as a global for the component's setup.
beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

function mountDialog(sealState: SealState | null, open = true) {
	return mount(PostboxComposerSealConfirmDialog, {
		props: { open, sealState },
		global: {
			plugins: [createTestI18n()],
			stubs: { UiConfirmationDialog: confirmationDialogStub },
		},
	});
}

describe('PostboxComposerSealConfirmDialog', () => {
	it('states the reason and what unsealed delivery means, and offers both answers', () => {
		const wrapper = mountDialog({ kind: 'cannotSeal', reason: 'recipient_no_key' });
		expect(wrapper.find('[data-testid="dialog-title"]').text()).toBe('Send this message unsealed?');
		expect(wrapper.find('[data-testid="dialog-description"]').text()).toBe(
			"Some of your recipients can't receive sealed mail yet. Owlat will send it as ordinary email, which the mail servers it passes through can read."
		);
		expect(wrapper.find('[data-testid="dialog-confirm"]').text()).toBe('Send unsealed');
		expect(wrapper.find('[data-testid="dialog-cancel"]').text()).toBe('Keep editing');
	});

	it('proceeding emits confirm; cancelling closes without confirming', async () => {
		const wrapper = mountDialog({ kind: 'cannotSeal', reason: 'policy_ask' });
		await wrapper.find('[data-testid="dialog-confirm"]').trigger('click');
		expect(wrapper.emitted('confirm')).toHaveLength(1);

		const cancelled = mountDialog({ kind: 'cannotSeal', reason: 'policy_ask' });
		await cancelled.find('[data-testid="dialog-cancel"]').trigger('click');
		expect(cancelled.emitted('confirm')).toBeUndefined();
		expect(cancelled.emitted('update:open')).toEqual([[false]]);
	});

	it('stays shut for states plaintext is not the sender’s to choose', () => {
		const noPrompt: (SealState | null)[] = [
			null,
			{ kind: 'willSeal' },
			{ kind: 'keyChanged', addresses: ['bob@b.test'] },
			{ kind: 'cannotSeal', reason: 'no_recipients' },
		];
		for (const state of noPrompt) {
			expect(mountDialog(state).find('[data-testid="dialog"]').exists()).toBe(false);
		}
	});

	it('renders nothing until the parent opens it', () => {
		const wrapper = mountDialog({ kind: 'cannotSeal', reason: 'recipient_no_key' }, false);
		expect(wrapper.find('[data-testid="dialog"]').exists()).toBe(false);
	});
});
