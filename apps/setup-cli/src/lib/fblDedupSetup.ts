import type { EnvMap } from './env';

const FBL_DEDUP_PROTOCOL = 'owned-v2';
const FBL_DEDUP_FRESH_INSTALL_ACK = 'fresh-install';
const FBL_DEDUP_QUIESCED_CUTOVER_ACK = 'quiesced-v1-intake';

/** Add owned-v2 only when the setup caller has proved this is a fresh install. */
export function applyFreshFblDedupDefaults(defaults: EnvMap): void {
	defaults['FBL_DEDUP_PROTOCOL'] = FBL_DEDUP_PROTOCOL;
	defaults['FBL_DEDUP_CUTOVER_ACK'] = FBL_DEDUP_FRESH_INSTALL_ACK;
}

/**
 * Refuse to turn an existing installation into an owned-v2 fleet implicitly.
 * The operator writes the acknowledgement only after legacy FBL intake has
 * been quiesced and every in-flight handler has drained.
 */
export function assertFblDedupCutoverConfigured(existingEnv: EnvMap): void {
	if (existingEnv['FBL_DEDUP_PROTOCOL'] !== FBL_DEDUP_PROTOCOL) {
		throw new Error(
			'Existing install requires an explicit FBL cutover: quiesce legacy bounce/FBL intake, drain in-flight handlers, then set FBL_DEDUP_PROTOCOL=owned-v2 and FBL_DEDUP_CUTOVER_ACK=quiesced-v1-intake before re-running setup.'
		);
	}
	const acknowledgement = existingEnv['FBL_DEDUP_CUTOVER_ACK'];
	if (
		acknowledgement !== FBL_DEDUP_FRESH_INSTALL_ACK &&
		acknowledgement !== FBL_DEDUP_QUIESCED_CUTOVER_ACK
	) {
		throw new Error(
			'Existing install requires FBL_DEDUP_CUTOVER_ACK=quiesced-v1-intake after legacy bounce/FBL intake is quiesced and drained.'
		);
	}
}
