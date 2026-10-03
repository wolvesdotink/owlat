import { literalUnion } from '../../lib/literalUnion';

/**
 * The ordered steps of one contact's erasure. Persisted on the erasure job as
 * its resume point, so the list only ever grows: renaming or removing a phase
 * would strand a job saved mid-walk. Children come before the rows they hang
 * off, and the contact row itself is removed after the last phase.
 */
export const CONTACT_ERASURE_PHASES = [
	'clarificationMemory',
	'contactTopics',
	'contactPropertyValues',
	'contactActivities',
	// Bounces and complaints that matched no Send (#1194). Before the identities,
	// because a row can name any of the contact's email addresses. Inserting a
	// phase strands nothing: a saved job resumes by name, and the walker's final
	// re-check runs every deleting phase again.
	'unresolvedFeedback',
	'contactIdentities',
	'relationshipsFrom',
	'relationshipsTo',
	'automationRuns',
	'emailSends',
	'transactionalSends',
	'conversationThreads',
	'unifiedMessages',
	'inboundMessages',
	'formSubmissions',
	'knowledge',
	'semanticFiles',
	'answerAskSessions',
] as const;

export type ContactErasurePhase = (typeof CONTACT_ERASURE_PHASES)[number];

export const contactErasurePhaseValidator = literalUnion(CONTACT_ERASURE_PHASES);
