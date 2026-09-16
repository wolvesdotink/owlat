/**
 * State + behaviour for the guided Add-Domain form (`AddDomainForm.vue`),
 * extracted from the SFC so the component stays under the file-size ratchet and
 * the zone/validation/compose logic is directly unit-testable. Pure move — the
 * template and its behaviour are unchanged.
 *
 * The form serves both the sending-domain and tracking-domain flows; the caller
 * passes the resolved props (context, suggestions, defaults, …) and a submit
 * callback, and gets back every binding the template needs.
 */
import { useId } from 'vue';
import { trySplitZone, isDnsLabel } from '@owlat/shared';
import type {
	DomainReceivingMode,
	ExternalReceivingProvider,
} from '@owlat/shared/externalReceiving';
import { DEFAULT_EXTERNAL_RECEIVING_PROVIDER } from '~/utils/externalReceivingLabels';
import { isFreemailDomain, resolveNs } from '~/utils/domainPrecheck';
import { useFormValidation, rules, type ValidationRule } from '~/composables/useFormValidation';

/** Props accepted by AddDomainForm (all optional; the SFC supplies defaults). */
export interface AddDomainFormProps {
	/** True while the parent's create mutation is in flight. */
	loading?: boolean;
	/**
	 * Which flow this form serves. Drives the live-preview wording (sending
	 * address vs tracking URL) and is the discriminator the return-path "Advanced"
	 * section gates on (`context === 'sending'`).
	 */
	context?: 'sending' | 'tracking';
	/** Quick-pick subdomain affordances (still free-form; any label is accepted). */
	suggestions?: readonly string[];
	/** Initial subdomain value (empty = apex). */
	defaultSubdomain?: string;
	/** Subdomain field label + trailing hint + placeholder. */
	subdomainLabel?: string;
	subdomainHint?: string;
	subdomainPlaceholder?: string;
	/**
	 * Block freemail / public-mailbox zones the user can't publish DNS for. On for
	 * sending; the tracking flow leaves it off (parity with the prior tracking add
	 * form, which never freemail-checked).
	 */
	blockFreemail?: boolean;
	/** Show the apex sending-reputation trade-off note (sending-only copy). */
	showApexNote?: boolean;
	/** Submit button label. */
	submitLabel?: string;
}

/**
 * Who accepts INBOUND mail for the domain being added.
 *
 * `'owlat'` is the historical (and still default) answer — this deployment
 * becomes the mail server and the setup panel hands over an apex MX record.
 * `'external'` is send-only: the operator's existing provider keeps the MX and
 * every incoming message, and Owlat must never ask them to change it.
 *
 * Re-exported from the shared union rather than restated, so the form, the row
 * and the Convex validator can never disagree about what the two modes are.
 */
export type ReceivingMode = DomainReceivingMode;

/**
 * The composed submit payload: the domain to register, an optional return path,
 * and the receiving answer.
 *
 * The receiving fields ride the CREATE payload rather than a follow-up write
 * because the generated records depend on them — the apex SPF is merged with the
 * provider's include and TLS-RPT is dropped for an external-receiving domain. A
 * second call would mean the domain briefly publishes records that are wrong for
 * the mode the operator just picked.
 */
export interface AddDomainSubmitPayload {
	domain: string;
	returnPathHost: string | null;
	receivingMode: ReceivingMode;
	/** The provider that keeps the MX; `null` whenever the mode is `'owlat'`. */
	externalReceivingProvider: ExternalReceivingProvider | null;
}

export function useAddDomainForm(
	props: Required<AddDomainFormProps>,
	emitSubmit: (payload: AddDomainSubmitPayload) => void
) {
	const { t } = useI18n();

	// Field state. `sub` defaults to the recommended subdomain (keeps apex
	// reputation separate for sending); clearing it is the first-class "use the
	// apex" choice.
	const domain = ref('');
	const sub = ref(props.defaultSubdomain);
	const nsUnresolved = ref(false);

	// Advanced: an optional custom return-path (bounce) subdomain, collapsed by
	// default so the common path stays a two-field form. The label composes to
	// `<label>.<registrable zone>` (a sibling of the sending name), matching how
	// the MTA keys the return-path SPF record.
	const advancedOpen = ref(false);
	const returnPathSub = ref('');

	// Receiving mode. Defaults to today's behaviour so an operator who ignores the
	// question gets byte-identical setup guidance to before. The provider pick is
	// kept even while the mode is `'owlat'` (rather than nulled) so toggling back
	// and forth doesn't silently reset an answer the operator already gave.
	const receivingMode = ref<ReceivingMode>('owlat');
	const externalProvider = ref<ExternalReceivingProvider>(DEFAULT_EXTERNAL_RECEIVING_PROVIDER);
	// The tracking flow has no inbound mail at all, so the question is neither
	// asked nor answered there — `isExternalReceiving` stays false and the payload
	// carries the default, exactly as it did before the choice existed.
	const isExternalReceiving = computed(
		() => props.context === 'sending' && receivingMode.value === 'external'
	);
	const normalizedReturnPathSub = computed(() => returnPathSub.value.trim().toLowerCase());

	const normalizedDomain = computed(() => domain.value.trim().toLowerCase());
	const normalizedSub = computed(() => sub.value.trim().toLowerCase());
	const isApex = computed(() => normalizedSub.value === '');

	// The single domain string the two fields compose to. Empty until a domain is
	// entered, so the preview reads as an example rather than a stray `mail.`.
	const combinedDomain = computed(() => {
		const base = normalizedDomain.value;
		if (!base) return '';
		return isApex.value ? base : `${normalizedSub.value}.${base}`;
	});

	// Freemail / NS checks apply to the registrable ZONE of the combined value —
	// that is the zone the user must control. `mail.gmail.com`'s zone is still
	// `gmail.com`, which they don't own, so the block must fire even though the
	// combined string isn't itself a listed freemail domain. Fall back to the raw
	// combined string while it has no registrable zone yet (mid-typing).
	const registrableZone = computed(() => trySplitZone(combinedDomain.value)?.registrable ?? null);
	const isFreemail = computed(
		() => props.blockFreemail && isFreemailDomain(registrableZone.value ?? combinedDomain.value)
	);

	// A valid domain is one that has a registrable zone; the field also accepts a
	// pasted full domain (`mail.example.com`), which `reflowDomain` normalizes.
	const domainRule: ValidationRule = (value) => {
		const raw = String(value ?? '').trim();
		if (!raw) return true; // `required` owns the empty case
		return trySplitZone(raw) !== null || t('shared.useAddDomainForm.domainInvalid');
	};

	// Subdomain is optional (empty = apex). When present, every label must be a
	// real hostname label per the shared rule (rejects underscores, bad chars).
	const subRule: ValidationRule = (value) => {
		const raw = String(value ?? '').trim();
		if (!raw) return true;
		const ok = raw
			.toLowerCase()
			.split('.')
			.every((label) => isDnsLabel(label));
		return ok || t('shared.useAddDomainForm.subdomainInvalid');
	};

	// Return-path subdomain: optional; a single hostname label when present.
	const returnPathRule: ValidationRule = (value) => {
		const raw = String(value ?? '').trim();
		if (!raw) return true;
		return isDnsLabel(raw.toLowerCase()) || t('shared.useAddDomainForm.returnPathInvalid');
	};

	const validation = useFormValidation({
		domain: [
			(value) => rules.required(t('shared.useAddDomainForm.domainRequired'))(value),
			domainRule,
		],
		sub: [subRule],
		returnPath: [returnPathRule],
	});

	const domainError = computed(() => validation.getError('domain'));
	const subError = computed(() => validation.getError('sub'));
	const returnPathError = computed(() => validation.getError('returnPath'));

	// The zone the return-path host lives in (a sibling of the sending name);
	// falls back to the placeholder zone for the example preview before a domain
	// is typed.
	const returnPathZone = computed(() => registrableZone.value ?? 'example.com');
	// The composed absolute return-path host emitted on submit — null when unset.
	const returnPathHost = computed(() =>
		normalizedReturnPathSub.value && registrableZone.value
			? `${normalizedReturnPathSub.value}.${registrableZone.value}`
			: null
	);
	const showReturnPathPreview = computed(() => !validation.hasError('returnPath'));

	// Unique, stable DOM ids per instance — this form is mounted twice on the
	// domains page (sending modal + tracking modal), so hardcoded ids would
	// collide. `useId` keeps each label↔input and aria-describedby link scoped.
	const uid = useId();
	const domainInputId = `${uid}-domain`;
	const subInputId = `${uid}-sub`;
	const domainErrorId = `${uid}-domain-error`;
	const subErrorId = `${uid}-sub-error`;
	const previewId = `${uid}-preview`;
	const advancedPanelId = `${uid}-advanced`;
	const returnPathInputId = `${uid}-returnpath`;
	const returnPathErrorId = `${uid}-returnpath-error`;
	const returnPathPreviewId = `${uid}-returnpath-preview`;

	const returnPathDescribedBy = computed(() => {
		if (returnPathError.value) return returnPathErrorId;
		return showReturnPathPreview.value ? returnPathPreviewId : undefined;
	});

	// Only promise "you'll send as …" when the preview would be truthful: not a
	// freemail domain (live), and no field currently carries a validation error.
	// `hasError` reflects the last blur/submit — mirroring the B2 preview
	// semantics — so a mid-typing value previews without a contradicting error.
	const showAddressPreview = computed(
		() => !isFreemail.value && !validation.hasError('domain') && !validation.hasError('sub')
	);

	// Wire each input to the guidance that describes it, so an AT user hears
	// *what* is wrong / what they'll get — `aria-invalid` alone only says *that*
	// something is wrong. The domain input points at its error (when present) and
	// the preview (when shown); the subdomain input points at its error.
	const domainDescribedBy = computed(() => {
		const ids: string[] = [];
		if (domainError.value) ids.push(domainErrorId);
		if (showAddressPreview.value) ids.push(previewId);
		return ids.length > 0 ? ids.join(' ') : undefined;
	});
	const subDescribedBy = computed(() => (subError.value ? subErrorId : undefined));

	// Pasting a full domain into the domain field reflows it into domain +
	// subdomain. Sub labels from the paste WIN over the current subdomain — an
	// explicit paste of `post.example.com` sets the sending subdomain to `post`.
	function reflowDomain() {
		const split = trySplitZone(normalizedDomain.value);
		if (!split) return; // invalid — the domain rule explains it on blur
		domain.value = split.registrable;
		if (split.sub) sub.value = split.sub;
	}

	// An NS verdict belongs to the exact zone it was resolved for. Clear the
	// advisory the moment the zone changes, so a live edit can't re-label the old
	// warning with the newly-typed zone before the next blur re-checks it. (The
	// in-flight lookup race is separately guarded by zone inside checkNs.)
	watch(registrableZone, () => {
		nsUnresolved.value = false;
	});

	// Fail-soft NS advisory on the registrable zone (the name that actually
	// delegates NS). Never blocks; a lookup error stays silent.
	async function checkNs() {
		nsUnresolved.value = false;
		const zone = registrableZone.value;
		if (!zone || isFreemail.value) return;
		const resolves = await resolveNs(zone);
		// Ignore a stale response if the zone changed while the lookup was in flight.
		if (registrableZone.value === zone) nsUnresolved.value = resolves === false;
	}

	function handleDomainBlur() {
		reflowDomain();
		validation.touch('domain');
		validation.validateField('domain', domain.value);
		void checkNs();
	}

	function handleSubBlur() {
		validation.touch('sub');
		validation.validateField('sub', sub.value);
	}

	function handleReturnPathBlur() {
		validation.touch('returnPath');
		validation.validateField('returnPath', returnPathSub.value);
	}

	function chooseSubdomain(value: string) {
		sub.value = value;
		validation.touch('sub');
		validation.validateField('sub', value);
	}

	function onSubmit() {
		reflowDomain();
		validation.touch('domain');
		validation.touch('sub');
		validation.touch('returnPath');
		if (
			!validation.validate({
				domain: domain.value,
				sub: sub.value,
				returnPath: returnPathSub.value,
			})
		) {
			return;
		}
		if (isFreemail.value) return;
		emitSubmit({
			domain: combinedDomain.value,
			returnPathHost: returnPathHost.value,
			receivingMode: isExternalReceiving.value ? 'external' : 'owlat',
			externalReceivingProvider: isExternalReceiving.value ? externalProvider.value : null,
		});
	}

	return {
		// state
		domain,
		sub,
		nsUnresolved,
		advancedOpen,
		returnPathSub,
		receivingMode,
		externalProvider,
		// derived
		isExternalReceiving,
		normalizedSub,
		normalizedReturnPathSub,
		isApex,
		combinedDomain,
		registrableZone,
		isFreemail,
		returnPathZone,
		// errors + preview visibility
		domainError,
		subError,
		returnPathError,
		showAddressPreview,
		showReturnPathPreview,
		// ids + aria
		domainInputId,
		subInputId,
		domainErrorId,
		subErrorId,
		previewId,
		advancedPanelId,
		returnPathInputId,
		returnPathErrorId,
		returnPathPreviewId,
		domainDescribedBy,
		subDescribedBy,
		returnPathDescribedBy,
		// handlers
		handleDomainBlur,
		handleSubBlur,
		handleReturnPathBlur,
		chooseSubdomain,
		onSubmit,
	};
}
