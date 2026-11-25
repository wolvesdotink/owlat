const WHERE_TO_FIND_IT =
	'Pass your instance\'s API URL: the web app shows it as "Your API base URL" under Settings → API → API quickstart. It is the NUXT_PUBLIC_CONVEX_SITE_URL your operator set.';

function refuse(problem: string): never {
	throw new TypeError(`baseUrl ${problem}. ${WHERE_TO_FIND_IT}`);
}

/**
 * Checks the instance's API URL once, at construction, and returns it in the
 * form the request builder expects. Each request URL is the base URL followed
 * by a path that starts with `/`, so a path prefix (an API behind a reverse
 * proxy at `/owlat`) carries through, a trailing slash would double the
 * slash and is dropped, and a query string or fragment would swallow the path
 * and is refused. Messages never echo the value: it may be an API key pasted
 * into the wrong field, or carry a password.
 */
export function normalizeBaseUrl(value: unknown): string {
	if (typeof value !== 'string' || value.trim() === '') refuse('is required');
	const hasControl = [...value].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);
	if (/\s/.test(value) || hasControl) refuse('must not contain whitespace or control characters');
	// The URL parser repairs `https:host` and reads `\` as `/`, but the string
	// itself is what each request path is appended to, so it must already be
	// in the plain form.
	if (!/^https?:\/\//i.test(value) || value.includes('\\'))
		refuse('must be an absolute http or https URL, such as https://rest.api.example.com');

	let url: URL;
	try {
		url = new URL(value);
	} catch {
		refuse('must be an absolute http or https URL, such as https://rest.api.example.com');
	}
	// Checked on the input: the parser drops an empty `?` or `#`.
	if (value.includes('?') || value.includes('#'))
		refuse('must not have a query string or fragment, since each request appends its path');
	if (url.username !== '' || url.password !== '') refuse('must not carry a user name or password');

	return value.replace(/\/+$/, '');
}
