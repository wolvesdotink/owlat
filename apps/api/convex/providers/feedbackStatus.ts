import type { ProviderFeedbackVerifier } from '@owlat/provider-kit';
import { isSendProviderKind, type SendProviderKind } from '../lib/sendProviders/catalog';

export const PROVIDER_FEEDBACK_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1_000;

export type ProviderFeedbackSetupStatus =
	| 'configured'
	| 'missing_configuration'
	| 'awaiting_event'
	| 'healthy'
	| 'stale';

export interface ProviderFeedbackStatus {
	readonly status: ProviderFeedbackSetupStatus;
	readonly lastEventAt: number | null;
	readonly missingVariables: readonly string[];
	readonly ceremony: 'none' | 'signed-webhook' | 'sns-topic';
}

export function providerKindFromTransportId(transportId: string): SendProviderKind | null {
	const separator = transportId.indexOf('#');
	const kind = separator === -1 ? transportId : transportId.slice(0, separator);
	return isSendProviderKind(kind) ? kind : null;
}

export function feedbackVerifierEnvVars(verifier: ProviderFeedbackVerifier): readonly string[] {
	switch (verifier.scheme) {
		case 'hmac-timestamp-body':
		case 'svix':
		case 'mandrill-form':
			return [verifier.secretEnvVar];
		case 'aws-sns':
			return [verifier.topicArnEnvVar];
	}
}

export function deriveProviderFeedbackStatus(input: {
	readonly hasFeedback: boolean;
	readonly ceremony: ProviderFeedbackStatus['ceremony'];
	readonly missingVariables: readonly string[];
	readonly lastEventAt: number | null;
	readonly now: number;
}): ProviderFeedbackStatus {
	const { hasFeedback, ceremony, missingVariables, lastEventAt, now } = input;
	let status: ProviderFeedbackSetupStatus;
	if (missingVariables.length > 0) status = 'missing_configuration';
	else if (!hasFeedback) status = 'configured';
	else if (lastEventAt === null) status = 'awaiting_event';
	else if (now - lastEventAt > PROVIDER_FEEDBACK_STALE_AFTER_MS) status = 'stale';
	else status = 'healthy';
	return { status, lastEventAt, missingVariables, ceremony };
}
