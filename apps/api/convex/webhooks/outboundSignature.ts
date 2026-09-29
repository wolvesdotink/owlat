/**
 * The versioned signature on outbound customer webhooks.
 *
 * `X-Owlat-Signature: t=<unix seconds>,v1=<hex>`, where `v1` is HMAC-SHA256,
 * keyed with the webhook's secret, over `${t}.${deliveryId}.${body}`. `t` is
 * the same value the request carries in `X-Timestamp` and `deliveryId` the one
 * in `X-Webhook-Delivery-Id`, so a receiver that verifies `v1` knows both
 * headers are the ones Owlat sent and can reject a stale request by `t`
 * (GHSA-72gq-2gg3-2vqq). The body-only `X-Signature` still goes out beside it
 * for one release and is deprecated.
 *
 * The receiver-side contract and a verification example are in
 * `apps/docs/content/<locale>/2.api/10.webhooks.md`. V8-safe: no 'use node'.
 */

import { hmacSha256Hex } from '../lib/crypto';

export const OWLAT_SIGNATURE_HEADER = 'X-Owlat-Signature';

/** Build the `X-Owlat-Signature` header value for one delivery attempt. */
export async function owlatSignatureHeader(
	secret: string,
	request: { timestamp: string; deliveryId: string; body: string }
): Promise<string> {
	const { timestamp, deliveryId, body } = request;
	const v1 = await hmacSha256Hex(secret, `${timestamp}.${deliveryId}.${body}`);
	return `t=${timestamp},v1=${v1}`;
}
