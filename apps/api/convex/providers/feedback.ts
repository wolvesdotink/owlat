/** Isolate-safe feedback contributions for every composed send provider. */
import type { ProviderFeedbackContribution, ProviderFeedbackVerifier } from '@owlat/provider-kit';
import type { PluginReplayBoundSignatureContract } from '@owlat/plugin-kit';
import { SEND_PROVIDER_CATALOG, isCoreSendProviderKind } from '../lib/sendProviders/catalog';
import type { SendProviderKind } from '../lib/sendProviders/types';
import { pluginSendTransportWebhookFor } from '../plugins/sendTransportWebhookCatalog';
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
			// Resolved at request time: configured Convex site URL first, exact
			// request URL second. No deployment URL belongs in a build artifact.
			acceptedUrls: ['convex-site-or-request'],
		} as const,
		parser: mandrillAdapter,
	},
} as const satisfies Record<
	'mta' | 'ses' | 'resend' | 'mandrill',
	ProviderFeedbackContribution<unknown>
>;

const contributions = new Map<SendProviderKind, ProviderFeedbackContribution<unknown>>();
for (const descriptor of SEND_PROVIDER_CATALOG) {
	if (isCoreSendProviderKind(descriptor.kind)) {
		if (descriptor.providerFeedback === undefined) continue;
		const contribution = CORE_FEEDBACK[descriptor.kind as keyof typeof CORE_FEEDBACK];
		if (!contribution || contribution.webhookPath !== descriptor.providerFeedback.webhookPath) {
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
