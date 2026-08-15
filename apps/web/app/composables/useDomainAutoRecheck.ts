import { onBeforeUnmount, ref, watch, type Ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import { createAutoRecheckPoller, type AutoRecheckPoller } from '~/utils/domainAutoRecheck';

/** The only domain facts the recheck decision depends on. */
export interface AutoRecheckDomain {
	_id: Id<'domains'>;
	status: string;
	lastRegistrationError?: string | null;
}

/**
 * Dependencies for {@link useDomainAutoRecheck}. Passed in (rather than reached
 * for) so the page keeps ownership of the domain subscription, the manual-verify
 * spinner and the concrete mutation run.
 */
export interface DomainAutoRecheckDeps {
	/** Which domain's setup panel is open — `null` when none is expanded. */
	expandedDomainId: Ref<Id<'domains'> | null>;
	/** The live domain list (a real-time subscription on the page). */
	domains: () => readonly AutoRecheckDomain[];
	/** True while a MANUAL Verify for that domain is in flight. */
	isVerifying: (domainId: Id<'domains'>) => boolean;
	/**
	 * One verification attempt. Resolves `undefined` when the operation layer
	 * already surfaced a failure — treated as "keep trying".
	 */
	verifyDomain: (args: {
		domainId: Id<'domains'>;
	}) => Promise<{ allVerified: boolean } | undefined>;
}

/**
 * Gentle auto-recheck for the expanded domain's DNS.
 *
 * Once a domain panel is expanded, keep quietly re-running verifyDomain on a
 * slow interval so the user doesn't have to click Verify over and over while DNS
 * propagates. Only runs for domains that can still become verified — never for
 * already-verified, still-registering, or failed-registration domains. Stops on
 * verify, collapse, unmount, or the poller's own attempt cap.
 *
 * The timer mechanics live in the framework-agnostic `utils/domainAutoRecheck`;
 * what this composable adds is the Vue-side lifecycle: which domain is being
 * polled, the mirrored "checking DNS…" flag, and tearing the poller down when
 * the page goes away.
 */
export function useDomainAutoRecheck(deps: DomainAutoRecheckDeps) {
	const autoRecheckActive = ref(false);

	const isAutoRecheckable = (domain: AutoRecheckDomain | undefined): boolean => {
		if (!domain) return false;
		if (domain.status === 'verified' || domain.status === 'registering') return false;
		// A failed *registration* is not something re-running DNS verification fixes.
		if (domain.status === 'failed' && domain.lastRegistrationError) return false;
		return true;
	};

	let recheckPoller: AutoRecheckPoller | null = null;
	let recheckDomainId: Id<'domains'> | null = null;

	const stopAutoRecheck = () => {
		recheckPoller?.stop();
		recheckPoller = null;
		recheckDomainId = null;
		autoRecheckActive.value = false;
	};

	const startAutoRecheck = (domainId: Id<'domains'>) => {
		// Already polling this exact domain — leave the existing poller running. A
		// poller that has self-stopped (verified / cap reached) reports isRunning()
		// false, so it is not mistaken for a live one and auto-recheck can restart.
		if (recheckPoller && recheckDomainId === domainId && recheckPoller.isRunning()) return;
		stopAutoRecheck();
		recheckDomainId = domainId;
		autoRecheckActive.value = true;
		recheckPoller = createAutoRecheckPoller({
			onTick: async () => {
				// Never overlap with a manual Verify the user just clicked.
				if (deps.isVerifying(domainId)) return false;
				const result = await deps.verifyDomain({ domainId });
				// run() already surfaced any failure; treat undefined as "keep trying".
				return result?.allVerified === true;
			},
			onStopped: () => {
				// The poller stopped itself (domain verified, or the ~5-min cap was
				// reached). Reconcile the mirror state so the subtle "Checking DNS…"
				// indicator stops instead of spinning forever, and a later domain-list
				// tick can start a fresh poller.
				if (recheckDomainId === domainId) {
					recheckPoller = null;
					recheckDomainId = null;
					autoRecheckActive.value = false;
				}
			},
		});
		recheckPoller.start();
	};

	// Drive the poller from whichever panel is open and that domain's live status
	// (the domain list is a real-time subscription, so a verify elsewhere ends it).
	watch([deps.expandedDomainId, () => deps.domains()], () => {
		const id = deps.expandedDomainId.value;
		const domain = id ? deps.domains().find((d) => d._id === id) : undefined;
		if (id && isAutoRecheckable(domain)) {
			startAutoRecheck(id);
		} else {
			stopAutoRecheck();
		}
	});

	onBeforeUnmount(() => {
		stopAutoRecheck();
	});

	return { autoRecheckActive };
}
