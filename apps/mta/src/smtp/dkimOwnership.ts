/**
 * Which organization may sign with a domain's DKIM keys. Shared by the RSA
 * lookup (`./dkim.ts`) and the optional Ed25519 lookup (`./dkimEd25519.ts`):
 * both keys live in one hash and carry one owner.
 */

import type { DkimKeyConfig } from '../types.js';

/**
 * H2 cross-tenant guard: when the stored key is bound to an owning organization
 * (`organizationId`), it may ONLY sign for a job from that same organization.
 * A job from a different tenant is refused the key and ships UNSIGNED rather than
 * being signed under another tenant's DKIM identity — so an org can never spoof
 * a domain it does not own with a signature that authenticates as that domain.
 * Legacy/env-seeded keys with no recorded owner stay usable by any org for
 * backward compatibility until they are re-registered with an owner.
 *
 * Master-key-only sentinel orgs (`postbox`, `system`) are EXEMPT from the
 * ownership refusal: these ids are only reachable with the master credential
 * (`/send/postbox` and `/send/system` require `isMasterKey`, and `/send` rejects
 * `organizationId: 'postbox'` — see routes/send.ts), so a tenant can never
 * present them. In-app Postbox dispatch sends `organizationId: 'postbox'` with
 * the mailbox's own domain as `dkimDomain`; once that domain is re-registered
 * with its real owning org, refusing the sentinel would strip DKIM from every
 * personal message. Exempting the sentinels keeps that primary send path signed
 * while still blocking real cross-tenant spoofing.
 */
const MASTER_KEY_ONLY_SENTINEL_ORGS = new Set(['postbox', 'system']);

export function isForeignTenantKey(
	key: DkimKeyConfig,
	organizationId: string | undefined
): boolean {
	return Boolean(
		key.organizationId &&
		organizationId &&
		key.organizationId !== organizationId &&
		!MASTER_KEY_ONLY_SENTINEL_ORGS.has(organizationId)
	);
}
