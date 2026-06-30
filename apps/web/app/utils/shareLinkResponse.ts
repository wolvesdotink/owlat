/**
 * Interpret the `GET /share/{token}` public-endpoint response.
 *
 * The endpoint never returns HTTP 410: the Operation error taxonomy has no
 * Gone category, so an expired link comes back as 404 with the machine-readable
 * `reason: 'expired'` riding in the locked error envelope
 * (`{ error: { category, message, data: { reason } } }`). The share page used
 * to branch on `status === 410`, so the dedicated "expired" state was dead and
 * expired links were mislabelled as invalid/revoked.
 *
 * Keeping the branch logic here (pure, given the parsed body) makes it unit
 * testable without mounting the Nuxt page.
 */

export interface ShareLinkData {
	html: string;
	subject: string;
	previewText?: string;
	organizationName: string;
	expiresAt: number;
}

export type ShareLinkResponseResult =
	| { kind: 'ok'; data: ShareLinkData }
	| { kind: 'expired' }
	| { kind: 'invalid' };

interface ShareSuccessBody {
	ok?: boolean;
	data?: ShareLinkData;
}

interface ShareErrorBody {
	error?: { data?: { reason?: string } };
}

/**
 * @param ok    `response.ok` (HTTP 2xx)
 * @param body  the parsed JSON body, or `null` if it could not be parsed
 */
export function interpretShareResponse(
	ok: boolean,
	body: unknown,
): ShareLinkResponseResult {
	if (!ok) {
		const reason = (body as ShareErrorBody | null)?.error?.data?.reason;
		return reason === 'expired' ? { kind: 'expired' } : { kind: 'invalid' };
	}

	const success = body as ShareSuccessBody | null;
	if (success?.ok && success.data) {
		return { kind: 'ok', data: success.data };
	}
	// 2xx but not the expected `{ ok: true, data }` envelope — treat as invalid.
	return { kind: 'invalid' };
}
