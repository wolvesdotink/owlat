/**
 * Redis key names for the MTA suppression list.
 *
 * Their own module because two siblings write them: `suppressionList.ts` owns
 * membership and metadata, `suppressionExpiry.ts` owns the due-date index and
 * the reclaim that reads all three. A key name that drifted between the two
 * would be a suppression that silently stopped being enforced, so neither file
 * spells one out. Same reason `warmingKeys.ts` exists beside `warming*.ts`.
 */

export const SUPPRESSION_SET = 'mta:suppressed';
export const SUPPRESSION_META_PREFIX = 'mta:suppressed-meta:';
/**
 * Due-date index for TEMPORARY suppressions only: member = normalized address,
 * score = `expiresAt` in epoch ms. A permanent suppression (hard bounce,
 * complaint) is never a member, which is what keeps the sweep in
 * `suppressionExpiry.ts` incapable of dropping one.
 */
export const SUPPRESSION_EXPIRY_ZSET = 'mta:suppressed-expiring';
