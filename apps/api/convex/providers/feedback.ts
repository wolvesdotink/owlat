/** Isolate-safe feedback contributions for every composed send provider. */
import type { ProviderFeedbackContribution, ProviderFeedbackVerifier } from '@owlat/provider-kit';
import type { PluginReplayBoundSignatureContract } from '@owlat/plugin-kit';
import {
	SEND_PROVIDER_CATALOG,
	isCoreSendProviderKind,
	type FeedbackReportingSendProviderKind,
} from '../lib/sendProviders/catalog';
import type { SendProviderKind } from '../lib/sendProviders/types';
import { pluginSendTransportWebhookFor } from '../plugins/sendTransportWebhookCatalog';
import { emailitAdapter } from '../webhooks/adapters/emailit';
import { mandrillAdapter } from '../webhooks/adapters/mandrill';
import { mtaAdapter } from '../webhooks/adapters/mta';
import { resendAdapter } from '../webhooks/adapters/resend';
import { sesAdapter } from '../webhooks/adapters/ses';

function hmacVerifier(
	secretEnvVar: string,
	signatureHeader: string,
	timestampHeader: string,
	algorithm: 'sha256' | 'sha1',
	encoding: 'hex' | 'base64'
): ProviderFeedbackVerifier {
	return {
		scheme: 'hmac-timestamp-body',
		algorithm,
		encoding,
		signatureHeader,
		timestampHeader,
		secretEnvVar,
		toleranceSeconds: 300,
	};
}

function pluginVerifier(signature: PluginReplayBoundSignatureContract): ProviderFeedbackVerifier {
	return {
		scheme: 'hmac-timestamp-body',
		algorithm: signature.algorithm === 'hmac-sha256' ? 'sha256' : 'sha1',
		encoding: signature.encoding,
		signatureHeader: signature.header,
		timestampHeader: signature.replay.timestampHeader,
		secretEnvVar: signature.secretEnvVar,
		toleranceSeconds: signature.replay.toleranceSeconds,
	};
}

const CORE_FEEDBACK = {
	mta: {
		webhookPath: '/webhooks/mta',
		verifier: hmacVerifier(
			'MTA_WEBHOOK_SECRET',
			'x-mta-signature',
			'x-mta-timestamp',
			'sha256',
			'hex'
		),
		parser: mtaAdapter,
	},
	ses: {
		webhookPath: '/webhooks/ses',
		verifier: {
			scheme: 'aws-sns',
			topicArnEnvVar: 'SES_SNS_TOPIC_ARN',
			toleranceSeconds: 300,
		} as const,
		parser: sesAdapter,
	},
	resend: {
		webhookPath: '/webhooks/resend',
		verifier: {
			scheme: 'svix',
			secretEnvVar: 'RESEND_WEBHOOK_SECRET',
			toleranceSeconds: 300,
		} as const,
		parser: resendAdapter,
	},
	mandrill: {
		webhookPath: '/webhooks/mandrill',
		verifier: {
			scheme: 'mandrill-form',
			secretEnvVar: 'MANDRILL_WEBHOOK_KEY',
		} as const,
		parser: mandrillAdapter,
	},
	emailit: {
		webhookPath: '/webhooks/emailit',
		verifier: hmacVerifier(
			'EMAILIT_WEBHOOK_SECRET',
			'x-emailit-signature',
			'x-emailit-timestamp',
			'sha256',
			'hex'
		),
		parser: emailitAdapter,
	},
} as const satisfies Record<
	FeedbackReportingSendProviderKind,
	ProviderFeedbackContribution<unknown>
>;

/**
 * The deployment variable a verifier reads its key from, or undefined for a
 * scheme that has no shared key at all.
 *
 * `aws-sns` is that scheme: SNS signs with a rotating certificate it names in
 * the message, so the SES entry declares a topic ARN and the catalog declares no
 * `signingKeyEnvVar` for it. Both spellings of "no key" must agree.
 */
function verifierSecretEnvVar(verifier: ProviderFeedbackVerifier): string | undefined {
	return verifier.scheme === 'aws-sns' ? undefined : verifier.secretEnvVar;
}

const contributions = new Map<SendProviderKind, ProviderFeedbackContribution<unknown>>();
for (const descriptor of SEND_PROVIDER_CATALOG) {
	if (isCoreSendProviderKind(descriptor.kind)) {
		if (descriptor.providerFeedback === undefined) continue;
		const contribution = CORE_FEEDBACK[descriptor.kind as keyof typeof CORE_FEEDBACK];
		// BOTH declared facts are compared, not just the route. The signing key is
		// the one a verifier actually reads, and the catalog's `signingKeyEnvVar` is
		// what the delivery UI tells an operator to set and what the feedback-status
		// query reports as configured. Drift between them is silent in the direction
		// that matters most — a verifier reading ANOTHER declared provider's secret
		// still finds a value in a fully configured deployment, so it rejects live
		// traffic while every "is it configured?" surface says yes.
		if (
			!contribution ||
			contribution.webhookPath !== descriptor.providerFeedback.webhookPath ||
			verifierSecretEnvVar(contribution.verifier) !== descriptor.providerFeedback.signingKeyEnvVar
		) {
			throw new TypeError(`Send provider '${descriptor.kind}' has inconsistent feedback metadata`);
		}
		contributions.set(descriptor.kind, contribution);
		continue;
	}
	if (!descriptor.pluginId) continue;
	const webhook = pluginSendTransportWebhookFor(descriptor.pluginId);
	if (!webhook) continue;
	if (webhook.definition.kind !== descriptor.kind) {
		throw new TypeError(`Bundled feedback does not belong to '${descriptor.kind}'`);
	}
	contributions.set(descriptor.kind, {
		webhookPath: `/webhooks/plugin/${webhook.definition.pluginId}`,
		verifier: pluginVerifier(webhook.definition.signature),
		parser: webhook.module,
		storeRawPayload: webhook.definition.storeRawPayload,
	});
}

export function providerFeedbackFor(
	kind: SendProviderKind
): ProviderFeedbackContribution<unknown> | undefined {
	return contributions.get(kind);
}

export const PROVIDER_FEEDBACK_CONTRIBUTIONS = Object.freeze(
	SEND_PROVIDER_CATALOG.flatMap((descriptor) => {
		const contribution = contributions.get(descriptor.kind);
		return contribution ? [{ kind: descriptor.kind, contribution }] : [];
	})
);
