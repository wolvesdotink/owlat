/**
 * The delivery hub's sending-status banner says whether a suspension lifts by
 * itself and on what condition, or that a platform admin has to lift it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import AbuseStatusBanner from '../AbuseStatusBanner.vue';
import type { SuspensionLiftView } from '~/utils/suspensionLift';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

const global = {
	plugins: [createTestI18n()],
	stubs: { NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } },
};

beforeEach(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useConvexQuery', () => ({ data: ref(true) }));
});

function render(status: string, lift: SuspensionLiftView | null) {
	return mount(AbuseStatusBanner, {
		props: { status, reason: 'Auto-suspended: something', changedAt: null, lift },
		global,
	}).text();
}

const automatic = {
	mode: 'automatic',
	limit: 0.002,
	current: 0.0024,
	isClear: false,
	clearsAt: null,
} as const;

describe('AbuseStatusBanner — how a suspension lifts', () => {
	it('names the rate, the line and where it stands now', () => {
		const text = render('suspended', { ...automatic, code: 'complaint_rate' });
		expect(text).toContain(
			'Sending resumes by itself once the complaint rate over the last 30 days is under 0.2%. It is 0.24% now.'
		);
		expect(text).toContain('Auto-suspended: something');
	});

	it('gives the day a Gmail reading leaves the window', () => {
		const text = render('suspended', {
			...automatic,
			code: 'gmail_spam_rate',
			domain: 'news.example.com',
			limit: 0.001,
			current: 0.004,
			clearsAt: Date.UTC(2026, 11, 10, 12),
		});
		expect(text).toContain('no Gmail reading for news.example.com');
		expect(text).toContain('0.40%');
		expect(text).toContain('2026');
	});

	it('says it resumes at the next check once the rate has cleared', () => {
		expect(render('suspended', { ...automatic, code: 'bounce_rate', isClear: true })).toContain(
			'sending resumes at the next hourly check'
		);
	});

	it('says a platform admin has to lift it when the instance requires that', () => {
		expect(render('suspended', { mode: 'manual_setting' })).toContain(
			'This instance waits for a platform admin'
		);
	});

	it('says a suspension with no recorded trigger does not lift by itself', () => {
		expect(render('suspended', { mode: 'admin' })).toContain(
			'This suspension does not lift by itself. A platform admin has to lift it.'
		);
	});

	it('adds no lift line to a ban', () => {
		const text = render('banned', { mode: 'admin' });
		expect(text).toContain('permanently disabled');
		expect(text).not.toContain('does not lift by itself');
	});
});
