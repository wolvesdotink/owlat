export interface ValidationResult {
	ok: boolean;
	message: string;
}

const SETUP_HTTP_TIMEOUT_MS = 8_000;

/** Run one fixed provider probe with a bounded network lifetime. */
export async function fetchSetupProvider(url: string, init: RequestInit): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), SETUP_HTTP_TIMEOUT_MS);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}
