import { internal } from '../../../_generated/api';
import type { Doc, Id } from '../../../_generated/dataModel';
import type { ActionCtx } from '../../../_generated/server';
import { detectSecretLeak } from '../../../lib/secretLeakScan';
import { isWithinWorkingHours } from '../../../lib/workingHours';
import { deriveAuthenticatedRecipient } from '../../referenceMonitor';
import { detectInjection, INJECTION_CONFIDENCE_THRESHOLD } from '../security_scan/patterns';

export type AutoSendGateDecision =
	| { readonly safe: true }
	| { readonly safe: false; readonly reason: string };

interface AutoSendGateContext {
	readonly action: ActionCtx;
	readonly inboundMessageId: Id<'inboundMessages'>;
	readonly now: () => number;
	readonly getMessage: () => Promise<Doc<'inboundMessages'> | null>;
}

interface CoreAutoSendGate {
	readonly id: string;
	evaluate(context: AutoSendGateContext): Promise<AutoSendGateDecision> | AutoSendGateDecision;
}

const safe = (): AutoSendGateDecision => Object.freeze({ safe: true });
const unsafe = (reason: string): AutoSendGateDecision => Object.freeze({ safe: false, reason });

const circuitBreakersGate: CoreAutoSendGate = Object.freeze({
	id: 'circuit_breakers',
	async evaluate({ action }: AutoSendGateContext) {
		const breakers = await action.runQuery(internal.agentHealth.getCircuitBreakersInternal, {});
		const openBreaker = breakers.find(
			(breaker: { readonly state: string; readonly breakerType: string }) =>
				breaker.state === 'open'
		);
		return openBreaker
			? unsafe(`Circuit breaker ${openBreaker.breakerType} is open — routing to human review.`)
			: safe();
	},
});

const messageExistsGate: CoreAutoSendGate = Object.freeze({
	id: 'message_exists',
	async evaluate({ getMessage }: AutoSendGateContext) {
		return (await getMessage())
			? safe()
			: unsafe('Message not found before send — routing to human review.');
	},
});

const spendBudgetGate: CoreAutoSendGate = Object.freeze({
	id: 'spend_budget',
	async evaluate({ action }: AutoSendGateContext) {
		try {
			const budget = await action.runQuery(internal.analytics.spendBudget.getBudgetStatus, {});
			return budget.autonomousAutoSendAllowed
				? safe()
				: unsafe(
						budget.reason ||
							'AI spend budget exhausted; not auto-sending — routing to human review.'
					);
		} catch {
			return unsafe(
				'Could not verify the AI spend budget; not auto-sending — routing to human review.'
			);
		}
	},
});

const workingHoursGate: CoreAutoSendGate = Object.freeze({
	id: 'working_hours',
	async evaluate({ action, now }: AutoSendGateContext) {
		try {
			const config = await action.runQuery(internal.agent.agentPipeline.getAgentConfig, {});
			if (!config?.isWorkingHoursEnabled) return safe();
			try {
				if (isWithinWorkingHours(config, now())) return safe();
			} catch {
				// Invalid enabled policy is uncertainty and therefore holds the send.
			}
			return unsafe(
				'Outside configured working hours; not auto-sending — held for morning human review.'
			);
		} catch {
			// Legacy behavior: an unreadable config means no enforceable window.
			return safe();
		}
	},
});

const abandonedClarificationGate: CoreAutoSendGate = messageGate(
	'abandoned_clarification',
	(message) =>
		message.isAutoSendBlocked
			? unsafe(
					'Draft was produced from an abandoned clarification (best-guess); routing to human review.'
				)
			: safe()
);

const complaintOrUrgentGate: CoreAutoSendGate = messageGate('complaint_or_urgent', (message) => {
	const classification = message.classification;
	return classification &&
		(classification.category === 'complaint' || classification.priority === 'urgent')
		? unsafe('Complaint/urgent mail is never auto-sent; routing to human review.')
		: safe();
});

const inboundGuardGate: CoreAutoSendGate = messageGate('inbound_guard', (message) =>
	message.securityFlags?.guardUnavailable
		? unsafe('Inbound injection guard was unavailable; not auto-sending — routing to human review.')
		: safe()
);

const recipientLockGate: CoreAutoSendGate = messageGate('recipient_lock', (message) =>
	deriveAuthenticatedRecipient(message.from ?? '')
		? safe()
		: unsafe(
				'Could not derive an authenticated recipient from the inbound sender; not auto-sending — routing to human review.'
			)
);

const outboundInjectionGate: CoreAutoSendGate = messageGate('outbound_injection', (message) => {
	const injection = detectInjection(message.draftResponse ?? '');
	return injection.detected && injection.confidence >= INJECTION_CONFIDENCE_THRESHOLD
		? unsafe(
				`Outbound draft tripped an injection pattern (${injection.pattern ?? 'unknown'}); not auto-sending — routing to human review.`
			)
		: safe();
});

const outboundDlpGate: CoreAutoSendGate = messageGate('outbound_dlp', (message) => {
	const leak = detectSecretLeak(message.draftResponse ?? '');
	return leak.detected
		? unsafe(
				`Outbound draft contains a credential pattern (${leak.kind}); not auto-sending — routing to human review.`
			)
		: safe();
});

const handlingRulesGate: CoreAutoSendGate = Object.freeze({
	id: 'handling_rules',
	async evaluate({ action, inboundMessageId }: AutoSendGateContext) {
		try {
			const rules = await action.runQuery(internal.mail.handlingRules.evaluateForMessage, {
				inboundMessageId,
			});
			return rules.restrictsAutoSend
				? unsafe(
						rules.reasons[0] ??
							'A handling rule holds this message for human review; not auto-sending.'
					)
				: safe();
		} catch {
			// Legacy behavior: handling rules are additive, so an unreadable layer is inert.
			return safe();
		}
	},
});

export const PRE_AUTONOMY_GATE_IDS = Object.freeze(['circuit_breakers'] as const);
export const CORE_FINAL_AUTO_SEND_GATE_IDS = Object.freeze([
	'message_exists',
	'spend_budget',
	'working_hours',
	'abandoned_clarification',
	'complaint_or_urgent',
	'inbound_guard',
	'recipient_lock',
	'outbound_injection',
	'outbound_dlp',
	'handling_rules',
] as const);

const PRE_AUTONOMY_GATES = Object.freeze([circuitBreakersGate]);
const CORE_FINAL_AUTO_SEND_GATES = Object.freeze([
	messageExistsGate,
	spendBudgetGate,
	workingHoursGate,
	abandonedClarificationGate,
	complaintOrUrgentGate,
	inboundGuardGate,
	recipientLockGate,
	outboundInjectionGate,
	outboundDlpGate,
	handlingRulesGate,
]);

export async function runPreAutonomyGates(
	action: ActionCtx,
	inboundMessageId: Id<'inboundMessages'>
): Promise<AutoSendGateDecision> {
	return runOrderedGates(PRE_AUTONOMY_GATES, createContext(action, inboundMessageId));
}

export async function runCoreFinalAutoSendGates(
	action: ActionCtx,
	inboundMessageId: Id<'inboundMessages'>
): Promise<AutoSendGateDecision> {
	return runOrderedGates(CORE_FINAL_AUTO_SEND_GATES, createContext(action, inboundMessageId));
}

function createContext(
	action: ActionCtx,
	inboundMessageId: Id<'inboundMessages'>
): AutoSendGateContext {
	let message: Promise<Doc<'inboundMessages'> | null> | undefined;
	return Object.freeze({
		action,
		inboundMessageId,
		now: Date.now,
		getMessage: () =>
			(message ??= action.runQuery(internal.agent.agentPipeline.getMessage, { inboundMessageId })),
	});
}

async function runOrderedGates(
	gates: readonly CoreAutoSendGate[],
	context: AutoSendGateContext
): Promise<AutoSendGateDecision> {
	for (const gate of gates) {
		try {
			const decision = await gate.evaluate(context);
			if (!decision.safe) return decision;
		} catch {
			return unsafe(
				`Could not evaluate the ${gate.id} autonomy gate; not auto-sending — routing to human review.`
			);
		}
	}
	return safe();
}

function messageGate(
	id: string,
	evaluate: (message: Doc<'inboundMessages'>) => AutoSendGateDecision
): CoreAutoSendGate {
	return Object.freeze({
		id,
		async evaluate({ getMessage }: AutoSendGateContext) {
			const message = await getMessage();
			return message
				? evaluate(message)
				: unsafe('Message not found before send — routing to human review.');
		},
	});
}
