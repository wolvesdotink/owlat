// @vitest-environment happy-dom
/**
 * PostboxScheduleDialog (plan idea 9) — the rendering half of the timezone-aware
 * presets. The preset MATH is covered by `postboxSchedulePresets.test.ts`; what
 * matters here is that the dialog stays honest about what it knows:
 *
 *   - with ONE known recipient timezone it names the zone, offers the
 *     recipient-anchored row, and prints both clocks on every row;
 *   - with no answer, a zone-less recipient, or recipients spread across zones
 *     it renders exactly the sender-clock dialog it always did — no zone line,
 *     no "their time" row, one clock per row.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref, type Ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

import PostboxScheduleDialog from '../PostboxScheduleDialog.vue';

vi.mock('@owlat/api', () => ({
	api: { mail: { contacts: { recipientTimeZones: 'contacts.recipientTimeZones' } } },
}));

let zones: Ref<Array<{ address: string; timeZone: string }>>;

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

beforeEach(() => {
	zones = ref([]);
	vi.stubGlobal('useConvexQuery', () => ({ data: zones }));
});

/** The modal renders its slot inline; no teleport target needed. */
const modalStub = {
	props: ['open', 'title', 'size'],
	template: '<div v-if="open"><slot /></div>',
};

function mountDialog(props: Record<string, unknown> = {}) {
	return mount(PostboxScheduleDialog, {
		props: { open: true, mailboxId: 'mbx_1', recipients: ['ines@example.test'], ...props },
		global: {
			plugins: [createTestI18n()],
			stubs: { UiModal: modalStub, Icon: { template: '<span />' } },
		},
	});
}

describe('PostboxScheduleDialog — no recipient timezone', () => {
	it('renders the sender-clock presets with a single clock each', async () => {
		const wrapper = mountDialog();
		expect(wrapper.find('[data-testid="postbox-schedule-recipient-zone"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="postbox-schedule-preset-recipientMorning"]').exists()).toBe(
			false
		);
		expect(wrapper.find('[data-testid="postbox-schedule-preset-tomorrowMorning"]').exists()).toBe(
			true
		);
		// One clock: no "yours"/"theirs" qualifier anywhere.
		expect(wrapper.text()).not.toContain('yours');
	});

	it('says nothing when the recipients sit in different zones', async () => {
		zones.value = [
			{ address: 'a@example.test', timeZone: 'Europe/Berlin' },
			{ address: 'b@example.test', timeZone: 'America/New_York' },
		];
		const wrapper = mountDialog({ recipients: ['a@example.test', 'b@example.test'] });
		expect(wrapper.find('[data-testid="postbox-schedule-recipient-zone"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="postbox-schedule-preset-recipientMorning"]').exists()).toBe(
			false
		);
	});

	it('names the day each further-out row lands on, never the raw placeholder', () => {
		// Pinned to a Wednesday: on a Sunday both `next*` presets resolve to
		// tomorrow 9:00 and dedupe against "tomorrow morning", leaving no rows.
		vi.useFakeTimers({ now: new Date('2026-09-02T10:00:00'), toFake: ['Date'] });
		try {
			const wrapper = mountDialog();
			const rows = wrapper.findAll('[data-testid^="postbox-schedule-preset-next"]');
			expect(rows.length).toBeGreaterThan(0);
			for (const row of rows) {
				expect(row.text()).not.toContain('{weekday}');
				// A real weekday name, in the reader's language.
				expect(row.text()).toMatch(/Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday/);
			}
		} finally {
			vi.useRealTimers();
		}
	});

	it('emits the chosen instant and closes', async () => {
		const wrapper = mountDialog();
		await wrapper.get('[data-testid="postbox-schedule-preset-tomorrowMorning"]').trigger('click');
		const at = wrapper.emitted('confirm')?.[0]?.[0] as number;
		expect(at).toBeGreaterThan(Date.now());
		expect(wrapper.emitted('update:open')).toEqual([[false]]);
	});
});

describe('PostboxScheduleDialog — one known recipient timezone', () => {
	beforeEach(() => {
		// A zone far from any plausible test-runner zone, so the two clocks differ.
		zones.value = [{ address: 'ines@example.test', timeZone: 'Pacific/Kiritimati' }];
	});

	it('names the zone the presets are read against', () => {
		const wrapper = mountDialog();
		expect(wrapper.get('[data-testid="postbox-schedule-recipient-zone"]').text()).toContain(
			'Pacific/Kiritimati'
		);
	});

	it('offers the recipient-anchored morning first, labelled with their clock first', () => {
		const wrapper = mountDialog();
		const row = wrapper.get('[data-testid="postbox-schedule-preset-recipientMorning"]');
		expect(row.text()).toContain('their time');
		expect(row.text()).toMatch(/theirs.*yours/s);
	});

	it('prints both clocks on the sender-anchored rows too, yours first', () => {
		const wrapper = mountDialog();
		const row = wrapper.get('[data-testid="postbox-schedule-preset-tomorrowMorning"]');
		expect(row.text()).toMatch(/yours.*theirs/s);
	});

	it('does not ask at all while the dialog is closed', () => {
		const wrapper = mountDialog({ open: false });
		expect(wrapper.find('[data-testid="postbox-schedule-recipient-zone"]').exists()).toBe(false);
	});
});
