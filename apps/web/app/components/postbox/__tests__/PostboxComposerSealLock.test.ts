// @vitest-environment happy-dom
/**
 * PostboxComposerSealLock — the composer's honest seal-lock (Sealed Mail E5).
 *
 * Covers the three seal states with VERBATIM copy (the honesty audit), that a
 * cannotSeal draft exposes an EXPLICIT "Send unsealed" control which emits
 * send-unsealed (never a silent plaintext send), that keyChanged offers NO
 * unsealed escape hatch (its copy points at the thread's key-change banner), and
 * that the flag gate renders nothing.
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';

import PostboxComposerSealLock from '../PostboxComposerSealLock.vue';
import type { SealState } from '~/utils/sealComposer';

const iconStub = { props: ['name'], template: '<span />' };

function mountLock(sealState: SealState | null, enabled = true) {
	return mount(PostboxComposerSealLock, {
		props: { enabled, sealState },
		global: { stubs: { Icon: iconStub } },
	});
}

describe('PostboxComposerSealLock', () => {
	it('willSeal: verbatim summary + detail, no send-unsealed control', () => {
		const wrapper = mountLock({ kind: 'willSeal' });
		expect(wrapper.find('[data-testid="seal-lock-summary"]').text()).toBe(
			'This message will be sealed'
		);
		expect(wrapper.find('[data-testid="seal-lock-detail"]').text()).toBe(
			'Everyone you are writing to can receive sealed mail, so Owlat will encrypt this message before it leaves your workspace.'
		);
		expect(wrapper.find('[data-testid="seal-lock-send-unsealed"]').exists()).toBe(false);
	});

	it('keyChanged: verbatim copy pointing at the thread, and NO send-unsealed escape hatch', () => {
		const wrapper = mountLock({ kind: 'keyChanged', addresses: ['bob@b.test'] });
		expect(wrapper.find('[data-testid="seal-lock-summary"]').text()).toBe(
			"A recipient's key changed"
		);
		expect(wrapper.find('[data-testid="seal-lock-detail"]').text()).toBe(
			'The sealing key for bob@b.test changed since you last sealed mail to them. Open your conversation with them to review and confirm the new key before Owlat will seal to it.'
		);
		// keyChanged is resolved on the thread's key-change banner, not the composer:
		// the lock offers no in-composer action and no plaintext escape hatch.
		expect(wrapper.find('[data-testid="seal-lock-review-keys"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="seal-lock-send-unsealed"]').exists()).toBe(false);
	});

	it('cannotSeal: verbatim summary and an EXPLICIT send-unsealed act', async () => {
		const wrapper = mountLock({ kind: 'cannotSeal', reason: 'recipient_no_key' });
		expect(wrapper.find('[data-testid="seal-lock-summary"]').text()).toBe(
			"This message won't be sealed"
		);
		expect(wrapper.find('[data-testid="seal-lock-detail"]').text()).toBe(
			"Some of your recipients can't receive sealed mail yet, so this message will be sent normally."
		);
		const btn = wrapper.find('[data-testid="seal-lock-send-unsealed"]');
		expect(btn.exists()).toBe(true);
		await btn.trigger('click');
		expect(wrapper.emitted('send-unsealed')).toHaveLength(1);
	});

	it('flag off renders nothing', () => {
		const wrapper = mountLock({ kind: 'willSeal' }, false);
		expect(wrapper.find('[data-testid="seal-lock"]').exists()).toBe(false);
	});

	it('no seal state renders nothing', () => {
		const wrapper = mountLock(null);
		expect(wrapper.find('[data-testid="seal-lock"]').exists()).toBe(false);
	});
});
