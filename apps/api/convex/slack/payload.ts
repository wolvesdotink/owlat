/**
 * Parse a Slack interactive-message callback body into the minimal, typed vote
 * the endpoint acts on (PP-26). Slack posts
 * `application/x-www-form-urlencoded` with a single `payload=<url-encoded JSON>`
 * field describing a Block Kit button interaction.
 *
 * Everything here is UNTRUSTED. The parser extracts only three primitive fields
 * and validates each — it never evaluates or reflects Slack-supplied structure —
 * and returns `null` on anything malformed so the endpoint fails closed (no vote
 * recorded) rather than trusting a partial payload.
 */

/** action_id values Owlat renders on its approve / reject buttons. */
const APPROVE_ACTION_ID = 'owlat_approval_approve';
const REJECT_ACTION_ID = 'owlat_approval_reject';

const MAX_TOKEN_LENGTH = 128;
const MAX_SLACK_USER_ID_LENGTH = 64;

export interface SlackApprovalCallback {
	/** Opaque approval-request token Owlat embedded in the Slack message. */
	readonly approvalToken: string;
	readonly slackUserId: string;
	readonly decision: 'approve' | 'reject';
}

/**
 * Parse the raw callback body. Returns the vote, or `null` when the body is not
 * a well-formed Owlat approval interaction.
 */
export function parseSlackApprovalCallback(rawBody: string): SlackApprovalCallback | null {
	const payloadJson = extractPayloadField(rawBody);
	if (payloadJson === null) return null;

	let payload: unknown;
	try {
		payload = JSON.parse(payloadJson);
	} catch {
		return null;
	}
	if (!isRecord(payload)) return null;

	const slackUserId = readShortString(
		isRecord(payload['user']) ? payload['user']['id'] : undefined,
		MAX_SLACK_USER_ID_LENGTH
	);
	if (slackUserId === null) return null;

	const action = firstOwlatAction(payload['actions']);
	if (action === null) return null;

	const approvalToken = readShortString(action.value, MAX_TOKEN_LENGTH);
	if (approvalToken === null) return null;

	return Object.freeze({ approvalToken, slackUserId, decision: action.decision });
}

/** Re-export so callers keep one import site for the action-id contract. */
export { APPROVE_ACTION_ID, REJECT_ACTION_ID };

function firstOwlatAction(
	actions: unknown
): { readonly decision: 'approve' | 'reject'; readonly value: unknown } | null {
	if (!Array.isArray(actions)) return null;
	for (const entry of actions) {
		if (!isRecord(entry)) continue;
		const actionId = entry['action_id'];
		if (actionId === APPROVE_ACTION_ID) return { decision: 'approve', value: entry['value'] };
		if (actionId === REJECT_ACTION_ID) return { decision: 'reject', value: entry['value'] };
	}
	return null;
}

function extractPayloadField(rawBody: string): string | null {
	// Parse as a form body without assuming field order; only `payload` matters.
	let params: URLSearchParams;
	try {
		params = new URLSearchParams(rawBody);
	} catch {
		return null;
	}
	const payload = params.get('payload');
	return payload === null || payload === '' ? null : payload;
}

function readShortString(value: unknown, maxLength: number): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (trimmed === '' || trimmed.length > maxLength) return null;
	return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
