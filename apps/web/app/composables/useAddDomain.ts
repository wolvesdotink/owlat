import type { Id } from '@owlat/api/dataModel';

/**
 * Dependencies for {@link useAddDomain}. Passed in (rather than reached for)
 * so the orchestration is a plain, directly-testable function — the page owns
 * the concrete mutation run, modal and toast.
 */
export interface AddDomainFlowDeps {
	/** True when a team is selected (guard before any write). */
	hasActiveOrganization: () => boolean;
	/**
	 * Register the domain — optionally with a custom return-path host set
	 * ATOMICALLY (F2 finding 1). Resolves to the new id, or `undefined` on failure
	 * (the operation layer surfaces the error, including an invalid host).
	 */
	createDomain: (args: {
		domain: string;
		returnPathHost?: string;
	}) => Promise<Id<'domains'> | undefined>;
	setLoading: (loading: boolean) => void;
	close: () => void;
	showToast: (message: string, type?: 'success' | 'error') => void;
}

/**
 * Add-domain orchestration (piece D3; F2 finding 1).
 *
 * The custom return-path host is passed straight into `create` as ONE atomic
 * write — not a second `setReturnPathHost` call. That keeps the domain out of the
 * create→return-path race where a registration completing after a separate
 * status patch would land as a `pending → pending` self-loop and silently drop
 * the DKIM/DMARC bundle + provider identity. An invalid host now fails `create`
 * itself (no half-created domain), surfaced by the operation layer.
 */
export function useAddDomain(deps: AddDomainFlowDeps) {
	const handleAddDomain = async (payload: { domain: string; returnPathHost: string | null }) => {
		if (!deps.hasActiveOrganization()) return;

		deps.setLoading(true);
		const domainId = await deps.createDomain({
			domain: payload.domain,
			...(payload.returnPathHost !== null ? { returnPathHost: payload.returnPathHost } : {}),
		});
		deps.setLoading(false);

		if (domainId === undefined) return;

		deps.close();
		deps.showToast('Domain added successfully. Configure your DNS records to verify.');
	};

	return { handleAddDomain };
}
