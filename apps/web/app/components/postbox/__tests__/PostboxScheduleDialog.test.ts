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
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
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

/**
 * The custom-time field (#1053). A past or unreadable time used to leave
 * Schedule enabled and make its click return without a word; the line under the
 * input now says what Schedule will do, or why it will not, and the emitted
 * instant is the one that line names.
 */
describe('PostboxScheduleDialog — custom time', () => {
	/** `YYYY-MM-DDTHH:mm` in the runner's own zone, the way the native input writes it. */
	function localValue(at: number): string {
		return new Date(at - new Date(at).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
	}
	/** The clock the summary must print for `at`, read in the runner's zone. */
	function localClock(at: number): string {
		return new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' }).format(
			new Date(at)
		);
	}
	const senderZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const NOW = new Date('2026-10-01T10:00:30').getTime();

	beforeEach(() => {
		vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setInterval', 'clearInterval'] });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const input = (w: ReturnType<typeof mountDialog>) =>
		w.get('[data-testid="postbox-schedule-custom-input"]');
	const summary = (w: ReturnType<typeof mountDialog>) =>
		w.get('[data-testid="postbox-schedule-custom-summary"]');
	const submit = (w: ReturnType<typeof mountDialog>) =>
		w.get('[data-testid="postbox-schedule-custom-submit"]');

	it('labels the field, floors the picker at this minute and names the sender zone', () => {
		const wrapper = mountDialog();
		const id = input(wrapper).attributes('id');
		expect(id).toBeTruthy();
		expect(wrapper.get(`label[for="${id}"]`).text()).toBe('Custom');
		expect(input(wrapper).attributes('min')).toBe(localValue(NOW));
		expect(input(wrapper).attributes('aria-describedby')).toBe(summary(wrapper).attributes('id'));
		expect(summary(wrapper).text()).toContain(senderZone);
		expect(submit(wrapper).attributes('disabled')).toBeDefined();
	});

	it('explains a past time, marks the field invalid and keeps Schedule disabled', async () => {
		const wrapper = mountDialog();
		await input(wrapper).setValue(localValue(NOW - 60 * 60_000));
		expect(summary(wrapper).text()).toBe('Pick a time in the future');
		expect(input(wrapper).attributes('aria-invalid')).toBe('true');
		expect(submit(wrapper).attributes('disabled')).toBeDefined();
		await submit(wrapper).trigger('click');
		expect(wrapper.emitted('confirm')).toBeUndefined();
	});

	it('confirms a future time in words and emits exactly that instant', async () => {
		const wrapper = mountDialog();
		const value = localValue(NOW + 26 * 60 * 60_000);
		const at = new Date(value).getTime();
		await input(wrapper).setValue(value);
		const line = summary(wrapper).text();
		expect(line).toMatch(/^Sends /);
		expect(line).toContain(localClock(at));
		expect(line).toContain(`(${senderZone})`);
		expect(line).not.toContain('theirs');
		expect(input(wrapper).attributes('aria-invalid')).toBeUndefined();
		await submit(wrapper).trigger('click');
		expect(wrapper.emitted('confirm')).toEqual([[at]]);
		expect(wrapper.emitted('update:open')).toEqual([[false]]);
	});

	it('shows the error on click when the chosen minute ran out while the dialog was open', async () => {
		const wrapper = mountDialog();
		// 10:01, half a minute ahead when picked.
		await input(wrapper).setValue(localValue(NOW + 30_000));
		expect(summary(wrapper).text()).toMatch(/^Sends /);
		// The clock moves past 10:01 before the ticker has run.
		vi.setSystemTime(NOW + 45_000);
		await submit(wrapper).trigger('click');
		expect(wrapper.emitted('confirm')).toBeUndefined();
		expect(summary(wrapper).text()).toBe('Pick a time in the future');
		expect(submit(wrapper).attributes('disabled')).toBeDefined();
	});

	it('turns into the error on its own once the chosen minute has passed', async () => {
		const wrapper = mountDialog();
		await input(wrapper).setValue(localValue(NOW + 30_000));
		await vi.advanceTimersByTimeAsync(45_000);
		expect(summary(wrapper).text()).toBe('Pick a time in the future');
		expect(submit(wrapper).attributes('disabled')).toBeDefined();
	});

	it("adds the recipient's clock when their zone is known and differs", async () => {
		zones.value = [{ address: 'ines@example.test', timeZone: 'Pacific/Kiritimati' }];
		const wrapper = mountDialog();
		const value = localValue(NOW + 26 * 60 * 60_000);
		const at = new Date(value).getTime();
		await input(wrapper).setValue(value);
		const theirs = new Intl.DateTimeFormat('en', {
			timeZone: 'Pacific/Kiritimati',
			hour: 'numeric',
			minute: '2-digit',
		}).format(new Date(at));
		const line = summary(wrapper).text();
		expect(line).toContain(`your time (${senderZone})`);
		expect(line).toMatch(new RegExp(`${theirs.replace(/\s/g, '\\s')} theirs$`));
		await submit(wrapper).trigger('click');
		expect(wrapper.emitted('confirm')).toEqual([[at]]);
	});

	describe('across a DST change', () => {
		const originalTz = process.env.TZ;
		beforeEach(() => {
			// London and Lagos are both UTC+1 on 1 October; London is back on UTC by November.
			process.env.TZ = 'Europe/London';
			vi.setSystemTime(Date.UTC(2026, 9, 1, 9, 0, 30));
		});
		afterEach(() => {
			if (originalTz === undefined) delete process.env.TZ;
			else process.env.TZ = originalTz;
		});

		it("adds the recipient's clock when the offsets only differ at the chosen instant", async () => {
			zones.value = [{ address: 'ines@example.test', timeZone: 'Africa/Lagos' }];
			const wrapper = mountDialog();
			await input(wrapper).setValue('2026-11-02T09:00');
			const line = summary(wrapper).text();
			expect(line).toContain('your time (Europe/London)');
			expect(line).toMatch(/10:00\sAM theirs$/);
			await submit(wrapper).trigger('click');
			expect(wrapper.emitted('confirm')).toEqual([[Date.UTC(2026, 10, 2, 9, 0)]]);
		});
	});

	it("keeps one clock when the recipient's zone is the sender's own", async () => {
		zones.value = [{ address: 'ines@example.test', timeZone: senderZone }];
		const wrapper = mountDialog();
		await input(wrapper).setValue(localValue(NOW + 26 * 60 * 60_000));
		expect(summary(wrapper).text()).not.toContain('theirs');
	});
});
