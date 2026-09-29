/** Pure translation from an SMTP sender result to a typed Dispatch outcome. */

import type { DestinationProviderKey } from '@owlat/shared/deliverabilityRouting';
import type { EmailJobResult } from '../types.js';
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
			/**
			 * What the reply means, for the ramp's measurement only: the bounce is
			 * terminal whatever the category says.
			 */
			classification: SmtpClassification;
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
		const error = result.error ?? '';
		return {
			kind: 'hard_bounce',
			smtpCode: result.smtpCode ?? 550,
			error,
			enhancedCode: result.enhancedCode,
			classification: classifySmtpResponse(
				result.smtpCode,
				error,
				result.enhancedCode,
				providerKey
			),
		};
	}

	if (result.bounceType === 'deferred') {
		const error = result.error ?? '';
		return {
			kind: 'deferred',
			smtpCode: result.smtpCode ?? 450,
			error,
			enhancedCode: result.enhancedCode,
			classification: classifySmtpResponse(
				result.smtpCode,
				error,
				result.enhancedCode,
				providerKey
			),
		};
	}

	return { kind: 'soft_bounce', error: result.error ?? '' };
}
