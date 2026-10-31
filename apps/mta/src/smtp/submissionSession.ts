/**
 * The per-connection state the submission hooks share: the AUTH hook
 * (submissionAuth.ts) writes the authenticated identity, the DATA hook
 * (submissionData.ts) reads it back, and the listener (submissionServer.ts)
 * wires both.
 */

import type { SmtpSession } from '@owlat/smtp-listener';
import type { Queue } from 'groupmq';
import type Redis from 'ioredis';
import type { EmailJob } from '../types.js';
import type { MtaConfig } from '../config.js';

/** The authenticated identity of a submission session. */
export interface AuthenticatedSession {
	organizationId: string;
	credentialName: string;
	/**
	 * The organization's verified sending domains (lowercased) for a per-org
	 * credential session. When present, the DATA hook rejects a From whose domain
	 * is not in this set (H2 cross-tenant From-forgery guard). Absent for the
	 * master session (broad send) and for legacy credentials created before the
	 * field existed — see {@link OrgCredential.allowedDomains}.
	 */
	allowedDomains?: readonly string[];
	/** Set when authenticated via a Postbox app password (per-user). */
	postbox?: {
		mailboxId: string;
		mailboxAddress: string;
		appPasswordId: string;
		userId: string;
	};
}

/**
 * Typed per-connection listener state. Replaces the old `sessionAuth` WeakMap:
 * the `authenticate` hook writes {@link SubmissionSessionState.auth} on success
 * and the DATA hook reads it back — no side table, no forgeable posture.
 */
export interface SubmissionSessionState {
	auth?: AuthenticatedSession;
}

/** A submission listener session, carrying {@link SubmissionSessionState}. */
export type SubmissionSession = SmtpSession<SubmissionSessionState>;

/** Dependencies for the exported handler factories (DI for tests). */
export interface SubmissionDeps {
	queue: Queue<EmailJob>;
	redis: Redis;
	config: MtaConfig;
}
