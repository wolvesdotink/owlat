/**
 * Pure gating logic for the dashboard's two onboarding surfaces.
 *
 * The dashboard renders exactly ONE onboarding affordance at a time. Both gates
 * read the same instance-scoped server state, so they are mutually exclusive:
 *
 * - The self-host BANNER owns the pre-send phase. It auto-hides once the
 *   instance has a verified SEND PATH — a configured delivery provider with its
 *   credentials present (`canSend`) — NOT merely a verified sending domain
 *   (a domain can be verified while the instance still cannot send a single
 *   email). `canSend` is the checklist's `sendPathReady` signal.
 * - The CHECKLIST takes over afterwards (and is the only surface in
 *   non-self-host mode). While the banner owns the pre-send phase
 *   (`isSelfHost && !sendPathReady`) it suppresses itself.
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
