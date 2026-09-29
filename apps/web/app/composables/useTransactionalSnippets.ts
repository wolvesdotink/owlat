import { computed, toValue, type MaybeRefOrGetter } from 'vue';

type SnippetLanguage = 'curl' | 'javascript' | 'python';

export const SNIPPET_LANGUAGES: readonly { value: SnippetLanguage; label: string }[] = [
	{ value: 'curl', label: 'cURL' },
	{ value: 'javascript', label: 'JavaScript' },
	{ value: 'python', label: 'Python' },
];

/**
 * Stand-in host for the copy-paste snippets when the deployment has published
 * no site URL. Deliberately un-runnable rather than plausible: a self-hoster
 * who pastes this gets an immediate DNS failure they can fix, instead of a
 * request to somebody else's server.
 */
const SNIPPET_HOST_PLACEHOLDER = 'https://<your-owlat-host>';

/**
 * The copy-paste curl/JS/Python snippets for sending one transactional email
 * through the HTTP API, plus copy-to-clipboard for each.
 *
 * `slug` is the email the snippets send; `null` while no email is selected.
 */
export function useTransactionalSnippets(slug: MaybeRefOrGetter<string | null | undefined>) {
	const { copy, copiedKey, reset } = useCopyToClipboard();

	// The snippets are meant to be pasted and run, so they have to name THIS
	// deployment's HTTP-actions host — `api.owlat.app` is the hosted instance and
	// belongs to nobody else.
	const runtimeConfig = useRuntimeConfig();
	// Only `convexSiteUrl`: `/api/v1/*` is an `http.route` handler, which Convex
	// serves on the SITE proxy. `convexUrl` is the cloud/sync origin, where a
	// POST to this path silently 404s — a snippet built from it fails in the one
	// way the reader cannot diagnose, which is what the placeholder is for.
	const transactionalEndpoint = computed(() => {
		const base = (runtimeConfig.public.convexSiteUrl || '').replace(/\/+$/, '');
		return `${base || SNIPPET_HOST_PLACEHOLDER}/api/v1/transactional`;
	});

	const copiedSnippet = computed(() => copiedKey.value as SnippetLanguage | null);

	const getCodeSnippet = (language: SnippetLanguage): string => {
		const current = toValue(slug);
		if (!current) return '';
		const endpoint = transactionalEndpoint.value;

		switch (language) {
			case 'curl':
				return `curl -X POST ${endpoint} \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "slug": "${current}",
    "email": "user@example.com",
    "dataVariables": {
      "name": "John",
      "orderNumber": "12345"
    }
  }'`;
			case 'javascript':
				return `const response = await fetch('${endpoint}', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer YOUR_API_KEY',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    slug: '${current}',
    email: 'user@example.com',
    dataVariables: {
      name: 'John',
      orderNumber: '12345',
    },
  }),
});

const result = await response.json();`;
			case 'python':
				return `import requests

response = requests.post(
    '${endpoint}',
    headers={
        'Authorization': 'Bearer YOUR_API_KEY',
        'Content-Type': 'application/json',
    },
    json={
        'slug': '${current}',
        'email': 'user@example.com',
        'dataVariables': {
            'name': 'John',
            'orderNumber': '12345',
        },
    },
)

result = response.json()`;
		}
	};

	const copySnippet = async (language: SnippetLanguage) => {
		await copy(getCodeSnippet(language), language);
	};

	return { getCodeSnippet, copySnippet, copiedSnippet, resetCopied: reset };
}
