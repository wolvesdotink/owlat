/**
 * Postbox app-password verification client.
 *
 * Calls the HMAC-signed Convex endpoint at /webhooks/mta-verify-credential
 * to verify a (mailbox-address, app-password) pair against the
 * mailAppPasswords table. Used by the SMTP submission server to
 * authenticate per-user clients (Apple Mail, Thunderbird, …).
 */

import { signMtaRequest } from '@owlat/mta-protocol/signer';
import { normalizePeerIp } from '@owlat/shared/ipAddress';
import { isRecord } from '@owlat/shared/utils/guards';
import type { MtaConfig } from '../config.js';
import { logger } from '../monitoring/logger.js';

export interface PostboxAuthResult {
	mailboxId: string;
	appPasswordId: string;
	userId: string;
	organizationId: string;
	/**
	 * The mailbox's domain is a sending domain registered with this MTA, so its
	 * mail must not leave unsigned. Convex decides it; the MTA cannot tell a
	 * lost key from a domain that never had one.
	 */
	requireDkimSignature?: true;
}

export interface PostboxAuthClient {
	/**
	 * Client identifier (the SMTP EHLO hostname) forwarded so a successful
	 * submission populates the app-password "Last used" client column. Omitted
	 * leaves lastUsedUa untouched on the server side.
	 */
	clientName?: string;
	/**
	 * The submission client's socket address. Sent normalised inside the signed
	 * body so the server keys its auth-failure throttle (and "Last used" IP) on
	 * the client rather than on this MTA. Omitted when it is not an address.
	 */
	remoteIp?: string;
}

const TIMEOUT_MS = 5_000;

const isId = (value: unknown): value is string => typeof value === 'string' && value !== '';

/**
 * The endpoint answers `{ ok: true, …identifiers, requireDkimSignature }` or
 * `{ ok: false }`. Only a literal `ok: true` carrying every identifier
 * authenticates; anything else, a truthy `ok` with an identifier missing
 * included, is a refusal. A backend that predates `requireDkimSignature` omits
 * it, and anything but a literal `true` means no signature is owed.
 */
function decodeVerifyResponse(value: unknown): PostboxAuthResult | null {
	if (!isRecord(value) || value['ok'] !== true) return null;
	const { mailboxId, appPasswordId, userId, organizationId } = value;
	if (!isId(mailboxId) || !isId(appPasswordId) || !isId(userId) || !isId(organizationId)) {
		logger.warn('verify-credential answered ok without the identifiers');
		return null;
	}
	return {
		mailboxId,
		appPasswordId,
		userId,
		organizationId,
		...(value['requireDkimSignature'] === true ? { requireDkimSignature: true as const } : {}),
	};
}

export async function verifyPostboxAppPassword(
	config: MtaConfig,
	address: string,
	password: string,
	scope: 'imap' | 'smtp',
	client: PostboxAuthClient = {}
): Promise<PostboxAuthResult | null> {
	const url = `${config.convexSiteUrl}/webhooks/mta-verify-credential`;
	const ip = client.remoteIp ? normalizePeerIp(client.remoteIp) : null;
	const body = JSON.stringify({
		address: address.toLowerCase(),
		password,
		scope,
		...(client.clientName ? { clientName: client.clientName } : {}),
		...(ip ? { ip } : {}),
	});
	const signatureHeaders = signMtaRequest(config.webhookSecret, body);

	const controller = new AbortController();
	const t = setTimeout(() => controller.abort(), TIMEOUT_MS);

	try {
		const res = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...signatureHeaders,
			},
			body,
			signal: controller.signal,
		});
		clearTimeout(t);
		if (!res.ok) {
			logger.warn({ status: res.status, address }, 'verify-credential non-OK');
			return null;
		}
		const json: unknown = await res.json();
		return decodeVerifyResponse(json);
	} catch (err) {
		clearTimeout(t);
		logger.warn({ err, address }, 'verify-credential request failed');
		return null;
	}
}
