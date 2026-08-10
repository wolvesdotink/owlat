import type { ProviderFeedbackContribution, ProviderFeedbackVerifier } from '@owlat/provider-kit';
import type {
	AnyInboundAdapter,
	AnyInboundParser,
	InboundAdapter,
	InboundBatchAdapter,
	InboundBatchParser,
} from './pipeline';
import { verifyProviderFeedbackRequest } from './providerVerifierRegistry';

function isBatchParser(parser: AnyInboundParser): parser is InboundBatchParser {
	return 'parseEvents' in parser;
}

/**
 * The one scheme whose verification the host cannot parameterize, and so the one
 * scheme that reads a verifier off the contribution.
 *
 * SNS signs with a rotating certificate it names in the message, which needs a
 * fetch, a cache and a subscription-ARN constraint — not a declared header and
 * secret. Every other scheme is fully described by its declaration, so the
 * parser beside it is asked for event semantics ONLY: a `verifySignature` the
 * host would bind but never call is dead code that reads as a security control.
 */
const LEGACY_VERIFIER_SCHEME: ProviderFeedbackVerifier['scheme'] = 'aws-sns';

/**
 * The contribution's own verifier, bound only when the DECLARED scheme is the
 * one that consumes it. A parser that carries the method under any other scheme
 * does not get it called — the registry answers `aws-sns` with a 503 when the
 * verifier is absent, so a mismatch fails closed rather than falling through to
 * an unverified body.
 */
function legacyVerifierOf(
	parser: AnyInboundParser,
	verifier: ProviderFeedbackVerifier
): InboundAdapter['verifySignature'] | undefined {
	if (verifier.scheme !== LEGACY_VERIFIER_SCHEME) return undefined;
	const candidate = parser as Partial<InboundAdapter>;
	return typeof candidate.verifySignature === 'function'
		? candidate.verifySignature.bind(parser)
		: undefined;
}

/** Compose an established parser and bundle verifier into the common pipeline shape. */
export function composeProviderFeedbackAdapter<K extends string>(
	kind: K,
	contribution: ProviderFeedbackContribution<unknown>
): AnyInboundAdapter<K> {
	const parser = contribution.parser as AnyInboundParser<K>;
	if (
		!parser ||
		parser.source !== kind ||
		((!('parseEvent' in parser) || typeof parser.parseEvent !== 'function') &&
			(!('parseEvents' in parser) || typeof parser.parseEvents !== 'function'))
	) {
		throw new TypeError(`Send provider '${kind}' has an invalid feedback parser contribution`);
	}
	const legacyVerifier = legacyVerifierOf(parser, contribution.verifier);
	const common = {
		source: kind,
		verifySignature: (request: Request, rawBody: string) =>
			verifyProviderFeedbackRequest(request, rawBody, contribution.verifier, legacyVerifier),
		...(parser.shouldStoreRawPayload
			? { shouldStoreRawPayload: parser.shouldStoreRawPayload.bind(parser) }
			: {}),
		...(parser.successResponse ? { successResponse: parser.successResponse.bind(parser) } : {}),
	};
	return Object.freeze(
		isBatchParser(parser)
			? ({
					...common,
					parseEvents: parser.parseEvents.bind(parser),
				} satisfies InboundBatchAdapter<K>)
			: ({ ...common, parseEvent: parser.parseEvent.bind(parser) } satisfies InboundAdapter<K>)
	);
}
