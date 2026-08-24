/** Isolate-safe catalog for built-in and statically bundled send transports. */

import {
	PLUGIN_SEND_TRANSPORT_MAX_CREDENTIAL_FIELDS,
	PLUGIN_SEND_TRANSPORT_MAX_ENV_VARS,
	type PluginId,
} from '@owlat/plugin-kit';
import {
	CORE_SEND_PROVIDER_CATALOG_ENTRIES,
	acceptanceSemanticsOf,
	credentialFieldEnvVars,
	deduplicatesOnIdempotencyKeyOf,
	domainVerificationOf,
	hasProviderFeedbackOf,
	isCoreSendProviderKind,
	messageIdSourceOf,
	supportsCustomReturnPathOf,
	tagsFeedbackProvenanceOf,
} from '@owlat/shared';
import { BUNDLED_PLUGIN_SEND_TRANSPORT_CATALOG } from '../../plugins/sendTransportCatalog.generated';
import { assertPluginTransportEnvVarNamespace } from './pluginEnvNamespace';
import type {
	AcceptanceSemantics,
	DomainVerificationSupport,
	MessageIdSource,
	SendProviderCatalogEntry,
	SendProviderKind,
} from './catalogTypes';

/**
 * PLAN NUMBERS below name their own plan: the comment on the entries table is
 * the SEAMS plan's, the ones on the plugin guards are too, and a bare `D2` would
 * be ambiguous with the MANDRILL plan.
 *
 * THE ENTRIES MOVED to `packages/shared/src/sendProviderCatalog.ts` — the seams
 * plan's P1.1 / D1: one catalog, in a leaf package, so web, setup-cli and docs
 * generation consume the same declaration instead of restating it (the kind
 * union alone had five declarations, two of them inside `packages/shared`). The
 * declaration vocabulary went with them; `./catalogTypes.ts` re-exports it and
 * adds the two plugin-kit-typed fields a leaf package cannot name.
 *
 * WHAT IS LEFT HERE IS THE CODE-HALF JOIN, which is the half that cannot move:
 * the bundled plugin tier's generated entries (an `apps/api` artifact), the
 * composition-time guards that refuse a plugin declaration whose prerequisites
 * live in backend code, and the ACCESSORS — every one of which reads the
 * COMPOSED catalog, so a caller asking about a plugin kind gets an answer rather
 * than an "unknown kind" throw. `@owlat/shared` exports a core-only lookup under
 * a name that says so (`coreSendProviderCatalogEntry`) for callers that have no
 * composition to consult.
 *
 * EVERY name `./catalogTypes.ts` exports is re-exported here, so every consumer
 * keeps importing `lib/sendProviders/catalog` and `vi.mock` of this module still
 * intercepts the accessors.
 */
export type {
	AcceptanceSemantics,
	CoreSendProviderCatalogEntry,
	CoreSendProviderKind,
	DeclaredCustomReturnPathSupport,
	DomainVerificationSupport,
	FeedbackProvenanceTagging,
	IdempotencyKeyDeduplication,
	MessageIdSource,
	SendProviderCatalogEntryShape,
	SendProviderCatalogEntry,
	SendProviderCredentialField,
	SendProviderKind,
	SendProviderSetupProbe,
	SendProviderTier,
} from './catalogTypes';

/**
 * The core kinds whose sending domains are verified through a provider API —
 * exactly the kinds `domains/providers` must register a domain-identity adapter
 * for (Mandrill plan D7 = the seams plan's P0.3).
 *
 * DERIVED from the catalog literal rather than restated beside it, so declaring
 * `domainVerification: 'api'` on a new kind without registering its domain
 * provider is a compile error in `domains/providers/index.ts` instead of a
 * relay that silently reports every domain unverified.
 */
export type ApiVerifiedSendProviderKind = Extract<
	(typeof CORE_SEND_PROVIDER_CATALOG_ENTRIES)[number],
	{ domainVerification: 'api' }
>['kind'];

/**
 * The core kinds that report their own delivery outcomes back to us out of band
 * — exactly the kinds `webhooks/adapters` must register an inbound adapter for
 * (the seams plan's D6 = P2.1).
 *
 * The twin of {@link ApiVerifiedSendProviderKind}, derived the same way and for
 * the same reason: `hasProviderFeedback: true` is a promise that somewhere a
 * route exists where this transport's bounces and complaints land, and the
 * promise is kept by a registry entry. Declaring it without registering an
 * adapter is a compile error in `webhooks/adapters/index.ts` rather than an arm
 * whose bad news is dropped — which reads to the ramp controller as a CLEAN arm,
 * the failure mode that has no symptom at all.
 *
 * `Extract` over the CORE catalog literal, so it narrows to the kinds this repo
 * ships. A bundled plugin entry carries a DERIVED `hasProviderFeedback` — true
 * exactly when the manifest declared a feedback `webhook` (the seams plan's
 * P3.1) — so `hasProviderFeedbackFor` answers true for plugin kinds too and the
 * governed boundary takes the `awaitingFeedback` branch for them. That
 * promise is kept by the generated `/webhooks/plugin/<pluginId>` surface (P2.2),
 * not by this mapped-type guard, which is why the tier stays outside the
 * `Extract` rather than being missing from it by oversight.
 */
export type FeedbackReportingSendProviderKind = Extract<
	(typeof CORE_SEND_PROVIDER_CATALOG_ENTRIES)[number],
	{ hasProviderFeedback: true }
>['kind'];

interface GeneratedSendTransportCatalogEntry extends SendProviderCatalogEntry {
	readonly pluginId: PluginId;
	readonly requiredCapability: 'send:transport';
}

const pluginCatalog =
	BUNDLED_PLUGIN_SEND_TRANSPORT_CATALOG as readonly GeneratedSendTransportCatalogEntry[];

/**
 * THE UNTYPED TIER FAILS CLOSED TOO (the seams plan's P0.1 / D2).
 *
 * {@link CoreSendProviderCatalogEntry} makes the two dangerous declarations a
 * BUILD BREAK for the five kinds that ship in this repo, but bundled plugin
 * entries are generated and reach the catalog through a cast, so the type says
 * nothing about them. Since plugin-tier contract parity (the seams plan's P3.1 —
 * not the Mandrill plan's P3.1) a manifest CAN declare capability fields, which
 * is exactly when this stops being hypothetical: a bundled plugin declaring
 * `idempotency-key` gets `bindMtaProviderIdentity` stamping `providerType: 'mta'`
 * onto its Sends, and one declaring `accepted` gets its ambiguous outcomes
 * replayed down an arm `withReconciliationSafety` defers until the delivery
 * deadline terminalizes them as definite failures.
 *
 * A note is not a control. This is: composing a catalog with either declaration
 * on a plugin entry throws at module load — a boot/codegen failure the author of
 * the manifest sees immediately, rather than a wrong number in a ramp decision
 * nobody attributes to a plugin. It is deliberately NOT the full core union: a
 * plugin may pair `unknown-on-timeout` with any id source, because reading the
 * two fields independently is a property the governed boundary keeps (see the
 * pairing discussion on {@link CoreSendProviderCatalogEntry}). Only the values
 * whose prerequisites live outside the catalog are refused.
 *
 * PARITY DID NOT RELAX IT, and deliberately so: the prerequisites in that note
 * are three BACKEND sites (`delivery/lastMileRouting.ts`,
 * `delivery/sendLifecycle.ts`, `delivery/sendCompletion.ts`), not contract
 * surface, so generalizing them is its own change with its own gates. What parity
 * added is a second, earlier enforcement — `PluginSendTransportMessageIdSource`
 * does not contain the word, so an author is told at `definePlugin` rather than
 * at deployment boot. This stays as the artifact-level backstop of the same rule,
 * for the same reason every other load-time guard here exists.
 */
function assertPluginDispatchSemanticsAreGeneral(
	entries: readonly GeneratedSendTransportCatalogEntry[]
): void {
	for (const entry of entries) {
		const custody = entry.acceptanceSemantics === 'accepted';
		const ownId = entry.messageIdSource === 'idempotency-key';
		if (!custody && !ownId) continue;
		throw new TypeError(
			`Bundled plugin send transport '${entry.kind}' declares ${
				custody ? 'acceptanceSemantics: accepted' : 'messageIdSource: idempotency-key'
			}, which is not yet available outside the own MTA: the custody arm and the ` +
				'pre-dispatch identity binding are still MTA-shaped. See the PREREQUISITES note ' +
				'on AcceptanceSemantics in packages/shared/src/sendProviderCatalogTypes.ts before ' +
				'enabling it.'
		);
	}
}

/**
 * THE RETURN-PATH CLAIM, RE-ASSERTED ON THE ARTIFACT (the seams plan's P3.1).
 *
 * `supportsCustomReturnPath` says our own bounce processor can attribute this
 * transport's bounces, and only `no` is true of a bundled one. Both other values
 * need an envelope sender whose local part is a VERP token signed with a
 * deployment secret — minted by `buildVerpAddress` inside the host's own relay
 * adapter — and a bundled module is handed configuration, never signing keys.
 * `probe` needs `sendReturnPathProbe` on top, which `createHostedSendProvider`
 * does not populate.
 *
 * IT IS REFUSED RATHER THAN IGNORED because ignoring it is invisible.
 * `resolveReturnPathCapabilityForEntry` reads `yes` as `capability: 'supported'`,
 * which hands the ramp controller the COMPARABLE bounce tolerance and tells the
 * connection wizard the posture is `supported` — for an arm whose bounces land at
 * the provider. Our VERP stream then sees ~0 for it and the controller ramps its
 * share against evidence that structurally cannot arrive: a measurement bias with
 * no symptom, which is exactly the class of mistake a boot failure is for.
 *
 * The kit's `PluginSendTransportCustomReturnPathSupport` refuses the words at
 * `definePlugin` and the manifest validator refuses them again; this is the third
 * reading, of the thing that actually runs.
 */
function assertPluginReturnPathClaimsAreHonest(
	entries: readonly GeneratedSendTransportCatalogEntry[]
): void {
	for (const entry of entries) {
		const declared = entry.supportsCustomReturnPath;
		if (declared === undefined || declared === 'no') continue;
		throw new TypeError(
			`Bundled plugin send transport '${entry.kind}' declares supportsCustomReturnPath: ` +
				`'${declared}', which no bundled transport can honour: the envelope sender it ` +
				'claims to stamp carries a VERP local part the host signs, and a bundled module ' +
				'is never handed that key — so the arm would be graded as measurable while its ' +
				'bounces land at the provider. See PluginSendTransportCustomReturnPathSupport in ' +
				'packages/plugin-kit/src/sendTransport.ts.'
		);
	}
}

/**
 * THE CONFIGURATION CONTRACT, RE-ASSERTED (the seams plan's P3.1) — the namespace
 * a declared variable lives in, and how many of them there may be.
 *
 * `instanceEnvVars` is the one plugin declaration whose VALUES the host reads and
 * hands to third-party code, which is why the kit fences the names to the
 * `PLUGIN_` namespace and refuses the `__` that separates an instance suffix. The
 * manifest validator applies that rule at authoring time; this applies it again
 * to the GENERATED ARTIFACT, because the artifact — not the manifest — is what
 * this deployment actually runs, and a hand edit, a bad merge, a partial
 * regeneration or a manifest validated by an older kit all end at an entry no
 * validator ever saw. An entry naming `MTA_API_KEY` would otherwise be handed
 * this deployment's own MTA credential.
 *
 * THE COUNT IS RE-ASSERTED FOR THE SAME REASON AND A DIFFERENT COST. The kit
 * bounds `instanceEnvVars` because `resolveHostedConfig` reads every one of them
 * on EVERY SEND ATTEMPT, and again on every retry: an entry listing thousands
 * turns each attempt into that many environment reads before a byte goes on the
 * wire. A bound that only manifest validation enforces is not a bound on the
 * artifact, and the artifact is where the per-send cost is actually paid.
 *
 * The predicates and the bounds are the kit's own, so the two enforcements cannot
 * drift apart. `getPluginTransportEnv` fences the same namespace a third time at
 * the read itself; that one is the backstop for a caller, this one is the
 * backstop for an artifact, and a deployment mistake must stop the deployment.
 *
 * THE CREDENTIAL FORM IS CHECKED TOO. A descriptor's `envVar` never gets read by
 * the host, but it is what a setup surface writes an operator's input INTO, so an
 * artifact whose form named `MTA_API_KEY` would offer to overwrite this
 * deployment's own credential from a plugin's panel.
 *
 * `optionalEnvVars` IS DELIBERATELY UNCHECKED, and a reader will ask why: no value
 * of it is ever handed to plugin code or written by a form. The names the host
 * resolves are `instanceEnvVars` — which the codegen composes from the required
 * AND optional lists — so an optional variable that matters is already covered
 * above, and one that is not in `instanceEnvVars` is a string nothing reads.
 */
function assertPluginConfigurationIsWithinContract(
	entries: readonly GeneratedSendTransportCatalogEntry[]
): void {
	for (const entry of entries) {
		const instanceEnvVars = entry.instanceEnvVars ?? [];
		const credentialFields = entry.credentialFields ?? [];
		assertBounded(
			entry.kind,
			'instanceEnvVars',
			instanceEnvVars.length,
			PLUGIN_SEND_TRANSPORT_MAX_ENV_VARS,
			'PLUGIN_SEND_TRANSPORT_MAX_ENV_VARS in packages/plugin-kit/src/sendTransport.ts'
		);
		assertBounded(
			entry.kind,
			'credentialFields',
			credentialFields.length,
			PLUGIN_SEND_TRANSPORT_MAX_CREDENTIAL_FIELDS,
			'PLUGIN_SEND_TRANSPORT_MAX_CREDENTIAL_FIELDS in ' +
				'packages/plugin-kit/src/sendTransportCredentials.ts'
		);
		const declared = [
			...instanceEnvVars,
			// `credentialFieldEnvVars`, not `field.envVar`: a composite descriptor
			// owns three names, and only the shared accessor knows that.
			...credentialFields.flatMap((field) => credentialFieldEnvVars(field)),
		];
		// THE NAMESPACE IS THE SECURITY FLOOR, and it is stated once — in
		// `./pluginEnvNamespace.ts`, shared with the sending-domain identity half's
		// load-time guard, so tightening the fence reaches both artifacts.
		assertPluginTransportEnvVarNamespace('Bundled plugin send transport', entry.kind, declared);
	}
}

function assertBounded(
	kind: string,
	field: string,
	length: number,
	limit: number,
	pointer: string
): void {
	if (length <= limit) return;
	throw new TypeError(
		`Bundled plugin send transport '${kind}' declares ${length} ${field}, past the ${limit} a ` +
			'bundled transport may carry — the host resolves them on every send attempt. See ' +
			`${pointer}.`
	);
}

assertPluginDispatchSemanticsAreGeneral(pluginCatalog);
assertPluginReturnPathClaimsAreHonest(pluginCatalog);
assertPluginConfigurationIsWithinContract(pluginCatalog);

export const SEND_PROVIDER_CATALOG: readonly SendProviderCatalogEntry[] = Object.freeze([
	...CORE_SEND_PROVIDER_CATALOG_ENTRIES,
	...pluginCatalog,
]);

const catalogByKind = new Map(SEND_PROVIDER_CATALOG.map((entry) => [entry.kind, entry]));

if (catalogByKind.size !== SEND_PROVIDER_CATALOG.length) {
	throw new TypeError('Bundled send transport kinds must be unique');
}

export const SEND_PROVIDER_KINDS = Object.freeze(SEND_PROVIDER_CATALOG.map((entry) => entry.kind));

/**
 * Re-exported from the catalog's own package rather than restated: the predicate
 * and the list it reads are one declaration (D1).
 */
export { isCoreSendProviderKind };

export function isSendProviderKind(kind: string | null | undefined): kind is SendProviderKind {
	return kind != null && catalogByKind.has(kind as SendProviderKind);
}

export function sendProviderCatalogEntry(kind: SendProviderKind): SendProviderCatalogEntry {
	const entry = catalogByKind.get(kind);
	if (!entry) throw new TypeError('Unknown send provider kind');
	return entry;
}

/**
 * THE ACCESSORS BELOW ARE A LOOKUP PLUS A RULE, AND ONLY THE LOOKUP IS THIS
 * FILE'S. Each resolves a kind against the COMPOSED catalog — core entries plus
 * the bundled plugin tier, which is why they cannot live in `@owlat/shared` —
 * and then defers the fail-closed default to that package's `…Of(entry)`
 * accessor, which is where each field's docblock states the rule. Web and the
 * CLI hold `coreSendProviderCatalogEntry` results and call the same `…Of`, so
 * the two consumers apply ONE rule through two lookups rather than each
 * restating a `?? false`.
 */

/**
 * This kind's declared sending-domain verification path, with the fail-closed
 * default applied. Read it instead of the raw field so an absent declaration
 * can never be mistaken for `api`.
 */
export function domainVerificationFor(kind: SendProviderKind): DomainVerificationSupport {
	return domainVerificationOf(sendProviderCatalogEntry(kind));
}

/**
 * Does this kind report delivery outcomes back to us out of band (webhook /
 * SNS)? Read it instead of the raw field so an absent declaration can never be
 * mistaken for a feedback channel that does not exist (fail closed).
 *
 * Two consumers, and they must agree: the measurement grading widens a bounce
 * tolerance for an arm whose bounces arrive over provider feedback rather than
 * our own VERP stream, and the governed dispatch boundary keeps an
 * ambiguous-acceptance send NON-TERMINAL only for a kind whose feedback could
 * still speak to it. A kind with no feedback at all has nothing to wait for.
 */
export function hasProviderFeedbackFor(kind: SendProviderKind): boolean {
	return hasProviderFeedbackOf(sendProviderCatalogEntry(kind));
}

/**
 * What a dispatch outcome MEANS for this kind — see {@link AcceptanceSemantics}.
 * Read it instead of the raw field so an absent declaration can never be
 * mistaken for custody the transport never took.
 *
 * This is the capability that replaced `providerKind === 'mta'` at the two
 * acceptance sites in `delivery/governedDispatch.ts` (the seams plan's D2).
 */
export function acceptanceSemanticsFor(kind: SendProviderKind): AcceptanceSemantics {
	return acceptanceSemanticsOf(sendProviderCatalogEntry(kind));
}

/**
 * Where this kind's provider message id comes from — see
 * {@link MessageIdSource}. Read it instead of the raw field so an absent
 * declaration can never be mistaken for an id we control.
 */
export function messageIdSourceFor(kind: SendProviderKind): MessageIdSource {
	return messageIdSourceOf(sendProviderCatalogEntry(kind));
}

/**
 * Is this transport's provider message id known BEFORE the send — i.e. is it the
 * idempotency key the governed boundary derived from the durable Send row?
 *
 * ONE definition, because two sites must agree or a Send is bound to an id it
 * will never be reported under: the pre-dispatch identity binding and the
 * recorded `providerMessageId` after a successful attempt.
 *
 * Takes the DECLARATION, not the kind — `preassignsProviderMessageId(
 * messageIdSourceFor(kind))` — so that the lookup and the derivation are
 * separable. A test that steers what a kind declares then still runs THIS rule
 * rather than a copy of it, which is the only way a later tightening here
 * cannot silently pass a suite that restated the old rule.
 */
export function preassignsProviderMessageId(source: MessageIdSource): boolean {
	return source === 'idempotency-key';
}

/**
 * Does a successful dispatch mean the transport took CUSTODY of the message
 * (delivery still pending, its own feedback still to come) rather than the
 * handoff itself — and is an ambiguous outcome therefore RE-ASKABLE by replay?
 *
 * The twin of {@link preassignsProviderMessageId}, and named for the same
 * reason: the acceptance half of the pair has three consumers already (the
 * `isCustodyHandoff` verdict and the reconciliation arm in
 * `delivery/governedDispatch.ts`, plus the pins that check them), and a raw
 * `=== 'accepted'` at each is how one of them drifts. Takes the declaration:
 * `takesCustodyOnAcceptance(acceptanceSemanticsFor(kind))`.
 */
export function takesCustodyOnAcceptance(semantics: AcceptanceSemantics): boolean {
	return semantics === 'accepted';
}

/**
 * May the same request be sent to this kind twice under one idempotency key
 * without delivering twice? — see {@link IdempotencyKeyDeduplication}.
 *
 * Read it instead of the raw field so an absent declaration can never be
 * mistaken for a dedup surface the transport does not have: this is what decides
 * whether an ambiguous password-reset send may be retried, and a wrong `true`
 * mails a real person twice.
 *
 * Takes the KIND rather than the declaration (unlike
 * {@link preassignsProviderMessageId}), because there is no derivation to
 * separate from the lookup — the field IS the answer, and the only thing the
 * accessor adds is the default.
 */
export function deduplicatesOnIdempotencyKeyFor(kind: SendProviderKind): boolean {
	return deduplicatesOnIdempotencyKeyOf(sendProviderCatalogEntry(kind));
}

/**
 * Does this kind's inbound feedback carry our own `deliveryDomain` provenance
 * tag? — see {@link FeedbackProvenanceTagging}.
 *
 * Read it instead of the raw field so an absent declaration resolves to "we do
 * not stamp this transport's feedback", which is both the fail-closed reading
 * and the true one for every transport that is not ours.
 */
export function tagsFeedbackProvenanceFor(kind: SendProviderKind): boolean {
	return tagsFeedbackProvenanceOf(sendProviderCatalogEntry(kind));
}

/**
 * Is this kind's envelope-sender control decided by a PROBE rather than by the
 * catalog? `yes` and `no` are settled declarations, so probing them would prove
 * nothing and — since every probe deliberately manufactures a bounce on the
 * operator's relay — would spend real sender reputation doing it.
 *
 * ONE definition, because two consumers must agree or the feature silently
 * half-works: the sweep decides what is worth PROVING and the routing gate
 * decides what a proof is worth READING. If they disagreed, the sweep would go
 * on proving a capability the routing gate never consults.
 */
export function isProbeDecidedReturnPathKind(kind: SendProviderKind): boolean {
	return supportsCustomReturnPathOf(catalogByKind.get(kind)) === 'probe';
}
