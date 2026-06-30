import { describe, it, expect } from 'vitest';
import {
	shouldShowSelfHostOnboarding,
	shouldShowOnboardingChecklist,
} from '../onboarding';

describe('shouldShowSelfHostOnboarding — gates on the send path, not domains', () => {
	it('shows when self-host, not dismissed, and cannot send', () => {
		expect(
			shouldShowSelfHostOnboarding({ isSelfHost: true, dismissed: false, canSend: false }),
		).toBe(true);
	});

	it('hides once the instance can send (delivery provider configured)', () => {
		// The core fix: readiness is the send path, NOT a verified domain. A user
		// could have a verified domain and still be unable to send.
		expect(
			shouldShowSelfHostOnboarding({ isSelfHost: true, dismissed: false, canSend: true }),
		).toBe(false);
	});

	it('hides when dismissed even though it still cannot send', () => {
		expect(
			shouldShowSelfHostOnboarding({ isSelfHost: true, dismissed: true, canSend: false }),
		).toBe(false);
	});

	it('never shows outside self-host deployments', () => {
		expect(
			shouldShowSelfHostOnboarding({ isSelfHost: false, dismissed: false, canSend: false }),
		).toBe(false);
	});
});

describe('shouldShowOnboardingChecklist — defers to the self-host banner', () => {
	const base = {
		isLoading: false,
		dismissed: false,
		isComplete: false,
		isSelfHost: false,
		sendPathReady: false,
	};

	it('shows in non-self-host mode when not loading/dismissed/complete', () => {
		expect(shouldShowOnboardingChecklist(base)).toBe(true);
	});

	it('hides while the self-host banner owns the pre-send phase', () => {
		expect(
			shouldShowOnboardingChecklist({ ...base, isSelfHost: true, sendPathReady: false }),
		).toBe(false);
	});

	it('takes over in self-host once the instance can send', () => {
		expect(
			shouldShowOnboardingChecklist({ ...base, isSelfHost: true, sendPathReady: true }),
		).toBe(true);
	});

	it('hides while loading, when dismissed, and when complete', () => {
		expect(shouldShowOnboardingChecklist({ ...base, isLoading: true })).toBe(false);
		expect(shouldShowOnboardingChecklist({ ...base, dismissed: true })).toBe(false);
		expect(shouldShowOnboardingChecklist({ ...base, isComplete: true })).toBe(false);
	});
});

describe('onboarding surfaces never stack — only one renders at a time', () => {
	// `canSend` (banner) and `sendPathReady` (checklist) are the SAME instance
	// signal, so for every reachable state at most one surface is visible.
	for (const isSelfHost of [false, true]) {
		for (const dismissed of [false, true]) {
			for (const sendPathReady of [false, true]) {
				for (const isComplete of [false, true]) {
					it(`selfHost=${isSelfHost} dismissed=${dismissed} send=${sendPathReady} complete=${isComplete}`, () => {
						const banner = shouldShowSelfHostOnboarding({
							isSelfHost,
							dismissed,
							canSend: sendPathReady,
						});
						const checklist = shouldShowOnboardingChecklist({
							isLoading: false,
							dismissed,
							isComplete,
							isSelfHost,
							sendPathReady,
						});
						// Mutually exclusive: never both visible.
						expect(banner && checklist).toBe(false);
						// Dismissal hides the consolidated surface entirely.
						if (dismissed) {
							expect(banner).toBe(false);
							expect(checklist).toBe(false);
						}
					});
				}
			}
		}
	}
});
