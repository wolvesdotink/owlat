/**
 * Team-page role and mailbox-status presentation helpers
 * (settings/team.vue).
 *
 * The role copy is surfaced at the point of choice — under each option in the
 * role menu and in the invite modal — so an admin never has to guess what a role
 * grants. Every line here is kept HONEST to the current permission map in
 * apps/api/convex/lib/sessionOrganization.ts (PERMISSION_MAP): admins can do
 * everything except delete the organization; editors run the campaign pipeline
 * (create, edit, schedule, and send campaigns from the curated sender list) but
 * cannot curate senders, manage contacts, or change settings. When the
 * permission map changes, this copy must change with it.
 */

import type { FunctionReturnType } from 'convex/server';
import { api } from '@owlat/api';
import type { OrganizationRole } from '~/composables/useOrganization';

export interface RoleDefinition {
	role: OrganizationRole;
	label: string;
	icon: string;
	/** One-line summary shown as the primary description. */
	summary: string;
	/** Second line — the concrete boundary of the role. */
	detail: string;
	/** Design-token badge tone for the role chip (owner/admin share the brand
	 * accent; editor is neutral). No hardcoded colors — token classes only. */
	badgeToneClass: string;
}

const BRAND_BADGE = 'bg-brand/20 text-brand border-brand/30';
const NEUTRAL_BADGE = 'bg-bg-surface text-text-secondary border-border-subtle';

/**
 * Role descriptions in privilege order (owner → admin → editor). Two lines each
 * so the meaning is legible at the point of choice. Honest to PERMISSION_MAP:
 *  - owner  = admin powers + delete the organization + transfer ownership.
 *  - admin  = send campaigns, manage contacts/settings, invite members; cannot
 *             delete the organization.
 *  - editor = build and send campaigns from the curated sender list; view
 *             contacts; send test emails and join team chat. Cannot curate
 *             campaign senders, manage contacts, or change settings.
 */
export const ROLE_DEFINITIONS: readonly RoleDefinition[] = [
	{
		role: 'owner',
		label: 'Owner',
		icon: 'lucide:crown',
		summary: 'Full control of the workspace.',
		detail: 'Everything an admin can do, plus transferring ownership and deleting the workspace.',
		badgeToneClass: BRAND_BADGE,
	},
	{
		role: 'admin',
		label: 'Admin',
		icon: 'lucide:shield',
		summary: 'Runs the workspace day to day.',
		detail:
			'Send campaigns, manage contacts and settings, and invite members. Cannot delete the workspace.',
		badgeToneClass: BRAND_BADGE,
	},
	{
		role: 'editor',
		label: 'Editor',
		icon: 'lucide:user',
		summary: 'Builds and sends campaigns.',
		detail:
			'Create, edit, schedule, and send campaigns from the curated sender list. View contacts, send test emails, and join team chat. Cannot curate senders, manage contacts, or change settings.',
		badgeToneClass: NEUTRAL_BADGE,
	},
];

const ROLE_BY_KEY = Object.fromEntries(ROLE_DEFINITIONS.map((def) => [def.role, def])) as Record<
	OrganizationRole,
	RoleDefinition
>;

/** Look up a single role's definition, falling back to the editor floor for any
 * unexpected value so the UI never renders a blank label. */
export function roleDefinition(role: string): RoleDefinition {
	return ROLE_BY_KEY[role as OrganizationRole] ?? ROLE_BY_KEY.editor;
}

/** Derived from the backend query so a schema change can't silently diverge
 * (the query returns a record keyed by user id). */
export type MemberMailboxStatus = FunctionReturnType<
	typeof api.mail.memberMailboxStatus.byMembers
>[string];

export interface MailboxStatusMeta {
	/** Human label for the Mailbox column (no enum strings in the UI). */
	label: string;
	icon: string;
	/** Design-token text tone class for the status. */
	toneClass: string;
	/** Longer explanation for the cell's title/aria. */
	description: string;
}

/**
 * Map a member's mailbox status to a presentable cell. Uses the shared design
 * tokens (no hardcoded colors) so it renders correctly in both themes. An
 * unknown/absent status is treated as 'none' — the safe, non-alarming default.
 */
export function mailboxStatusMeta(
	status: MemberMailboxStatus | undefined | null
): MailboxStatusMeta {
	if (status === 'hosted') {
		return {
			label: 'Hosted',
			icon: 'lucide:inbox',
			toneClass: 'text-text-primary',
			description: 'Has an Owlat-hosted mailbox on this workspace.',
		};
	}
	if (status === 'external') {
		return {
			label: 'External',
			icon: 'lucide:link',
			toneClass: 'text-text-secondary',
			description: 'Uses a connected external mailbox (IMAP/SMTP).',
		};
	}
	return {
		label: 'No mailbox',
		icon: 'lucide:minus',
		toneClass: 'text-text-tertiary',
		description: 'No personal mailbox yet.',
	};
}
