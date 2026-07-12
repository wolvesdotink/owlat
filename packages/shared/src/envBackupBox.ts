/**
 * Sealing for credential values in the `.env` BACKUP copy (secrets at rest).
 *
 * NODE-ONLY: uses `node:crypto` (via `@owlat/shared/secretBox`). Exposed via the
 * `@owlat/shared/envBackupBox` subpath ONLY — it must never be re-exported from
 * the `.` barrel, which has to stay browser-safe.
 *
 * Why this exists: the LIVE source for transport credentials is the Convex
 * deployment's env store (already encrypted; written by `apply-transport` /
 * setup via `pushConvexRuntimeEnv` or `convex env set`). The `.env` file on
 * disk is only the BACKUP copy that survives a container recreate — but it held
 * the SMTP relay password in plaintext, so a filesystem/backup dump leaked it.
 * This box seals that backup copy while the live store keeps working plaintext.
 *
 * It is a thin binding of the shared `createSecretBox` primitive
 * (`@owlat/shared/secretBox`): the SAME AES-256-GCM + HKDF-SHA256 core, pinned to
 * an env-backup domain-separation context. The box is keyed by INSTANCE_SECRET
 * (present in every install's `.env`; the same secret the Convex external-mail
 * box derives from) under HKDF context labels DISTINCT from every other consumer
 * (external-mail creds, MTA transport secrets, keyVault), so a value sealed here
 * can never open under another box — and vice versa.
 *
 * Sealed tokens are self-describing via {@link ENV_BACKUP_SEALED_PREFIX}, so a
 * reader (the deploy-time reseed in `selectRuntimeEnvVars`) can distinguish a
 * sealed value from a legacy plaintext one: plaintext passes through untouched
 * (legacy `.env` files keep deploying fine), sealed tokens are unsealed before
 * being pushed to the live deployment env store, and a tampered/unopenable
 * token FAILS CLOSED — ciphertext is never pushed as a live credential.
 */

import { createSecretBox, type SecretBox } from './secretBox';

/**
 * The HKDF domain-separation context for the `.env`-backup box. Changing either
 * label is a KDF change that would strand every value already sealed under the
 * old labels — bump the `:v1` suffix and add a re-seal migration.
 */
const ENV_BACKUP_SALT = 'owlat:env-backup:salt:v1';
const ENV_BACKUP_INFO = 'owlat:env-backup:values:v1';

/**
 * The prefix every sealed `.env`-backup value carries. It lets the deploy-time
 * reseed distinguish a sealed token from a plain value (legacy `.env` files),
 * and makes sealed values recognizable to an operator reading the file. The
 * `:v1:` marks the envelope layout.
 */
export const ENV_BACKUP_SEALED_PREFIX = 'envsealed:v1:';

/** Whether a stored `.env` value is a sealed token produced by {@link EnvBackupBox.seal}. */
export function isEnvBackupSealedValue(value: string): boolean {
	return value.startsWith(ENV_BACKUP_SEALED_PREFIX);
}

/** An AES-256-GCM + HKDF-SHA256 sealing box for `.env`-backup values. */
export type EnvBackupBox = SecretBox;

/**
 * Build the `.env`-backup box keyed by `instanceSecret` under the pinned
 * env-backup context. Pure crypto — reads no env — so callers pass the
 * INSTANCE_SECRET they already hold (it lives in the same `.env` map).
 *
 * @throws Error when `instanceSecret` is empty — sealing under an absent key
 * would produce tokens nothing can ever open.
 */
export function createEnvBackupBox(instanceSecret: string): EnvBackupBox {
	if (!instanceSecret) {
		throw new Error('createEnvBackupBox: INSTANCE_SECRET is required to seal/unseal .env values.');
	}
	return createSecretBox(instanceSecret, {
		salt: ENV_BACKUP_SALT,
		info: ENV_BACKUP_INFO,
		prefix: ENV_BACKUP_SEALED_PREFIX,
	});
}

/**
 * Return a copy of an `.env` map with `SMTP_RELAY_PASSWORD` sealed for at-rest
 * backup — the single helper every `.env` WRITER funnels the relay credential
 * through so the file never persists it in plaintext (the card's acceptance
 * reads on the file, and it has several writers: the web setup wizard, the
 * transport editor, and the CLI setup/quickstart paths).
 *
 * The LIVE deployment env store is untouched: callers push plaintext (or a
 * sealed token that `selectRuntimeEnvVars` unseals) BEFORE writing this backup,
 * so the send path always reads the working credential.
 *
 * Fails SAFE, never wrong:
 *   - no password, or no INSTANCE_SECRET in the same map ⇒ pass through
 *     unchanged (a bare dev `.env` keeps today's plaintext write rather than
 *     minting a token nothing could ever open);
 *   - the value is ALREADY a sealed token ⇒ pass through unchanged (idempotent,
 *     so re-running setup over a sealed `.env` never double-seals).
 */
export function sealRelayPasswordForBackup(env: Record<string, string>): Record<string, string> {
	const password = env['SMTP_RELAY_PASSWORD'];
	const instanceSecret = env['INSTANCE_SECRET'];
	if (!password || !instanceSecret || isEnvBackupSealedValue(password)) return env;
	return {
		...env,
		SMTP_RELAY_PASSWORD: createEnvBackupBox(instanceSecret).seal(password),
	};
}
