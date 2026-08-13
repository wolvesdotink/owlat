// @vitest-environment happy-dom
/**
 * PostboxComposerSealLock — the composer's honest seal-lock (Sealed Mail E5).
 *
 * Covers the seal states with VERBATIM copy (the honesty audit), that a
 * cannotSeal draft exposes an explicit "Send unsealed…" control which only
 * REQUESTS the decision (the parent's proceed-or-cancel dialog takes it, so the
 * lock can never send plaintext by itself), that keyChanged offers NO unsealed
 * escape hatch (its copy points at the thread's key-change banner), that a
 * pending state says so instead of staying blank, and that the flag gate renders
 * nothing.
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';

import PostboxComposerSealLock from '../PostboxComposerSealLock.vue';
import type { SealState } from '~/utils/sealComposer';

const iconStub = { props: ['name'], template: '<span />' };

function mountLock(sealState: SealState | null, enabled = true, pending = false) {
	return mount(PostboxComposerSealLock, {
		props: { enabled, sealState, pending },
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

	it('cannotSeal: verbatim summary and an EXPLICIT request for the unsealed decision', async () => {
		const wrapper = mountLock({ kind: 'cannotSeal', reason: 'recipient_no_key' });
		expect(wrapper.find('[data-testid="seal-lock-summary"]').text()).toBe(
			"This message won't be sealed"
		);
		expect(wrapper.find('[data-testid="seal-lock-detail"]').text()).toBe(
			"Some of your recipients can't receive sealed mail yet, so this message will be sent normally."
		);
		const btn = wrapper.find('[data-testid="seal-lock-send-unsealed"]');
		expect(btn.exists()).toBe(true);
		// The ellipsis is the promise that a decision follows, not an immediate send.
		expect(btn.text()).toBe('Send unsealed…');
		await btn.trigger('click');
		expect(wrapper.emitted('request-unsealed')).toHaveLength(1);
	});

	it('cannotSeal(no_recipients): explains, but offers no decision there is nothing to decide', () => {
		const wrapper = mountLock({ kind: 'cannotSeal', reason: 'no_recipients' });
		expect(wrapper.find('[data-testid="seal-lock-detail"]').text()).toBe(
			'Add a recipient to see whether this message can be sealed.'
		);
		expect(wrapper.find('[data-testid="seal-lock-send-unsealed"]').exists()).toBe(false);
	});

	it('pending: says the seal state is still being checked, with no decision offered', () => {
		const wrapper = mountLock(null, true, true);
		expect(wrapper.find('[data-testid="seal-lock-summary"]').text()).toBe(
			'Checking whether this message can be sealed'
		);
		expect(wrapper.find('[data-testid="seal-lock-send-unsealed"]').exists()).toBe(false);
	});

	it('flag off renders nothing, even while pending', () => {
		expect(mountLock({ kind: 'willSeal' }, false).find('[data-testid="seal-lock"]').exists()).toBe(
			false
		);
		expect(mountLock(null, false, true).find('[data-testid="seal-lock"]').exists()).toBe(false);
	});

	it('no seal state and nothing in flight renders nothing', () => {
		const wrapper = mountLock(null);
		expect(wrapper.find('[data-testid="seal-lock"]').exists()).toBe(false);
	});
});
