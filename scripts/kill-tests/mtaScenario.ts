/**
 * SIGKILL the MTA mid-batch and check every queued Send still terminates once.
 *
 * Each planned send is a Send row in the backend, handed to the MTA under its
 * message id. Two recipient domains are two GroupMQ groups, which the MTA
 * works in parallel and each in FIFO order. In each, the third send is pinned
 * at the sink (world/smtpSink.ts): domain A before the body (`data`), domain B
 * after the body's terminating dot (`dot`). With both pinned, the MTA
 * container is killed and started again. Then every Send must be persisted in
 * its terminal state, the receiver must hold exactly one body per send, and
 * the Send cut off after its dot must end ambiguous without a resend.
 */

import {
	checkMtaRun,
	type PlannedSend,
	type SendRowState,
	type SinkTransactionState,
	type WebhookState,
} from './oracle';
import type { KillStack } from './stack';

const DOMAINS = [
	{ name: 'a.sink.owlat.test', tag: 'a', heldAt: 'data' },
	{ name: 'b.sink.owlat.test', tag: 'b', heldAt: 'dot' },
] as const;
const SENDS_PER_DOMAIN = 5;
const HELD_POSITION = 3;
/** The resolver cache key apps/mta/src/smtp/mxResolver.ts reads before DNS. */
export const MX_CACHE_PREFIX = 'mta:mx-cache:v2:';

/**
 * A dead worker's job is only re-run once its GroupMQ deadline (the 120 s job
 * timeout past its last heartbeat) has passed and the 30 s stalled check has
 * seen it, so recovery takes minutes, not seconds. This bounds the whole wait.
 */
const RECOVERY_BUDGET_MS = 9 * 60_000;
const HOLD_BUDGET_MS = 90_000;

export function plannedSends(): PlannedSend[] {
	return DOMAINS.flatMap((domain) =>
		Array.from({ length: SENDS_PER_DOMAIN }, (_, index) => {
			const position = index + 1;
			return {
				messageId: `kill-${domain.tag}-${position}`,
				rcpt: `r${position}@${domain.name}`,
				...(position === HELD_POSITION ? { heldAt: domain.heldAt } : {}),
			};
		})
	);
}

async function queueSend(mta: string, apiKey: string, send: PlannedSend): Promise<void> {
	const response = await fetch(`http://${mta}/send/system`, {
		method: 'POST',
		headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
		body: JSON.stringify({
			messageId: send.messageId,
			to: send.rcpt,
			from: 'Owlat <noreply@owlat.example>',
			subject: `kill test ${send.messageId}`,
			html: `<p>${send.messageId}</p>`,
			text: send.messageId,
			organizationId: 'system',
			dkimDomain: 'owlat.example',
			ipPool: 'transactional',
		}),
	});
	if (!response.ok) {
		throw new Error(
			`queueing ${send.messageId} answered ${response.status}: ${await response.text()}`
		);
	}
}

export async function runMtaScenario(
	stack: KillStack,
	log: (line: string) => void
): Promise<string[]> {
	const plan = plannedSends();
	const backend = stack.backend();
	backend.seedQueuedSends(
		plan.map((send) => ({
			providerMessageId: send.messageId,
			email: send.rcpt,
			subject: `kill test ${send.messageId}`,
		})),
		stack.scratchDir
	);
	// Route both domains to the sink. The MTA reads this cache before DNS, and
	// the test network has no DNS server that could answer an MX query.
	for (const domain of DOMAINS) {
		const route = {
			status: 'deliverable',
			source: 'mx',
			hosts: [{ exchange: 'mx.sink.owlat.test', priority: 10 }],
		};
		stack.compose([
			'exec',
			'-T',
			'redis',
			'redis-cli',
			'SET',
			`${MX_CACHE_PREFIX}${domain.name}`,
			JSON.stringify(route),
			'EX',
			'86400',
		]);
	}
	const held = plan.filter((send) => send.heldAt);
	await stack.holdSmtp(held.map((send) => ({ rcpt: send.rcpt, point: send.heldAt! })));

	const mta = stack.address('mta', 3100);
	for (const send of plan) await queueSend(mta, stack.secrets.mtaApiKey, send);
	log(`queued ${plan.length} sends`);
	for (const send of held) await stack.waitFor(`smtp.held:${send.rcpt}`, HOLD_BUDGET_MS);
	log(`pinned ${held.map((s) => `${s.messageId}@${s.heldAt}`).join(', ')}; killing mta`);

	stack.kill('mta');
	// The kill closed the pinned SMTP sessions: the sink saw the peer go.
	for (const send of held) await stack.waitFor(`smtp.dropped:${send.rcpt}`, HOLD_BUDGET_MS);
	stack.restart('mta');
	log('mta restarted; waiting for the backend to acknowledge a terminal event for every send');

	// The backend answers a webhook after its transition committed, so once
	// every terminal event is acknowledged the Send rows are final.
	const deadline = Date.now() + RECOVERY_BUDGET_MS;
	for (const send of plan) {
		await stack.waitFor(`mta.terminal:${send.messageId}`, Math.max(1, deadline - Date.now()));
	}
	const state = await stack.state<{ smtp: SinkTransactionState[]; webhooks: WebhookState[] }>();
	const sends = backend.rows('transactionalSends') as unknown as SendRowState[];
	return checkMtaRun(plan, state.smtp, state.webhooks, sends);
}
