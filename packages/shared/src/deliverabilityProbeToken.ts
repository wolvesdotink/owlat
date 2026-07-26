import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isDeliverabilityProbeTokenFormat } from './deliverabilityProbeFormat';

export {
	DELIVERABILITY_PROBE_LOCAL_PREFIX,
	isDeliverabilityProbeTokenFormat,
} from './deliverabilityProbeFormat';
const NONCE_BYTES = 9;
const MAC_BYTES = 12;
const MAX_FUTURE_MS = 20 * 60_000;

function signature(secret: string, unsigned: string): Buffer {
	return createHmac('sha256', secret)
		.update(`owlat-deliverability-probe-v1:${unsigned}`, 'utf8')
		.digest()
		.subarray(0, MAC_BYTES);
}

/** Create a short-lived, RCPT-verifiable token that keeps the local part under 64 bytes. */
export function createDeliverabilityProbeToken(
	secret: string,
	expiresAt: number,
	nonce = randomBytes(NONCE_BYTES)
): string {
	if (!secret || !Number.isFinite(expiresAt) || nonce.length !== NONCE_BYTES) {
		throw new Error('Invalid deliverability probe token input');
	}
	const expires = Math.floor(expiresAt / 1_000).toString(36);
	const nonceText = nonce.toString('base64url');
	const unsigned = `${expires}.${nonceText}`;
	return `${unsigned}.${signature(secret, unsigned).toString('base64url')}`;
}

/** Validate syntax, expiry, bounded lifetime, and MAC without leaking comparison timing. */
export function verifyDeliverabilityProbeToken(
	token: string,
	secret: string,
	now = Date.now()
): boolean {
	if (!secret || !Number.isFinite(now) || !isDeliverabilityProbeTokenFormat(token)) return false;
	const [expiresText, nonce, providedText] = token.split('.');
	if (!expiresText || !nonce || !providedText) return false;
	const expiresAt = Number.parseInt(expiresText, 36) * 1_000;
	if (!Number.isFinite(expiresAt) || expiresAt < now || expiresAt > now + MAX_FUTURE_MS)
		return false;
	const provided = Buffer.from(providedText, 'base64url');
	const expected = signature(secret, `${expiresText}.${nonce}`);
	return provided.length === expected.length && timingSafeEqual(provided, expected);
}
