/**
 * The organization RBAC vocabulary — roles, the typed permission union, and the
 * role→permission map — in the one place both sides of the wire can read.
 *
 * This lived in `apps/api/convex/lib/sessionOrganization.ts` alone, which the
 * web app cannot import (Convex server types). The web app therefore
 * hand-mirrored the map in `usePermissions()` and drifted: it covered five of
 * the nineteen permissions, so editors were shown create/edit actions on
 * segments, topics, automations, templates, media, imports and share links that
 * the backend then refused with a forbidden toast. A permission added on one
 * side and forgotten on the other is exactly that class of bug, so the map is
 * defined here once and consumed by both.
 *
 * Pure module: no Convex, no Nuxt, no I/O.
 */

/**
 * Organization role — matches BetterAuth's custom roles for this deployment.
 * Uses 'editor' where BetterAuth's default vocabulary says 'member'; the
 * translation between the two lives in the web app's `useOrganization()`.
 */
export type OrganizationRole = 'owner' | 'admin' | 'editor';

export type Permission =
	// Marketing send pipeline
	| 'campaigns:send'
	| 'campaigns:manage'
	| 'campaigns:schedule'
	// Content authoring
	| 'templates:manage'
	| 'automations:manage'
	| 'topics:manage'
	| 'segments:manage'
	| 'media:manage'
	| 'shareLinks:manage'
	| 'imports:manage'
	// CRM
	| 'contacts:manage'
	| 'contacts:annotate'
	// Org + admin
	| 'organization:manage'
	| 'settings:manage'
	| 'organization:delete'
	// Self-service
	| 'emails:test'
	// Read the org knowledge graph (any member) — quick-query / agent context
	| 'knowledge:read'
	// Internal team chat
	| 'chat:participate'
	| 'chat:manage';

const isAdmin = (role: OrganizationRole) => role === 'owner' || role === 'admin';
const isOwner = (role: OrganizationRole) => role === 'owner';
// Any org member (owner, admin, or editor). Editors run the marketing send
// pipeline end-to-end now that the campaign-sender guardrail exists (2026-07-10
// experience plan, decision 8): they may create/edit/schedule/send campaigns,
// but only from the curated `campaignSenders` list (or, if an admin has enabled
// the custom-senders toggle, any verified sending domain). Curating that list
// and flipping the toggle stay admin-only — see `campaigns/senders.ts`.
const isEditorOrAbove = (role: OrganizationRole) =>
	role === 'owner' || role === 'admin' || role === 'editor';

/**
 * The role→permission map. `Record<Permission, …>` makes tsc reject a
 * permission added to the union without a rule here; `hasPermission` is the
 * only way callers should read it.
 */
const PERMISSION_MAP: Record<Permission, (role: OrganizationRole) => boolean> = {
	'campaigns:send': isEditorOrAbove,
	'campaigns:manage': isEditorOrAbove,
	'campaigns:schedule': isEditorOrAbove,
	'templates:manage': isAdmin,
	'automations:manage': isAdmin,
	'topics:manage': isAdmin,
	'segments:manage': isAdmin,
	'media:manage': isAdmin,
	'shareLinks:manage': isAdmin,
	'imports:manage': isAdmin,
	'contacts:manage': isAdmin,
	'contacts:annotate': isEditorOrAbove,
	'organization:manage': isAdmin,
	'settings:manage': isAdmin,
	'organization:delete': isOwner,
	'emails:test': () => true,
	'knowledge:read': () => true,
	'chat:participate': () => true,
	'chat:manage': isAdmin,
};

/**
 * Whether a role carries a permission.
 *
 * A `null`/`undefined` role means "not a member of this organization, or the
 * role has not resolved yet" and carries nothing — the web app relies on that
 * to render un-flashed loading states.
 */
export function hasPermission(
	role: OrganizationRole | null | undefined,
	permission: Permission
): boolean {
	if (!role) return false;
	return PERMISSION_MAP[permission](role);
}
