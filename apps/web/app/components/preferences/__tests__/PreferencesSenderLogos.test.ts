/**
 * Preferences → Reading → Show sender logos: on until the person turns it off,
 * a write per toggle, and the reset marker only once a saved "off" is known.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed, ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import PreferencesSenderLogos from '../PreferencesSenderLogos.vue';

const data = ref<{ isSenderLogosOn?: boolean } | null | undefined>(undefined);
const isLoading = ref(true);
const run = vi.fn(async () => undefined);

beforeEach(() => {
	vi.clearAllMocks();
	data.value = undefined;
	isLoading.value = true;
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('computed', computed);
	vi.stubGlobal('useConvexQuery', () => ({ data, isLoading }));
	vi.stubGlobal('useBackendOperation', () => ({ run, isLoading: ref(false) }));
});

function mountRow() {
	return mount(PreferencesSenderLogos, {
		global: {
			plugins: [createTestI18n()],
			stubs: {
				UiSwitch: {
					props: ['modelValue', 'id'],
					emits: ['update:modelValue'],
					template:
						'<button :id="id" :data-on="String(modelValue)" @click="$emit(\'update:modelValue\', !modelValue)" />',
				},
			},
		},
	});
}

const resetMarker = (row: ReturnType<typeof mountRow>) =>
	row.find('[data-testid="setting-reset"] button');

describe('PreferencesSenderLogos', () => {
	it('reads as on, unmarked, for a person who never saved the setting', () => {
		isLoading.value = false;
		data.value = null;
		const row = mountRow();
		expect(row.find('#postbox-sender-logos').attributes('data-on')).toBe('true');
		expect(resetMarker(row).exists()).toBe(false);
	});

	it('writes the new value when toggled', async () => {
		isLoading.value = false;
		data.value = {};
		await mountRow().find('#postbox-sender-logos').trigger('click');
		expect(run).toHaveBeenCalledWith({ isSenderLogosOn: false });
	});

	it('marks a saved "off" and resets it to on', async () => {
		isLoading.value = false;
		data.value = { isSenderLogosOn: false };
		const row = mountRow();
		expect(row.find('#postbox-sender-logos').attributes('data-on')).toBe('false');
		await resetMarker(row).trigger('click');
		expect(run).toHaveBeenCalledWith({ isSenderLogosOn: true });
	});
});
