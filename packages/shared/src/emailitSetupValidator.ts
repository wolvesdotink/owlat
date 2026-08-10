import { fetchSetupProvider, type ValidationResult } from './setupValidationHttp';

/**
 * The failure text with the presented key struck out of it.
 *
 * The empty key is the case that has to be handled rather than assumed away:
 * `''.split('')` splits BETWEEN EVERY CHARACTER, so joining puts `[redacted]`
 * between every letter and the operator is handed an unreadable smear instead of
 * "fetch failed". An empty key is reachable — a bare Enter at a setup prompt —
 * and there is nothing in it to redact anyway, so the message passes through.
 */
function redactKey(error: unknown, apiKey: string): string {
	const message = error instanceof Error ? error.message : 'Unknown error';
	return apiKey === '' ? message : message.split(apiKey).join('[redacted]');
}

/** Prove an Emailit bearer token against its read-only domains endpoint. */
export async function validateEmailitKey(apiKey: string): Promise<ValidationResult> {
	try {
		const res = await fetchSetupProvider('https://api.emailit.com/v2/domains', {
			headers: { Authorization: `Bearer ${apiKey}` },
		});
		if (res.status === 200) return { ok: true, message: 'Emailit key accepted.' };
		if (res.status === 401 || res.status === 403) {
			return { ok: false, message: 'Emailit rejected the key.' };
		}
		return { ok: false, message: `Emailit returned HTTP ${res.status}.` };
	} catch (error) {
		return { ok: false, message: `Emailit request failed: ${redactKey(error, apiKey)}` };
	}
}
