/**
 * The admin delivery test send's decisions: given what the action has learned
 * so far, what it does next, or the stage-by-stage answer it returns.
 *
 * Pure. `statusActions.ts:sendTest` reads the configuration, runs each step
 * this module names (a roster read and rate-limit token, the sender identity,
 * the provider call, the readiness record) and asks again with what that step
 * returned. The trace is rebuilt from the facts on every call, so the answer
 * depends on nothing but them.
 */

import { normalizeEmail } from '@owlat/shared';
import { isValidEmail } from '../lib/inputGuards';

type DeliveryTestStageKey =
	| 'provider_configuration'
	| 'recipient_validation'
	| 'sender_resolution'
	| 'provider_acceptance'
	| 'result_recording';

interface DeliveryTestStage {
	key: DeliveryTestStageKey;
	label: string;
	status: 'passed' | 'failed' | 'not_run';
	detail: string;
}

export interface DeliveryTestResult {
	success: boolean;
	error: string | null;
	provider: string | null;
	providerMessageId: string | null;
	latencyMs: number | null;
	attempts: number | null;
	stages: DeliveryTestStage[];
}

/** The provider's receipt for an accepted test message. */
export interface DeliveryTestReceipt {
	readonly provider: string;
	readonly providerMessageId: string;
	readonly latencyMs: number;
	readonly attempts: number;
}

/** What the action knows; each later field is absent until its step ran. */
export interface DeliveryTestFacts {
	/** `EMAIL_PROVIDER` as configured. */
	readonly provider: string | undefined;
	/** A registered transport whose requirements are met. */
	readonly isProviderUsable: boolean;
	/** The recipient as the admin typed it. */
	readonly to: string;
	readonly recipient?: {
		readonly isRateLimited: boolean;
		/** The org's member inboxes, lowercased. */
		readonly allowed: readonly string[];
	};
	readonly sender?:
		| { readonly kind: 'unavailable' }
		| {
				readonly kind: 'loaded';
				readonly defaultFromEmail: string | null;
				readonly defaultFromName: string | null;
				/** `DEFAULT_FROM_DOMAIN`, for the noreply fallback. */
				readonly defaultFromDomain: string | undefined;
		  };
	readonly dispatch?:
		| { readonly kind: 'refused' }
		| { readonly kind: 'accepted'; readonly receipt: DeliveryTestReceipt };
	readonly recording?: 'recorded' | 'failed';
}

export interface DeliveryTestMessage {
	readonly to: string;
	readonly from: string;
	readonly subject: string;
	readonly html: string;
}

export type DeliveryTestStep =
	/** Read the member roster and spend one of the caller's rate-limit tokens. */
	| { readonly kind: 'checkRecipient' }
	/** Read the instance's default sender identity. */
	| { readonly kind: 'resolveSender' }
	/** Hand the message to the system transport. */
	| { readonly kind: 'dispatch'; readonly message: DeliveryTestMessage }
	/** Record the readiness timestamp. */
	| { readonly kind: 'record' }
	| { readonly kind: 'answer'; readonly result: DeliveryTestResult };

const STAGES: readonly (readonly [DeliveryTestStageKey, string, string])[] = [
	['provider_configuration', 'Provider configuration', 'Not checked'],
	['recipient_validation', 'Recipient address', 'Not checked'],
	['sender_resolution', 'Sender identity', 'Not checked'],
	['provider_acceptance', 'Provider acceptance', 'Not attempted'],
	['result_recording', 'Readiness record', 'Not attempted'],
];

const NO_RECEIPT = { providerMessageId: null, latencyMs: null, attempts: null } as const;

/** The stages in order: the ones reached as given, the rest not run. */
function trace(reached: readonly (readonly [DeliveryTestStage['status'], string])[]) {
	return STAGES.map(([key, label, notRun], index): DeliveryTestStage => {
		const [status, detail] = reached[index] ?? ['not_run', notRun];
		return { key, label, status, detail };
	});
}

function answer(
	reached: readonly (readonly [DeliveryTestStage['status'], string])[],
	patch: Omit<DeliveryTestResult, 'stages'>
): DeliveryTestStep {
	return { kind: 'answer', result: { ...patch, stages: trace(reached) } };
}

export function nextDeliveryTestStep(facts: DeliveryTestFacts): DeliveryTestStep {
	const { provider } = facts;
	if (!facts.isProviderUsable || provider === undefined) {
		return answer([['failed', 'No usable provider is configured']], {
			success: false,
			error:
				'No delivery provider is configured. Set EMAIL_PROVIDER to a registered transport and configure its requirements, then try again.',
			provider: provider ?? null,
			...NO_RECEIPT,
		});
	}
	const refused = (error: string) => ({ success: false, error, provider, ...NO_RECEIPT });
	const reached: [DeliveryTestStage['status'], string][] = [
		['passed', `${provider} is configured`],
	];

	const to = facts.to.trim();
	if (!isValidEmail(to)) {
		return answer(
			[...reached, ['failed', 'Recipient address is invalid']],
			refused('Enter a valid recipient address for the test email.')
		);
	}
	// Restrict the recipient to an org-member inbox + per-user rate limit, so this
	// admin test action can't be looped into an open relay that sprays mail from
	// the instance's verified sending identity to arbitrary external addresses
	// (mirrors campaigns/testSend). Both checks reuse the shared campaign-test
	// gate so the two preview paths can't drift.
	if (facts.recipient === undefined) return { kind: 'checkRecipient' };
	if (facts.recipient.isRateLimited) {
		return answer(
			[...reached, ['failed', 'Too many test emails — wait a moment and try again']],
			refused('Too many test emails — please wait a moment and try again.')
		);
	}
	if (!facts.recipient.allowed.includes(normalizeEmail(to))) {
		return answer(
			[...reached, ['failed', 'Recipient is not an organization member address']],
			refused(
				"Test emails can only be sent to your organization's own member addresses. Add the recipient as a member, or use their member address."
			)
		);
	}
	reached.push(['passed', 'Recipient address is valid']);

	if (facts.sender === undefined) return { kind: 'resolveSender' };
	if (facts.sender.kind === 'unavailable') {
		return answer(
			[...reached, ['failed', 'Could not load the sender identity']],
			refused('Could not resolve the sender identity. Check the deployment logs.')
		);
	}
	const { sender } = facts;
	const fromEmail =
		sender.defaultFromEmail || `noreply@${sender.defaultFromDomain || 'mail.owlat.app'}`;
	const fromName = sender.defaultFromName || 'Owlat';
	if (!isValidEmail(fromEmail)) {
		return answer(
			[...reached, ['failed', 'Default sender address is invalid']],
			refused('The default sender address is invalid. Update the sender identity and try again.')
		);
	}
	reached.push(['passed', `Sending as ${fromEmail}`]);

	if (facts.dispatch === undefined) {
		return {
			kind: 'dispatch',
			message: {
				to,
				from: `${fromName} <${fromEmail}>`,
				subject: 'Owlat delivery test',
				html:
					'<p>This is a test email from your Owlat instance.</p>' +
					`<p>If you received it, your delivery provider (<strong>${provider}</strong>) is working.</p>`,
			},
		};
	}
	// The provider's error detail never reaches this module (it can carry
	// endpoint or credential hints); the answer is a safe, actionable message.
	if (facts.dispatch.kind === 'refused') {
		return answer(
			[...reached, ['failed', `${provider} did not accept the message`]],
			refused('Test send failed. Check your provider credentials and the deployment logs.')
		);
	}
	const { receipt } = facts.dispatch;
	reached.push(['passed', `Accepted as ${receipt.providerMessageId}`]);

	// Acceptance is not called delivery: the recipient inbox or provider feedback
	// confirms that later.
	if (facts.recording === undefined) return { kind: 'record' };
	const isRecorded = facts.recording === 'recorded';
	return answer(
		[
			...reached,
			isRecorded
				? ['passed', 'Readiness timestamp recorded']
				: ['failed', 'Could not record the readiness result'],
		],
		{
			success: isRecorded,
			error: isRecorded
				? null
				: 'The provider accepted the message, but the readiness result could not be recorded.',
			...receipt,
		}
	);
}
