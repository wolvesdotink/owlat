import type { ProviderFeedbackContribution } from '@owlat/provider-kit';
import type { AnyInboundAdapter, InboundAdapter, InboundBatchAdapter } from './pipeline';
import { verifyProviderFeedbackRequest } from './providerVerifierRegistry';

function isBatchAdapter(adapter: AnyInboundAdapter): adapter is InboundBatchAdapter {
	return 'parseEvents' in adapter;
}

/** Compose an established parser and bundle verifier into the common pipeline shape. */
export function composeProviderFeedbackAdapter<K extends string>(
	kind: K,
	contribution: ProviderFeedbackContribution<unknown>
): AnyInboundAdapter<K> {
	const parser = contribution.parser as AnyInboundAdapter<K>;
	if (!parser || parser.source !== kind || typeof parser.verifySignature !== 'function') {
		throw new TypeError(`Send provider '${kind}' has an invalid feedback parser contribution`);
	}
	const common = {
		source: kind,
		verifySignature: (request: Request, rawBody: string) =>
			verifyProviderFeedbackRequest(
				request,
				rawBody,
				contribution.verifier,
				parser.verifySignature.bind(parser)
			),
		...(parser.shouldStoreRawPayload
			? { shouldStoreRawPayload: parser.shouldStoreRawPayload.bind(parser) }
			: {}),
		...(parser.successResponse ? { successResponse: parser.successResponse.bind(parser) } : {}),
	};
	return Object.freeze(
		isBatchAdapter(parser)
			? ({
					...common,
					parseEvents: parser.parseEvents.bind(parser),
				} satisfies InboundBatchAdapter<K>)
			: ({ ...common, parseEvent: parser.parseEvent.bind(parser) } satisfies InboundAdapter<K>)
	);
}
