import { v } from 'convex/values';

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
] as const;

export type ContactErasurePhase = (typeof CONTACT_ERASURE_PHASES)[number];

export const contactErasurePhaseValidator = v.union(
	...CONTACT_ERASURE_PHASES.map((phase) => v.literal(phase))
);
