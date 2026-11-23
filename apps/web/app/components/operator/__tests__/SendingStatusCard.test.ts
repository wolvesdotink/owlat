/**
 * The operator console's sending card: how a suspension lifts, what a lift
 * paused, and the switch that makes every suspension wait for a platform admin.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import SendingStatusCard from '../SendingStatusCard.vue';
import type { SendingStatusView } from '~/utils/suspensionLift';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

const run = vi.fn();

const global = {
	plugins: [createTestI18n()],
	stubs: {
		UiBadge: { template: '<span><slot /></span>' },
		UiButton: { template: '<button type="button"><slot /></button>' },
		UiSwitch: {
			props: ['modelValue', 'label'],
			emits: ['update:modelValue'],
			template:
				'<button role="switch" :aria-checked="String(modelValue)" @click="$emit(\'update:modelValue\', !modelValue)">{{ label }}</button>',
		},
	},
};

beforeEach(() => {
	run.mockReset();
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useBackendOperation', () => ({ run, isLoading: ref(false) }));
});

function mountCard(status: string, sending: SendingStatusView) {
	return mount(SendingStatusCard, {
		props: {
			currentAbuseStatus: status,
			abuseStatusReason: 'Auto-suspended: something',
			isWarned: false,
			busy: false,
			sending,
		},
		global,
	});
}

describe('SendingStatusCard', () => {
	it('says a check-imposed suspension lifts by itself, and on what', () => {
		const text = mountCard('suspended', {
			suspensionLift: {
				mode: 'automatic',
				code: 'bounce_rate',
				limit: 0.05,
				current: 0.072,
				isClear: false,
				clearsAt: null,
			},
		}).text();
		expect(text).toContain(
			'Sending resumes by itself once the bounce rate over the last 30 days is under 5%. It is 7.20% now.'
		);
	});

	it('says what a lift paused, and until when', () => {
		const text = mountCard('clean', {
			reputationCheckHold: {
				until: Date.UTC(2026, 10, 27, 12),
				triggers: [{ code: 'bounce_rate' }],
			},
		}).text();
		expect(text).toContain('The automatic check is paused for the bounce rate until');
		expect(text).toContain('sending is suspended again');
	});

	it('turns the manual check on through the instance settings', async () => {
		const card = mountCard('suspended', { isSendingResumeManual: false });
		const toggle = card.get('[role="switch"]');
		expect(toggle.attributes('aria-checked')).toBe('false');
		await toggle.trigger('click');
		expect(run).toHaveBeenCalledWith({ isSendingResumeManual: true });
	});
});
