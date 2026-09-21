/**
 * The OSTR (Open Sender Trust Registry) tier persisted at delivery on
 * `mailMessages.ostrTier` — the registry's read on the sender's standing, a
 * SEPARATE signal from the SPF/DKIM/DMARC verdicts above. Authentication says
 * whether the sender is who it claims to be; a tier says what the registry has
 * observed about that sender's behaviour. Both can be rendered, and they can
 * legitimately disagree (a properly authenticated domain can be `flagged`).
 */
export interface OstrChip {
	/** Short chip label — a catalog key. */
	labelKey: string;
	/** Expanded-view explanation — a catalog key. */
	detailKey: string;
	tone: 'neutral' | 'ok' | 'warn' | 'danger';
}

/**
 * The four tiers worth a chip, and how loud each one is. `unknown` is
 * deliberately absent: it is the registry saying it has no evidence, which is
 * not information a reader should have to parse — same fail-closed rule the
 * auth badge follows for a legacy row.
 *
 * `establishing` is `neutral`, NOT `ok`: the two differ exactly on strength of
 * evidence — good hygiene over a short, low-volume history versus a sustained
 * clean one seen by several independent observers — and the cardinal rule of
 * this module is that nothing may claim more than what was observed. Painting
 * both green would hand a brand-new sender the same reassurance a long-standing
 * one earned, at a glance, with only the collapsed detail line telling them
 * apart.
 *
 * A Map rather than an object literal so a lookup can only ever hit a tier we
 * put here: `OSTR_TIER_TONES['constructor']` on an object literal answers with
 * an inherited value and would mint a chip whose label key has no copy.
 */
const OSTR_TIER_TONES = new Map<string, OstrChip['tone']>([
	['establishing', 'neutral'],
	['trusted', 'ok'],
	['warned', 'warn'],
	['flagged', 'danger'],
]);

/**
 * Derive the optional OSTR tier chip. Returns null for an absent tier (a legacy
 * row, or an instance with no registry consumer configured), for `unknown`, and
 * for any tier string this build does not know — never a chip that claims more
 * than the registry said. Pure, keys only, like everything else in this module.
 */
export function deriveOstrChip(tier: string | undefined): OstrChip | null {
	const normalized = tier?.trim().toLowerCase() ?? '';
	const tone = OSTR_TIER_TONES.get(normalized);
	if (!tone) return null;
	return {
		labelKey: `shared.ostr.tier.${normalized}.label`,
		detailKey: `shared.ostr.tier.${normalized}.detail`,
		tone,
	};
}
