// @vitest-environment happy-dom
/**
 * The sunset policy's day fields carry their minimums on the number inputs
 * themselves: the re-engagement window starts at `SUNSET_MIN_WINDOW_DAYS`, the
 * same shared constant `setSunsetPolicy` enforces, and the suppression window
 * cannot be shorter than the re-engagement window. Mounted with the real
 * `UiInput`, because the bug was that the shared input put `min` on its
 * container div, where the browser ignores it, so the spinner walked straight
 * past both limits.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref, useSlots, type Component } from 'vue';
import { SUNSET_MIN_WINDOW_DAYS } from '@owlat/shared/sunsetPolicy';
import type * as SunsetPolicy from '@owlat/shared/sunsetPolicy';
import UiInput from '@owlat/ui/components/ui/Input.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { queryResult } from '~/__tests__/queryStubs';
import SuppressionSunsetControls from '../SuppressionSunsetControls.vue';

const policies = {
	global: { isEnabled: true, reengageAfterDays: 120, suppressAfterDays: 200 },
};

beforeEach(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useSlots', useSlots);
	vi.stubGlobal('usePermissions', () => ({ isAdmin: ref(true) }));
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	vi.stubGlobal('useBackendOperation', () => ({ run: vi.fn(), isLoading: ref(false) }));
	vi.stubGlobal('useConvexQuery', (_query: unknown, args: unknown) => {
		const request = typeof args === 'function' ? (args as () => unknown)() : args;
		if (request && typeof request === 'object' && 'stage' in request) {
			return queryResult({ page: [], isDone: true, continueCursor: '' });
		}
		return queryResult(policies);
	});
});

function mountControls(component: Component = SuppressionSunsetControls) {
	return mount(component, {
		global: {
			plugins: [createTestI18n()],
			components: { UiInput },
			stubs: {
				UiSwitch: true,
				UiButton: { template: '<button type="button"><slot /></button>' },
			},
		},
	});
}

describe('SuppressionSunsetControls day minimums', () => {
	it('puts the minimums on the native number inputs', () => {
		const [reengage, suppress] = mountControls().findAll('input[type="number"]');

		expect(reengage!.attributes('min')).toBe(String(SUNSET_MIN_WINDOW_DAYS));
		expect(suppress!.attributes('min')).toBe('120');
	});

	it('takes the re-engagement minimum from the shared constant, not a literal', async () => {
		// A floor the backend could plausibly move to. A hard-coded `min` in the
		// form keeps offering the old value and this assertion catches it.
		vi.resetModules();
		vi.doMock('@owlat/shared/sunsetPolicy', async (importOriginal) => ({
			...(await importOriginal<typeof SunsetPolicy>()),
			SUNSET_MIN_WINDOW_DAYS: 45,
		}));
		try {
			const { default: controls } = await import('../SuppressionSunsetControls.vue');
			const [reengage] = mountControls(controls).findAll('input[type="number"]');

			expect(reengage!.attributes('min')).toBe('45');
		} finally {
			vi.doUnmock('@owlat/shared/sunsetPolicy');
			vi.resetModules();
		}
	});

	it('raises the suppression minimum as the re-engagement window grows', async () => {
		const wrapper = mountControls();
		const [reengage] = wrapper.findAll('input[type="number"]');

		await reengage!.setValue('150');

		const [, suppress] = wrapper.findAll('input[type="number"]');
		expect(suppress!.attributes('min')).toBe('150');
	});
});
