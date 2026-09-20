// @vitest-environment happy-dom
/**
 * The admin card that sets how long the shared inbox keeps a received
 * message's files.
 *
 * The horizon is a locked requirement and a closed 30/90/180/365 set, so what
 * is pinned here is the seam between the form and the Convex validator:
 *   - the choices rendered are exactly the shared constant's, so the form can
 *     never offer a value the validator rejects
 *   - the saved value is a NUMBER. A raw `<select>` hands back `'30'`, which
 *     the closed literal union refuses, and every save would fail with a
 *     generic operation toast that no test noticed. Proven against the REAL
 *     `UiSelect`: a stub that emits `option.value` proves only that the stub
 *     was written that way, which is exactly the regression this case exists
 *     to catch
 *   - the stored setting is what shows as selected, and an unset one falls back
 *     to the shared default
 *   - a non-admin gets a disabled control, not a control that fails on submit
 *   - re-picking the value already in force writes nothing
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import {
	DEFAULT_INBOUND_RAW_RETENTION_DAYS,
	INBOUND_RAW_RETENTION_DAY_CHOICES,
} from '@owlat/shared/inboundRetention';
import UiSelect from '@owlat/ui/components/ui/Select.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import InboundRetentionCard from '../InboundRetentionCard.vue';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

type SelectOption = { value: number; label: string };

function mountCard(
	opts: {
		stored?: number;
		canManage?: boolean;
		update?: (args: Record<string, unknown>) => Promise<{ ok: boolean }>;
	} = {}
) {
	const updates: Array<Record<string, unknown>> = [];
	const run = opts.update ?? (async () => ({ ok: true }));
	const toasts: string[] = [];

	vi.stubGlobal('useConvexQuery', () => ({
		data: computed(() =>
			opts.stored === undefined ? {} : { inboundRawRetentionDays: opts.stored }
		),
		isLoading: computed(() => false),
	}));
	vi.stubGlobal('usePermissions', () => ({
		canManageOrganization: computed(() => opts.canManage !== false),
	}));
	vi.stubGlobal('useToast', () => ({ showToast: (m: string) => toasts.push(m) }));
	vi.stubGlobal('useBackendOperation', () => ({
		run: async (args: Record<string, unknown>) => {
			updates.push(args);
			return await run(args);
		},
		isLoading: computed(() => false),
	}));

	const wrapper = mount(InboundRetentionCard, {
		global: {
			plugins: [createTestI18n()],
			// The REAL select, so what this suite proves about the emitted value is
			// a property of the shipped control and not of a stub.
			components: { UiSelect },
			stubs: { Icon: true, UiSpinner: true },
		},
	});
	return { wrapper, updates, toasts };
}

/** Open the dropdown; its options only exist in the DOM while it is open. */
async function open(wrapper: ReturnType<typeof mount>): Promise<void> {
	await wrapper.find('button').trigger('click');
}

function optionButtons(wrapper: ReturnType<typeof mount>) {
	// The trigger is the first button; the menu's options follow it.
	return wrapper.findAll('button').slice(1);
}

function options(wrapper: ReturnType<typeof mount>): SelectOption[] {
	return optionButtons(wrapper).map((b) => ({
		value: Number(b.text().replace(/\D+/g, '')),
		label: b.text(),
	}));
}

/** Click the option whose label carries this day count. */
async function pick(wrapper: ReturnType<typeof mount>, days: number): Promise<void> {
	await open(wrapper);
	const option = optionButtons(wrapper).find((b) => b.text().replace(/\D+/g, '') === String(days));
	if (!option) throw new Error(`no option for ${days} days`);
	await option.trigger('click');
}

describe('InboundRetentionCard', () => {
	it('offers exactly the shared choice set, so the form and the validator agree', async () => {
		const { wrapper } = mountCard();
		await open(wrapper);

		expect(options(wrapper).map((o) => o.value)).toEqual([...INBOUND_RAW_RETENTION_DAY_CHOICES]);
	});

	it('shows the stored horizon as selected', () => {
		const { wrapper } = mountCard({ stored: 180 });

		// The trigger renders the selected option's label — closed, which is how a
		// reader sees it.
		expect(wrapper.find('button').text()).toContain('180');
	});

	it('falls back to the shared default when the instance has never set one', () => {
		const { wrapper } = mountCard();

		expect(wrapper.find('button').text()).toContain(String(DEFAULT_INBOUND_RAW_RETENTION_DAYS));
	});

	it('saves the choice as a NUMBER, which is what the Convex validator accepts', async () => {
		const { wrapper, updates, toasts } = mountCard({ stored: 90 });

		await pick(wrapper, 30);

		expect(updates).toEqual([{ inboundRawRetentionDays: 30 }]);
		expect(typeof updates[0]!['inboundRawRetentionDays']).toBe('number');
		expect(toasts).toHaveLength(1);
	});

	it('writes nothing when the picked value is the one already in force', async () => {
		const { wrapper, updates } = mountCard({ stored: 90 });

		await pick(wrapper, 90);

		expect(updates).toEqual([]);
	});

	it('disables the control for a non-admin instead of letting the save fail', async () => {
		const { wrapper, updates } = mountCard({ stored: 90, canManage: false });

		const trigger = wrapper.find('button');
		expect(trigger.attributes('disabled')).toBeDefined();
		// A disabled trigger does not open, so there is nothing to pick.
		await trigger.trigger('click');
		expect(optionButtons(wrapper)).toHaveLength(0);
		expect(updates).toEqual([]);
	});

	it('stays quiet when the save fails — the operation toast already spoke', async () => {
		const { wrapper, toasts } = mountCard({
			stored: 90,
			update: async () => ({ ok: false }),
		});

		await pick(wrapper, 365);

		expect(toasts).toEqual([]);
	});
});
