import { fetchSetupProvider, type ValidationResult } from './setupValidationHttp';

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
		const detail = (error instanceof Error ? error.message : 'Unknown error')
			.split(apiKey)
			.join('[redacted]');
		return { ok: false, message: `Emailit request failed: ${detail}` };
	}
}
