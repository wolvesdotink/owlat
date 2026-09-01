/**
 * The QUICK-CREATE registry: what this app can create, in what order, and the
 * gate each verb is registered behind.
 *
 * Creation used to be a property of whichever page you happened to be standing
 * on — the composer lived in the Postbox, "Add contact" lived on the contacts
 * list, and a new campaign lived three clicks into Marketing. So the answer to
 * "make something" depended on where you already were, and on a phone there was
 * no answer at all. This table is the one place that knows the verbs, so the
 * header split-button, the mobile create sheet and (eventually) the palette's
 * create group all offer the same list under the same rules.
 *
 * Pure data plus pure gate predicates — no Vue, no Nuxt, no Convex — reading the
 * SAME `NavigationEnvironment` the sidebar table does, so "can this person see
 * it" and "can this person make it" cannot drift. `useQuickCreateMenu` supplies
 * the environment and turns each entry into something runnable.
 *
 * The gates are the permission facts, not a guess at them: creating a contact is
 * `canManageContacts` (admin) in `usePermissions`, so an editor is not offered a
 * verb whose destination would refuse to open its Add dialog. Campaigns are
 * editor work (`canSendCampaigns`), so that one is flag-gated only.
 */
import type { FeatureFlagKey } from '@owlat/shared/featureFlags';
import { minRole, type NavigationEnvironment } from './dashboardNavigationCore';

export type QuickCreateId = 'compose' | 'campaign' | 'contact' | 'automation';

type Gate = (env: NavigationEnvironment) => boolean;

const flag =
	(key: FeatureFlagKey): Gate =>
	(env) =>
		env.isFeatureEnabled(key);
const anyFlag =
	(...keys: readonly FeatureFlagKey[]): Gate =>
	(env) =>
		keys.some((key) => env.isFeatureEnabled(key));
const adminOnly = minRole('admin');

export interface QuickCreateEntry {
	readonly id: QuickCreateId;
	/** i18n KEY — this module is module scope and cannot call `useI18n`. */
	readonly labelKey: string;
	readonly icon: string;
	/**
	 * Where the verb lives when it is a PAGE. The two that are not (compose opens
	 * a composer, contact opens a dialog on the list it already has) carry no
	 * href and are run through `useQuickCreate` instead.
	 */
	readonly href?: string;
	/** Catalog id (`utils/shortcutCatalog.ts`) of the chord that also runs it. */
	readonly shortcutId?: string;
	readonly gate: Gate;
}

/** The create verbs, in the order every surface offers them. */
export const QUICK_CREATE_ENTRIES: readonly QuickCreateEntry[] = [
	{
		id: 'compose',
		labelKey: 'shared.quickCreate.compose',
		icon: 'lucide:pencil',
		shortcutId: 'global.compose',
		gate: anyFlag('postbox', 'mail.external'),
	},
	{
		id: 'campaign',
		labelKey: 'shared.quickCreate.campaign',
		icon: 'lucide:megaphone',
		href: '/dashboard/campaigns/new',
		gate: flag('campaigns'),
	},
	{
		id: 'contact',
		labelKey: 'shared.quickCreate.contact',
		icon: 'lucide:user-plus',
		gate: adminOnly,
	},
	{
		id: 'automation',
		labelKey: 'shared.quickCreate.automation',
		icon: 'lucide:zap',
		href: '/dashboard/automations/new',
		gate: (env) => adminOnly(env) && flag('automations')(env),
	},
];

/** The verbs this member may actually run, in catalog order. */
export function quickCreateEntriesFor(env: NavigationEnvironment): QuickCreateEntry[] {
	return QUICK_CREATE_ENTRIES.filter((entry) => entry.gate(env));
}

/**
 * The verb a split button's primary half performs: the first one that survived
 * the gates, so an instance with no mail still gets a working create button
 * rather than a dead one labelled "Compose". `null` when nothing survived —
 * which is a member with no create rights at all, and the button is not drawn.
 */
export function defaultQuickCreateEntry(env: NavigationEnvironment): QuickCreateEntry | null {
	return quickCreateEntriesFor(env)[0] ?? null;
}
