// @vitest-environment happy-dom
/**
 * The readiness line that sits beside the send/schedule buttons. The copy rules
 * are audited in `~/lib/__tests__/sendReadiness`; this suite covers the two
 * things only the component decides:
 *   - it renders NOTHING when there is nothing honest to say (an unmeasured cap
 *     must not leave an empty box beside the send button), and
 *   - a capped day is dressed as information, never as the error treatment
 *     (deliverability plan D14).
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';

import SendReadinessNote from '../SendReadinessNote.vue';
import type { SendingReadiness } from '~/lib/sendReadiness';

const iconStub = { props: ['name'], template: '<span />' };

const NOW = Date.UTC(2026, 0, 5, 12, 0);

function mountNote(readiness: SendingReadiness | null, audienceSize: number | null = null) {
	return mount(SendReadinessNote, {
		props: { readiness, audienceSize, now: NOW },
		global: { stubs: { Icon: iconStub } },
	});
}

describe('SendReadinessNote', () => {
	it('renders nothing at all while capacity is unmeasured', () => {
		expect(mountNote(null).find('[data-testid="send-readiness-note"]').exists()).toBe(false);
		expect(
			mountNote({ capped: false, reason: 'no_projection' })
				.find('[data-testid="send-readiness-note"]')
				.exists()
		).toBe(false);
	});

	it("quotes today's headroom where the operator acts", () => {
		const wrapper = mountNote({ capped: true, today: 1500, growsTo: null, growsAt: null });
		expect(wrapper.text()).toContain('You can send to about 1,500 contacts today');
	});

	it('treats a paced audience as information, not an error', () => {
		const wrapper = mountNote({ capped: true, today: 500, growsTo: null, growsAt: null }, 2000);
		const html = wrapper.html();
		expect(wrapper.text()).toContain('paced over the following days');
		// The refusal palette (destructive/error) is never used for a normal
		// warming state — accent is.
		expect(html).not.toContain('error');
		expect(html).toContain('accent');
	});

	it('warns — but does not alarm — on a spent day', () => {
		const wrapper = mountNote({
			capped: true,
			today: 0,
			growsTo: 700,
			growsAt: Date.UTC(2026, 0, 6),
		});
		expect(wrapper.text()).toContain("Today's sending capacity is used up");
		expect(wrapper.text()).toContain('grows to about 700 tomorrow');
		expect(wrapper.html()).toContain('warning');
	});
});
