/**
 * Drafting emails with AI: the feature floor, the per-kind gate and the
 * request validators shared by the context read, the commit and the action.
 *
 * `ai.emailGeneration` requires `ai`, so the resolved flag is off whenever
 * `ai` is. Each kind adds the floor of the thing it creates, at today's
 * permission, never wider: a template or transactional email needs
 * `templates:manage`; a campaign needs `campaigns:manage` and, because it
 * creates its email too, `templates:manage`. Transactional drafting needs the
 * `transactional` flag and campaign drafting the `campaigns` flag.
 *
 * Not a Convex module (the leading underscore keeps it off the API surface).
 */

import { v } from 'convex/values';
import type { FeatureFlagKey } from '@owlat/shared/featureFlags';
import { authedQuery, featureGated } from '../lib/authedFunctions';
import { hasPermission, type OrganizationRole, type Permission } from '../lib/sessionOrganization';
import { throwFeatureDisabled } from '../lib/featureFlags';
import { throwForbidden } from '../_utils/errors';
import type { GenerationKind } from './blocksDecision';

export const emailGenerationQuery = featureGated(authedQuery, 'ai.emailGeneration');

export const generationKindValidator = v.union(
	v.literal('template'),
	v.literal('transactional'),
	v.literal('campaign')
);

/** An existing email the user picked to base the draft on. */
export const referenceValidator = v.union(
	v.object({ kind: v.literal('template'), id: v.id('emailTemplates') }),
	v.object({ kind: v.literal('transactional'), id: v.id('transactionalEmails') }),
	v.object({ kind: v.literal('campaign'), id: v.id('campaigns') })
);

export type GenerationRefusal =
	| { kind: 'feature'; flag: FeatureFlagKey }
	| { kind: 'permission'; permission: Permission };

const KIND_FLAGS: Record<GenerationKind, readonly FeatureFlagKey[]> = {
	template: ['ai.emailGeneration'],
	transactional: ['ai.emailGeneration', 'transactional'],
	campaign: ['ai.emailGeneration', 'campaigns'],
};

const KIND_PERMISSIONS: Record<GenerationKind, readonly Permission[]> = {
	template: ['templates:manage'],
	transactional: ['templates:manage'],
	campaign: ['campaigns:manage', 'templates:manage'],
};

/** Why this caller may not draft this kind, or null. Flags first: a missing feature is not a permission problem. */
export function generationRefusal(
	kind: GenerationKind,
	flags: Readonly<Record<string, boolean>>,
	role: OrganizationRole | null
): GenerationRefusal | null {
	for (const flag of KIND_FLAGS[kind]) {
		if (flags[flag] !== true) return { kind: 'feature', flag };
	}
	for (const permission of KIND_PERMISSIONS[kind]) {
		if (!hasPermission(role, permission)) return { kind: 'permission', permission };
	}
	return null;
}

/** The flag a picked reference's own surface needs. */
export const REFERENCE_FLAGS: Record<
	'template' | 'transactional' | 'campaign',
	FeatureFlagKey | null
> = { template: null, transactional: 'transactional', campaign: 'campaigns' };

export function throwGenerationRefusal(refusal: GenerationRefusal): never {
	if (refusal.kind === 'feature') throwFeatureDisabled(refusal.flag);
	throwForbidden('You do not have permission to create this draft', {
		code: 'EMAIL_GENERATION_FORBIDDEN',
		permission: refusal.permission,
	});
}
