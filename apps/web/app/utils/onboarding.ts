/**
 * Pure gating logic for the dashboard's onboarding surfaces.
 *
 * The dashboard renders exactly ONE onboarding affordance at a time. There are
 * three candidate surfaces, ordered by phase:
 *
 * - The self-host BANNER owns the pre-send phase. It auto-hides once the
 *   instance has a verified SEND PATH — a configured delivery provider with its
 *   credentials present (`canSend`) — NOT merely a verified sending domain
 *   (a domain can be verified while the instance still cannot send a single
 *   email). `canSend` is the checklist's `sendPathReady` signal.
 * - The instance CHECKLIST takes over afterwards (and is the only instance
 *   surface in non-self-host mode). While the banner owns the pre-send phase
 *   (`isSelfHost && !sendPathReady`) it suppresses itself.
 * - The per-user CHECKLIST (each member's personal mailbox/first-send journey)
 *   comes LAST. It defers while EITHER instance surface still owns the
 *   onboarding phase (see {@link isInstanceOnboardingActive}), so a fresh admin
 *   never sees two stacked checklists. The three surfaces are provably mutually
 *   exclusive because the two instance gates share one server signal and the
 *   per-user gate is suppressed whenever either of them is visible.
 *
 * Kept as pure functions so the consolidation is unit-testable independent of
 * the Vue components / Convex client.
 */
export function shouldShowSelfHostOnboarding(opts: {
	isSelfHost: boolean;
	dismissed: boolean;
	canSend: boolean;
}): boolean {
	if (!opts.isSelfHost) return false;
	if (opts.dismissed) return false;
	if (opts.canSend) return false;
	return true;
}

/**
 * Whether the consolidated onboarding checklist should render. Returns false
 * while the self-host banner owns the pre-send phase, so the two surfaces never
 * stack (see {@link shouldShowSelfHostOnboarding}). `sendPathReady` here is the
 * banner's `canSend` — the same server signal — which is what makes the two
 * gates provably mutually exclusive.
 */
export function shouldShowOnboardingChecklist(opts: {
	isLoading: boolean;
	dismissed: boolean;
	isComplete: boolean;
	isSelfHost: boolean;
	sendPathReady: boolean;
}): boolean {
	if (opts.isLoading) return false;
	if (opts.dismissed) return false;
	if (opts.isComplete) return false;
	// Self-host: defer to the banner until the instance can actually send.
	if (opts.isSelfHost && !opts.sendPathReady) return false;
	return true;
}

/**
 * Whether an INSTANCE-scoped onboarding surface currently owns the dashboard's
 * onboarding phase — i.e. either the self-host banner or the instance go-live
 * checklist is visible. Derived from the SAME instance state both gates read, so
 * it is the single source of truth the per-user checklist defers to. Returns
 * false while the instance record is still loading (nothing owns the phase yet).
 */
export function isInstanceOnboardingActive(opts: {
	isLoading: boolean;
	dismissed: boolean;
	isComplete: boolean;
	isSelfHost: boolean;
	sendPathReady: boolean;
}): boolean {
	if (opts.isLoading) return false;
	return (
		shouldShowSelfHostOnboarding({
			isSelfHost: opts.isSelfHost,
			dismissed: opts.dismissed,
			canSend: opts.sendPathReady,
		}) ||
		shouldShowOnboardingChecklist({
			isLoading: false,
			dismissed: opts.dismissed,
			isComplete: opts.isComplete,
			isSelfHost: opts.isSelfHost,
			sendPathReady: opts.sendPathReady,
		})
	);
}

/**
 * Whether the per-user onboarding checklist card should render. It hides while
 * state is still loading, once the member dismisses it, forever once every
 * visible step is complete, AND while an instance-scoped onboarding surface
 * (self-host banner or the instance go-live checklist) still owns the dashboard.
 * That last clause is the fix for two stacked checklists: the per-user list only
 * appears once the instance surfaces have handed off the onboarding phase.
 */
export function shouldShowUserChecklist(opts: {
	isLoading: boolean;
	dismissed: boolean;
	isComplete: boolean;
	instanceOnboardingActive: boolean;
}): boolean {
	if (opts.isLoading) return false;
	if (opts.dismissed) return false;
	if (opts.isComplete) return false;
	// Defer while an instance surface owns the onboarding phase, so the two
	// checklists never stack (see {@link isInstanceOnboardingActive}).
	if (opts.instanceOnboardingActive) return false;
	return true;
}
