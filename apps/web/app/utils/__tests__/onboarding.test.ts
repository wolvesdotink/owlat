import { describe, it, expect } from 'vitest';
import {
	isInstanceOnboardingActive,
	shouldShowSelfHostOnboarding,
	shouldShowOnboardingChecklist,
	shouldShowUserChecklist,
} from '../onboarding';

describe('shouldShowSelfHostOnboarding — gates on the send path, not domains', () => {
	it('shows when self-host, not dismissed, and cannot send', () => {
		expect(
			shouldShowSelfHostOnboarding({ isSelfHost: true, dismissed: false, canSend: false })
		).toBe(true);
	});

	it('hides once the instance can send (delivery provider configured)', () => {
		// The core fix: readiness is the send path, NOT a verified domain. A user
		// could have a verified domain and still be unable to send.
		expect(
			shouldShowSelfHostOnboarding({ isSelfHost: true, dismissed: false, canSend: true })
		).toBe(false);
	});

	it('hides when dismissed even though it still cannot send', () => {
		expect(
			shouldShowSelfHostOnboarding({ isSelfHost: true, dismissed: true, canSend: false })
		).toBe(false);
	});

	it('never shows outside self-host deployments', () => {
		expect(
			shouldShowSelfHostOnboarding({ isSelfHost: false, dismissed: false, canSend: false })
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
		expect(shouldShowOnboardingChecklist({ ...base, isSelfHost: true, sendPathReady: false })).toBe(
			false
		);
	});

	it('takes over in self-host once the instance can send', () => {
		expect(shouldShowOnboardingChecklist({ ...base, isSelfHost: true, sendPathReady: true })).toBe(
			true
		);
	});

	it('hides while loading, when dismissed, and when complete', () => {
		expect(shouldShowOnboardingChecklist({ ...base, isLoading: true })).toBe(false);
		expect(shouldShowOnboardingChecklist({ ...base, dismissed: true })).toBe(false);
		expect(shouldShowOnboardingChecklist({ ...base, isComplete: true })).toBe(false);
	});
});

describe('isInstanceOnboardingActive — one signal for the per-user checklist to defer to', () => {
	const base = {
		isLoading: false,
		dismissed: false,
		isComplete: false,
		isSelfHost: false,
		sendPathReady: false,
	};

	it('is true while the non-self-host instance checklist is unfinished', () => {
		expect(isInstanceOnboardingActive(base)).toBe(true);
	});

	it('is true while the self-host banner owns the pre-send phase', () => {
		expect(isInstanceOnboardingActive({ ...base, isSelfHost: true, sendPathReady: false })).toBe(
			true
		);
	});

	it('is true while the self-host instance checklist runs after the banner hands off', () => {
		expect(isInstanceOnboardingActive({ ...base, isSelfHost: true, sendPathReady: true })).toBe(
			true
		);
	});

	it('is false once the instance onboarding is dismissed', () => {
		expect(isInstanceOnboardingActive({ ...base, dismissed: true })).toBe(false);
	});

	it('is false once the instance onboarding is complete', () => {
		expect(isInstanceOnboardingActive({ ...base, isComplete: true })).toBe(false);
	});

	it('is false while the instance record is still loading (nothing owns the phase yet)', () => {
		expect(isInstanceOnboardingActive({ ...base, isLoading: true })).toBe(false);
	});
});

describe('shouldShowUserChecklist — defers to the instance surfaces', () => {
	const base = {
		isLoading: false,
		dismissed: false,
		isComplete: false,
		instanceOnboardingActive: false,
	};

	it('shows once no instance surface owns the phase and it is unfinished', () => {
		expect(shouldShowUserChecklist(base)).toBe(true);
	});

	it('hides while an instance surface still owns the onboarding phase', () => {
		expect(shouldShowUserChecklist({ ...base, instanceOnboardingActive: true })).toBe(false);
	});

	it('hides while loading, when dismissed, and when complete', () => {
		expect(shouldShowUserChecklist({ ...base, isLoading: true })).toBe(false);
		expect(shouldShowUserChecklist({ ...base, dismissed: true })).toBe(false);
		expect(shouldShowUserChecklist({ ...base, isComplete: true })).toBe(false);
	});
});

describe('all three onboarding surfaces never stack — only one renders at a time', () => {
	// `canSend` (banner) and `sendPathReady` (checklist) are the SAME instance
	// signal, and the per-user checklist defers whenever either instance surface
	// is visible, so for every reachable state at most one surface renders.
	for (const isSelfHost of [false, true]) {
		for (const dismissed of [false, true]) {
			for (const sendPathReady of [false, true]) {
				for (const isComplete of [false, true]) {
					for (const userDismissed of [false, true]) {
						for (const userComplete of [false, true]) {
							it(`selfHost=${isSelfHost} dismissed=${dismissed} send=${sendPathReady} complete=${isComplete} userDismissed=${userDismissed} userComplete=${userComplete}`, () => {
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
								const instanceActive = isInstanceOnboardingActive({
									isLoading: false,
									dismissed,
									isComplete,
									isSelfHost,
									sendPathReady,
								});
								const userChecklist = shouldShowUserChecklist({
									isLoading: false,
									dismissed: userDismissed,
									isComplete: userComplete,
									instanceOnboardingActive: instanceActive,
								});

								// At most ONE of the three surfaces is ever visible.
								const visible = [banner, checklist, userChecklist].filter(Boolean).length;
								expect(visible).toBeLessThanOrEqual(1);

								// The instance surfaces stay mutually exclusive with each other.
								expect(banner && checklist).toBe(false);

								// Dismissing the instance onboarding hides both instance surfaces
								// and lets the per-user checklist take over (dismissal transition).
								if (dismissed) {
									expect(banner).toBe(false);
									expect(checklist).toBe(false);
								}

								// The per-user checklist NEVER stacks on an instance surface.
								if (banner || checklist) {
									expect(userChecklist).toBe(false);
								}
							});
						}
					}
				}
			}
		}
	}
});
