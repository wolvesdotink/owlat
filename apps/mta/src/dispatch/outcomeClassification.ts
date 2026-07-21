/** Pure translation from an SMTP sender result to a typed Dispatch outcome. */

import type { DestinationProviderKey, EmailJobResult } from '../types.js';
import { classifySmtpResponse, type SmtpClassification } from '../intelligence/smtpClassifier.js';

export type DispatchOutcome =
	| {
			kind: 'delivered';
			smtpCode: number;
			smtpResponse: string | undefined;
			remoteMessageId: string | undefined;
			enhancedCode: string | undefined;
	  }
	| {
			kind: 'hard_bounce';
			smtpCode: number;
			error: string;
			enhancedCode: string | undefined;
	  }
	| {
			kind: 'deferred';
			smtpCode: number;
			error: string;
			enhancedCode: string | undefined;
			classification: SmtpClassification;
	  }
	| { kind: 'soft_bounce'; error: string }
	| { kind: 'ambiguous'; error: string };

export function classifyResult(
	result: EmailJobResult,
	providerKey: DestinationProviderKey = 'other'
): DispatchOutcome {
	if (result.success) {
		return {
			kind: 'delivered',
			smtpCode: result.smtpCode ?? 250,
			smtpResponse: result.smtpResponse,
			remoteMessageId: result.remoteMessageId,
			enhancedCode: result.enhancedCode,
		};
	}

	if (result.bounceType === 'ambiguous') {
		return { kind: 'ambiguous', error: result.error ?? '' };
	}

	if (result.bounceType === 'hard') {
		return {
			kind: 'hard_bounce',
			smtpCode: result.smtpCode ?? 550,
			error: result.error ?? '',
			enhancedCode: result.enhancedCode,
		};
	}

	if (result.bounceType === 'deferred') {
		return {
			kind: 'deferred',
			smtpCode: result.smtpCode ?? 450,
			error: result.error ?? '',
			enhancedCode: result.enhancedCode,
			classification: classifySmtpResponse(
				result.smtpCode,
				result.error ?? '',
				result.enhancedCode,
				providerKey
			),
		};
	}

	return { kind: 'soft_bounce', error: result.error ?? '' };
}
