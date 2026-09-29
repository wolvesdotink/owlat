import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { useTransactionalSnippets } from '../useTransactionalSnippets';

/**
 * The copy-paste curl/JS/Python snippets in the transactional code modal.
 *
 * They used to hardcode `api.owlat.app`, the hosted instance's host — a
 * self-hoster who pasted one sent their API key and their customer's address to
 * somebody else's server. The snippet must name the deployment the user is
 * actually looking at.
 */
let siteUrl: string;
let cloudUrl: string;

function stubEnvironment() {
	vi.stubGlobal('useRuntimeConfig', () => ({
		public: { convexSiteUrl: siteUrl, convexUrl: cloudUrl },
	}));
	vi.stubGlobal('useCopyToClipboard', () => ({
		copy: vi.fn().mockResolvedValue(true),
		copiedKey: ref(null),
		reset: vi.fn(),
	}));
}

/** Read back all three snippets for one email. */
function snippetsFor(slug: string): string[] {
	const { getCodeSnippet } = useTransactionalSnippets(slug);
	return (['curl', 'javascript', 'python'] as const).map((l) => getCodeSnippet(l));
}

beforeEach(() => {
	siteUrl = 'https://mail.acme.test';
	cloudUrl = 'https://mail-cloud.acme.test';
	stubEnvironment();
});

describe('transactional code snippets', () => {
	it('points every snippet at this deployment, not the hosted host', () => {
		for (const snippet of snippetsFor('welcome')) {
			expect(snippet).toContain('https://mail.acme.test/api/v1/transactional');
			expect(snippet).not.toContain('owlat.app');
		}
	});

	it('trims a trailing slash off the configured site URL', () => {
		siteUrl = 'https://mail.acme.test/';
		stubEnvironment();
		expect(snippetsFor('welcome')[0]).toContain('https://mail.acme.test/api/v1/transactional');
	});

	it('falls back to an obvious placeholder when nothing is configured', () => {
		siteUrl = '';
		cloudUrl = '';
		stubEnvironment();
		for (const snippet of snippetsFor('welcome')) {
			expect(snippet).toContain('https://<your-owlat-host>/api/v1/transactional');
		}
	});

	/**
	 * The cloud/sync origin is NOT a usable fallback: `/api/v1/*` lives on the
	 * site proxy and a POST to the sync host silently 404s. A placeholder the
	 * reader must replace beats a host that fails inexplicably.
	 */
	it('does not fall back to the Convex sync origin', () => {
		siteUrl = '';
		stubEnvironment();
		const snippet = snippetsFor('welcome')[0]!;
		expect(snippet).not.toContain('mail-cloud.acme.test');
		expect(snippet).toContain('https://<your-owlat-host>/api/v1/transactional');
	});

	it('still carries the selected email slug', () => {
		expect(snippetsFor('order-shipped')[0]).toContain('"slug": "order-shipped"');
	});

	it('renders nothing while no email is selected', () => {
		expect(useTransactionalSnippets(null).getCodeSnippet('curl')).toBe('');
	});
});
