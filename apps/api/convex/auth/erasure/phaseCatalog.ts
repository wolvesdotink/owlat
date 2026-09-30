import { literalUnion } from '../../lib/literalUnion';

/**
 * The ordered steps of one member's erasure. Persisted on the erasure job as
 * its resume point, so the list only ever grows: renaming or removing a phase
 * would strand a job saved mid-walk.
 *
 * The identity goes first, so nothing can sign in or act as the member while
 * the rest is erased. Then the rows outside any workspace (instance level).
 * Everything from `externalAccounts` on lives in workspace tables; while a
 * workspace deletion is sweeping those, the job waits for it (see
 * `WORKSPACE_PHASES_FROM`). Within the personal mailboxes, writers are stopped
 * before their data goes, and children go before the rows they hang off.
 */
export const MEMBER_ERASURE_PHASES = [
	'authSessions',
	'authCredentials',
	'authOAuthGrants',
	'authVerifications',
	'authInvitations',
	'instanceRows',
	'externalAccounts',
	'mailboxQuiesce',
	'mailboxMessages',
	'mailboxThreads',
	'mailboxDrafts',
	'mailboxShares',
	'mailboxRecords',
	'mailboxRows',
	'memberRecords',
	'sharedMemberships',
	'assistant',
	'accountExports',
	'alertRecipients',
	'alertReceipts',
	'chatAuthorship',
	'chatMemberships',
	'chatMentions',
] as const;

export type MemberErasurePhase = (typeof MEMBER_ERASURE_PHASES)[number];

/** The first phase that touches tables a workspace deletion sweeps. */
export const WORKSPACE_PHASES_FROM: MemberErasurePhase = 'externalAccounts';

export const memberErasurePhaseValidator = literalUnion(MEMBER_ERASURE_PHASES);
