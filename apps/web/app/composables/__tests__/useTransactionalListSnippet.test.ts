import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { createTestI18n } from '~/__tests__/i18n';
import { useTransactionalList } from '../useTransactionalList';

/**
 * The copy-paste curl/JS/Python snippets in the transactional code modal.
 *
 * They used to hardcode `api.owlat.app`, the hosted instance's host — a
 * self-hoster who pasted one sent their API key and their customer's address to
 * somebody else's server. The snippet must name the deployment the user is
 * actually looking at.
 */
const i18n = createTestI18n();

let siteUrl: string;

function stubEnvironment() {
	vi.stubGlobal('useI18n', () => i18n.global);
	vi.stubGlobal('useRouter', () => ({ push: vi.fn() }));
	vi.stubGlobal('useRuntimeConfig', () => ({
		public: { convexSiteUrl: siteUrl, convexUrl: '' },
	}));
	vi.stubGlobal('useCopyToClipboard', () => ({
		copy: vi.fn().mockResolvedValue(true),
		copiedKey: ref(null),
		reset: vi.fn(),
	}));
	vi.stubGlobal('useDebouncedSearch', () => ({ searchQuery: ref(''), debouncedSearch: ref('') }));
	vi.stubGlobal('useOrganizationQuery', () => ({
		data: ref([]),
		isLoading: ref(false),
		error: ref(null),
	}));
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	vi.stubGlobal('formatDate', (ts: number) => String(ts));
	vi.stubGlobal('useBackendOperation', () => ({
		run: vi.fn().mockResolvedValue({ ok: true }),
		isLoading: ref(false),
		inlineError: ref(null),
	}));
}

/** Open the modal on one email and read back all three snippets. */
function snippetsFor(slug: string): string[] {
	const list = useTransactionalList();
	list.openCodeSnippetModal('email-1' as never, 'Welcome', slug);
	return (['curl', 'javascript', 'python'] as const).map((l) => list.getCodeSnippet(l));
}

beforeEach(() => {
	siteUrl = 'https://mail.acme.test';
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
		stubEnvironment();
		for (const snippet of snippetsFor('welcome')) {
			expect(snippet).toContain('https://<your-owlat-host>/api/v1/transactional');
		}
	});

	it('still carries the selected email slug', () => {
		expect(snippetsFor('order-shipped')[0]).toContain('"slug": "order-shipped"');
	});
});
