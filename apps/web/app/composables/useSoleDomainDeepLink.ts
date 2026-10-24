/**
 * The palette's DKIM result lands on the Domains page at `#sending-domain-list`.
 * With exactly one domain, that domain's records open too: the panel is where
 * its DKIM record lives.
 *
 * The expansion is a one-shot answer to a navigation, not a standing rule. It is
 * armed when the hash becomes the anchor and spent the first time the domain
 * list can answer it (the query may still be loading on arrival). After that a
 * live update to the list (a DNS check landing, say) must not reopen a panel
 * the operator has since collapsed.
 */
import { watch } from 'vue';

const SENDING_DOMAIN_LIST_ANCHOR = '#sending-domain-list';

export function useSoleDomainDeepLink<DomainId>(opts: {
	hash: () => string;
	/** The domain list, `undefined` while its query loads. */
	domains: () => readonly { _id: DomainId }[] | undefined;
	isAnyExpanded: () => boolean;
	expand: (domainId: DomainId) => void;
}): void {
	let seenHash: string | undefined;
	let pending = false;

	watch(
		() => [opts.hash(), opts.domains()] as const,
		([hash, domains]) => {
			if (hash !== seenHash) {
				seenHash = hash;
				pending = hash === SENDING_DOMAIN_LIST_ANCHOR;
			}
			if (!pending || domains === undefined) return;
			pending = false;
			const only = domains.length === 1 ? domains[0] : undefined;
			if (!only || opts.isAnyExpanded()) return;
			opts.expand(only._id);
		},
		{ immediate: true }
	);
}
