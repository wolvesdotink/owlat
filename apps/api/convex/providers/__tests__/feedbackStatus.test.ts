import { describe, expect, it } from 'vitest';
import {
	PROVIDER_FEEDBACK_STALE_AFTER_MS,
	deriveProviderFeedbackStatus,
	feedbackVerifierEnvVars,
	providerKindFromTransportId,
} from '../feedbackStatus';

describe('provider feedback setup status', () => {
	it('resolves default and named transport ids without borrowing unknown kinds', () => {
		expect(providerKindFromTransportId('resend')).toBe('resend');
		expect(providerKindFromTransportId('resend#eu')).toBe('resend');
		expect(providerKindFromTransportId('postmark')).toBeNull();
	});

	it('derives configuration variables from verifier mechanisms', () => {
		expect(
			feedbackVerifierEnvVars({
				scheme: 'svix',
				secretEnvVar: 'RESEND_WEBHOOK_SECRET',
				toleranceSeconds: 300,
			})
		).toEqual(['RESEND_WEBHOOK_SECRET']);
		expect(
			feedbackVerifierEnvVars({
				scheme: 'aws-sns',
				topicArnEnvVar: 'SES_SNS_TOPIC_ARN',
				toleranceSeconds: 300,
			})
		).toEqual(['SES_SNS_TOPIC_ARN']);
	});

	it.each([
		{
			name: 'missing',
			input: { hasFeedback: true, missingVariables: ['KEY'], lastEventAt: null },
			expected: 'missing_configuration',
		},
		{
			name: 'awaiting',
			input: { hasFeedback: true, missingVariables: [], lastEventAt: null },
			expected: 'awaiting_event',
		},
		{
			name: 'healthy',
			input: { hasFeedback: true, missingVariables: [], lastEventAt: 1_001 },
			expected: 'healthy',
		},
		{
			name: 'stale',
			input: { hasFeedback: true, missingVariables: [], lastEventAt: 0 },
			expected: 'stale',
		},
		{
			name: 'not applicable',
			input: { hasFeedback: false, missingVariables: [], lastEventAt: null },
			expected: 'configured',
		},
	])('reports $name', ({ input, expected }) => {
		expect(
			deriveProviderFeedbackStatus({
				...input,
				ceremony: 'signed-webhook',
				now: PROVIDER_FEEDBACK_STALE_AFTER_MS + 1_000,
			}).status
		).toBe(expected);
	});
});
