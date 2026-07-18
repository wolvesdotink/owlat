/**
 * Slack approvals — a Tier-2 reference connected app.
 *
 * It serves Owlat's signed synchronous `gate` hook with a RESTRICT-ONLY hold:
 * the first time Owlat asks about a draft it posts the draft to a Slack channel
 * with Approve / Reject buttons and objects (holds); it stops objecting only
 * once a real human quorum approves inside the window. Slack button clicks are
 * authenticated Slack callbacks (signature + freshness), deduplicated per voter,
 * and bounded by an expiry. Nothing this app can return will approve, unblock,
 * or send — the strongest verdict it produces is `no-objection`, which still
 * leaves Owlat's own gates in force.
 *
 * This barrel is the app's public surface; the wire is HTTP + the signed-hook
 * protocol, so the modules are runtime-neutral and individually testable.
 */

export {
	createApprovalRequest,
	evaluateApproval,
	recordVote,
	approvalCount,
	hasRejection,
	type ApprovalRequest,
	type ApprovalState,
	type ApprovalVote,
	type CreateApprovalInput,
	type RecordVoteResult,
	type Vote,
	type VoteRejectionReason,
} from './approvalStore';

export { createInMemoryApprovalRepository, type ApprovalRepository } from './approvalRepository';

export {
	verifySlackSignature,
	signSlackRequest,
	SLACK_SIGNATURE_TOLERANCE_SECONDS,
	type SlackSignatureInput,
	type SlackSignatureResult,
	type SlackSignatureFailure,
} from './slackSignature';

export {
	handleSlackCallback,
	parseSlackInteraction,
	SLACK_APPROVE_ACTION_ID,
	SLACK_REJECT_ACTION_ID,
	type SlackCallbackInput,
	type SlackCallbackResult,
} from './slackCallback';

export {
	verifyOwlatHookRequest,
	signOwlatHookResponse,
	createNonceGuard,
	OWLAT_HOOK_HEADERS,
	OWLAT_HOOK_PROTOCOL_VERSION,
	OWLAT_HOOK_REQUEST_TOLERANCE_SECONDS,
	OWLAT_HOOK_KINDS,
	type OwlatHookKind,
	type NonceGuard,
	type VerifyHookRequestInput,
	type VerifyHookRequestResult,
	type VerifiedHookRequest,
	type HookRequestFailure,
	type SignedHookResponse,
} from './hookWire';

export {
	evaluateGate,
	serveGateHook,
	type SlackApprovalsGateConfig,
	type EvaluateGateInput,
	type ServeGateHookInput,
	type GateHookHttpResponse,
} from './gateHandler';

export {
	buildApprovalMessage,
	createSlackNotifier,
	type ApprovalNotifier,
	type SlackMessage,
	type SlackPostMessage,
	type SlackNotifierConfig,
} from './notify';

export { slackApprovalsPlugin, SLACK_APPROVALS_PLUGIN_ID } from './manifest';
