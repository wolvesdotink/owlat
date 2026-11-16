/**
 * Whether a viewer is offered AI drafting, decided where the entry point
 * renders. The template library, "New transactional email" and the
 * new-campaign flow import this statically, so it stays a leaf: types only,
 * no backend reference, nothing of the generator itself. The generator
 * (`components/ai/EmailGeneratePanel.vue` and everything it pulls in) loads
 * only when an author opens it; see `components/ai/EmailGenerateLoader.vue`.
 *
 * The backend (`apps/api/convex/emailGeneration/`) is the authority on every
 * gate; this only decides what to show so nobody is offered a door that
 * refuses them.
 */
import type { FeatureFlagKey } from '@owlat/shared/featureFlags';
import type { Permission } from '@owlat/shared/organizationPermissions';

export type GenerationKind = 'template' | 'transactional' | 'campaign';

const KIND_FLAGS: Record<GenerationKind, readonly FeatureFlagKey[]> = {
	template: [],
	transactional: ['transactional'],
	campaign: ['campaigns'],
};

const KIND_PERMISSIONS: Record<GenerationKind, readonly Permission[]> = {
	template: ['templates:manage'],
	transactional: ['templates:manage'],
	campaign: ['campaigns:manage', 'templates:manage'],
};

/**
 * What an entry point shows: the generator, a one-line pointer to the
 * Features page for an admin who could turn it on, or nothing. An editor
 * who could not use it sees nothing at all, never a disabled teaser.
 */
export function generationEntry(
	kind: GenerationKind,
	env: {
		isFeatureEnabled: (flag: FeatureFlagKey) => boolean;
		can: (permission: Permission) => boolean;
	}
): 'show' | 'enable_hint' | 'hidden' {
	if (KIND_FLAGS[kind].some((flag) => !env.isFeatureEnabled(flag))) return 'hidden';
	if (KIND_PERMISSIONS[kind].some((permission) => !env.can(permission))) return 'hidden';
	if (env.isFeatureEnabled('ai.emailGeneration')) return 'show';
	return env.can('settings:manage') ? 'enable_hint' : 'hidden';
}

let panelChunk: Promise<void> | null = null;

/**
 * Start downloading the generator before it is opened, from a hovered or
 * focused entry point, so the loader's placeholder rarely shows. One request
 * however often it is called; a failed load is forgotten so the next call
 * tries again, and the lazy mount itself still surfaces the error.
 */
export function warmEmailGeneratePanel(): Promise<void> {
	if (import.meta.server) return Promise.resolve();
	panelChunk ??= import('~/components/ai/EmailGeneratePanel.vue').then(
		() => undefined,
		() => {
			panelChunk = null;
		}
	);
	return panelChunk;
}
