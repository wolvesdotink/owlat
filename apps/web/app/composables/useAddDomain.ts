import type { Id } from '@owlat/api/dataModel';
import type {
	DomainReceivingMode,
	ExternalReceivingProvider,
} from '@owlat/shared/externalReceiving';
import type { AddDomainSubmitPayload } from '~/composables/useAddDomainForm';

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
	 * ATOMICALLY, in one write. Resolves to the new id, or `ok: false` on
	 * failure (the operation layer surfaces the error, including an invalid host).
	 */
	createDomain: (args: {
		domain: string;
		returnPathHost?: string;
		// The shared union, not a third hand-written spelling of it: the Convex
		// validator that accepts this argument derives from the same `as const`
		// array, so a mode this composable can send is a mode the backend takes.
		receivingMode?: DomainReceivingMode;
		externalReceivingProvider?: ExternalReceivingProvider;
	}) => Promise<BackendOperationResult<Id<'domains'>>>;
	setLoading: (loading: boolean) => void;
	close: () => void;
	showToast: (message: string, type?: 'success' | 'error') => void;
}

/**
 * Add-domain orchestration.
 *
 * The custom return-path host is passed straight into `create` as ONE atomic
 * write — not a second `setReturnPathHost` call. That keeps the domain out of the
 * create→return-path race where a registration completing after a separate
 * status patch would land as a `pending → pending` self-loop and silently drop
 * the DKIM/DMARC bundle + provider identity. An invalid host now fails `create`
 * itself (no half-created domain), surfaced by the operation layer.
 */
export function useAddDomain(deps: AddDomainFlowDeps) {
	const { t } = useI18n();

	const handleAddDomain = async (payload: AddDomainSubmitPayload) => {
		if (!deps.hasActiveOrganization()) return;

		// The receiving answer rides the SAME atomic write as the domain and the
		// return path, for the same reason: the records `create` generates depend on
		// it (the apex SPF is merged with the provider's include, TLS-RPT is
		// dropped). Setting the mode afterwards would publish a record set that is
		// wrong for the mode the operator just chose, and the operator would have
		// already been shown it.
		//
		// `'owlat'` is sent as ABSENCE rather than as a literal: absence is the
		// documented default on the schema, so an unchanged flow keeps writing rows
		// byte-identical to the ones it wrote before this choice existed.
		const external = payload.receivingMode === 'external';
		deps.setLoading(true);
		const registered = await deps.createDomain({
			domain: payload.domain,
			...(payload.returnPathHost !== null ? { returnPathHost: payload.returnPathHost } : {}),
			...(external ? { receivingMode: 'external' as const } : {}),
			...(external && payload.externalReceivingProvider
				? { externalReceivingProvider: payload.externalReceivingProvider }
				: {}),
		});
		deps.setLoading(false);

		if (!registered.ok) return;

		deps.close();
		deps.showToast(t('shared.useAddDomain.domainAdded'));
	};

	return { handleAddDomain };
}
