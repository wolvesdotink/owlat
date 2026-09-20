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
 *     generic operation toast that no test noticed
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
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import InboundRetentionCard from '../InboundRetentionCard.vue';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

type SelectStubProps = {
	options: Array<{ value: number; label: string }>;
	modelValue: number | null;
	disabled: boolean;
};

/** Stands in for `UiSelect`, keeping its generic value contract. */
const UiSelectStub = {
	props: ['options', 'modelValue', 'disabled', 'label', 'size'],
	emits: ['update:modelValue'],
	template: `<div data-testid="select" :data-disabled="String(disabled)">
		<button
			v-for="opt in options"
			:key="opt.value"
			type="button"
			:data-value="opt.value"
			:data-selected="String(opt.value === modelValue)"
			@click="$emit('update:modelValue', opt.value)"
		>{{ opt.label }}</button>
	</div>`,
};

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
			stubs: { UiSelect: UiSelectStub, UiSpinner: true },
		},
	});
	return { wrapper, updates, toasts };
}

function options(wrapper: ReturnType<typeof mount>): SelectStubProps['options'] {
	return wrapper.findAll('[data-value]').map((b) => ({
		value: Number(b.attributes('data-value')),
		label: b.text(),
	}));
}

describe('InboundRetentionCard', () => {
	it('offers exactly the shared choice set, so the form and the validator agree', () => {
		const { wrapper } = mountCard();

		expect(options(wrapper).map((o) => o.value)).toEqual([...INBOUND_RAW_RETENTION_DAY_CHOICES]);
	});

	it('shows the stored horizon as selected', () => {
		const { wrapper } = mountCard({ stored: 180 });

		const selected = wrapper.findAll('[data-selected="true"]');
		expect(selected).toHaveLength(1);
		expect(selected[0]!.attributes('data-value')).toBe('180');
	});

	it('falls back to the shared default when the instance has never set one', () => {
		const { wrapper } = mountCard();

		expect(wrapper.find('[data-selected="true"]').attributes('data-value')).toBe(
			String(DEFAULT_INBOUND_RAW_RETENTION_DAYS)
		);
	});

	it('saves the choice as a NUMBER, which is what the Convex validator accepts', async () => {
		const { wrapper, updates, toasts } = mountCard({ stored: 90 });

		await wrapper.find('[data-value="30"]').trigger('click');

		expect(updates).toEqual([{ inboundRawRetentionDays: 30 }]);
		expect(typeof updates[0]!['inboundRawRetentionDays']).toBe('number');
		expect(toasts).toHaveLength(1);
	});

	it('writes nothing when the picked value is the one already in force', async () => {
		const { wrapper, updates } = mountCard({ stored: 90 });

		await wrapper.find('[data-value="90"]').trigger('click');

		expect(updates).toEqual([]);
	});

	it('disables the control for a non-admin instead of letting the save fail', async () => {
		const { wrapper, updates } = mountCard({ stored: 90, canManage: false });

		expect(wrapper.find('[data-testid="select"]').attributes('data-disabled')).toBe('true');
		await wrapper.find('[data-value="30"]').trigger('click');
		expect(updates).toEqual([]);
	});

	it('stays quiet when the save fails — the operation toast already spoke', async () => {
		const { wrapper, toasts } = mountCard({
			stored: 90,
			update: async () => ({ ok: false }),
		});

		await wrapper.find('[data-value="365"]').trigger('click');

		expect(toasts).toEqual([]);
	});
});
