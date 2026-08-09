/** Host-assigned provenance. A provider manifest never controls this value. */
export type ProviderBundleSource = 'own' | 'first-party' | 'third-party';

/** A build-time verified module export. It is not executed by this package. */
export interface ProviderStaticModuleExport {
	readonly exportPath: string;
}

/** An executable contribution, represented either directly or by a static export. */
export type ProviderModuleExport<T = unknown> = T | ProviderStaticModuleExport;

export interface SendProviderDescriptor<K extends string = string> {
	readonly kind: K;
	readonly label: string;
	readonly retryDelays: readonly number[];
	readonly requiredEnvVars: readonly string[];
	readonly optionalEnvVars?: readonly string[];
	readonly acceptanceSemantics?: 'accepted' | 'unknown-on-timeout';
	readonly messageIdSource?: 'provider' | 'idempotency-key' | 'composed';
	readonly deduplicatesOnIdempotencyKey?: boolean;
	readonly supportsCustomReturnPath?: 'yes' | 'no' | 'probe';
	readonly tagsFeedbackProvenance?: boolean;
}

export interface HmacTimestampBodyVerifier {
	readonly scheme: 'hmac-timestamp-body';
	readonly algorithm: 'sha256' | 'sha1';
	readonly encoding: 'hex' | 'base64';
	readonly signatureHeader: string;
	readonly timestampHeader: string;
	readonly secretEnvVar: string;
	readonly toleranceSeconds: number;
}

export type ProviderFeedbackVerifier =
	| HmacTimestampBodyVerifier
	| {
			readonly scheme: 'svix';
			readonly secretEnvVar: string;
			readonly toleranceSeconds: number;
	  }
	| {
			readonly scheme: 'aws-sns';
			readonly topicArnEnvVar: string;
			readonly toleranceSeconds: number;
	  }
	| {
			readonly scheme: 'mandrill-form';
			readonly secretEnvVar: string;
			readonly acceptedUrls: readonly string[];
	  };

export type ProviderFeedbackEvent =
	| { readonly kind: 'sent'; readonly providerMessageId: string; readonly at: number }
	| {
			readonly kind: 'delivered';
			readonly providerMessageId: string;
			readonly at: number;
			readonly recipient?: string;
	  }
	| {
			readonly kind: 'deferred';
			readonly providerMessageId: string;
			readonly at: number;
			readonly reason?: string;
	  }
	| {
			readonly kind: 'bounced';
			readonly providerMessageId: string;
			readonly at: number;
			readonly bounceType: 'hard' | 'soft';
			readonly bounceMessage?: string;
	  }
	| {
			readonly kind: 'complained';
			readonly at: number;
			readonly providerMessageId?: string;
			readonly recipient?: string;
	  }
	| {
			readonly kind: 'failed';
			readonly providerMessageId: string;
			readonly at: number;
			readonly code: string;
			readonly recipient?: string;
	  }
	| {
			readonly kind: 'unsubscribed';
			readonly at: number;
			readonly recipient: string;
			readonly providerMessageId?: string;
	  }
	| {
			readonly kind: 'provider_suppressed';
			readonly at: number;
			readonly recipient: string;
			readonly reason: 'recipient_rejected' | 'recipient_blacklisted' | 'invalid_recipient';
			readonly providerMessageId?: string;
	  };

export interface ProviderFeedbackParserModule {
	parseEvents(rawBody: string): readonly ProviderFeedbackEvent[];
}

export interface ProviderFeedbackContribution<Parser = ProviderFeedbackParserModule> {
	readonly webhookPath: string;
	readonly verifier: ProviderFeedbackVerifier;
	readonly parser: ProviderModuleExport<Parser>;
	readonly storeRawPayload?: boolean;
	readonly successStatus?: number;
}

export interface ProviderSetupProbeModule {
	probe(config: Readonly<Record<string, string>>): Promise<{ readonly ok: boolean }>;
}

export interface ProviderSetupContribution {
	readonly probe?: ProviderModuleExport<ProviderSetupProbeModule>;
	readonly ceremony?: 'none' | 'signed-webhook' | 'sns-topic';
}

export interface SendProviderBundle<
	K extends string = string,
	Transport = unknown,
	FeedbackParser = ProviderFeedbackParserModule,
	PrimaryDomainIdentity = unknown,
	RelayDomainIdentity = unknown,
> {
	readonly descriptor: SendProviderDescriptor<K>;
	readonly transport: ProviderModuleExport<Transport>;
	readonly feedback?: ProviderFeedbackContribution<FeedbackParser>;
	readonly primaryDomainIdentity?: ProviderModuleExport<PrimaryDomainIdentity>;
	readonly relayDomainIdentity?: ProviderModuleExport<RelayDomainIdentity>;
	readonly setup?: ProviderSetupContribution;
	readonly platformHooks?: ProviderModuleExport;
}

export interface SourceAssignedProviderBundle<
	K extends string = string,
	Transport = unknown,
	FeedbackParser = ProviderFeedbackParserModule,
> {
	readonly source: ProviderBundleSource;
	readonly bundle: SendProviderBundle<K, Transport, FeedbackParser>;
}

export interface ComposedSendProviderBundle<
	K extends string = string,
	Transport = unknown,
	FeedbackParser = ProviderFeedbackParserModule,
> extends SendProviderBundle<K, Transport, FeedbackParser> {
	readonly source: ProviderBundleSource;
}

export class ProviderBundleCompositionError extends TypeError {
	constructor(message: string) {
		super(message);
		this.name = 'ProviderBundleCompositionError';
	}
}

/** Identity helper that keeps literal kinds and executable module types intact. */
export function defineSendProviderBundle<const B extends SendProviderBundle>(bundle: B): B {
	return bundle;
}

function assertFiniteRetryDelays(kind: string, delays: readonly number[]): void {
	if (
		delays.length > 3 ||
		delays.some((delay) => !Number.isSafeInteger(delay) || delay < 0 || delay > 86_400_000)
	) {
		throw new ProviderBundleCompositionError(
			`Send provider '${kind}' declares invalid retry delays`
		);
	}
}

function assertSourceCapabilities(
	item: SourceAssignedProviderBundle<string, unknown, unknown>
): void {
	const { source, bundle } = item;
	const { descriptor } = bundle;
	if (source !== 'own' && bundle.platformHooks !== undefined) {
		throw new ProviderBundleCompositionError(
			`Send provider '${descriptor.kind}' cannot expose platform hooks at '${source}' trust`
		);
	}
	if (
		source !== 'own' &&
		(descriptor.acceptanceSemantics === 'accepted' ||
			descriptor.messageIdSource === 'idempotency-key' ||
			descriptor.tagsFeedbackProvenance === true)
	) {
		throw new ProviderBundleCompositionError(
			`Send provider '${descriptor.kind}' claims an own-only dispatch capability`
		);
	}
	if (source === 'third-party' && bundle.primaryDomainIdentity !== undefined) {
		throw new ProviderBundleCompositionError(
			`Send provider '${descriptor.kind}' cannot own primary domain identity at third-party trust`
		);
	}
}

/**
 * Validate and freeze one deterministic provider composition.
 *
 * The host supplies provenance beside each bundle. The bundle has no trust field,
 * so generated or third-party data cannot self-escalate.
 */
export function composeProviderBundles<
	const Items extends readonly SourceAssignedProviderBundle<string, unknown, unknown>[],
>(items: Items): readonly ComposedSendProviderBundle<string, unknown, unknown>[] {
	const kinds = new Set<string>();
	const routes = new Set<string>();
	const result: ComposedSendProviderBundle<string, unknown, unknown>[] = [];
	for (const item of items) {
		const { descriptor } = item.bundle;
		if (descriptor.kind.length === 0 || descriptor.label.length === 0) {
			throw new ProviderBundleCompositionError('Send provider kind and label are required');
		}
		if (kinds.has(descriptor.kind)) {
			throw new ProviderBundleCompositionError(`Duplicate send provider kind '${descriptor.kind}'`);
		}
		kinds.add(descriptor.kind);
		assertFiniteRetryDelays(descriptor.kind, descriptor.retryDelays);
		assertSourceCapabilities(item);
		if (item.bundle.feedback !== undefined) {
			if (routes.has(item.bundle.feedback.webhookPath)) {
				throw new ProviderBundleCompositionError(
					`Duplicate provider feedback route '${item.bundle.feedback.webhookPath}'`
				);
			}
			routes.add(item.bundle.feedback.webhookPath);
		}
		result.push(Object.freeze({ ...item.bundle, source: item.source }));
	}
	return Object.freeze(result);
}
