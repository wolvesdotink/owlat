/**
 * The DKIM deep link opens a sole domain's records once per navigation. It
 * waits for the domain query on arrival, and afterwards a live update to the
 * list must not reopen a panel the operator collapsed.
 */
import { describe, expect, it } from 'vitest';
import { nextTick, ref } from 'vue';
import { useSoleDomainDeepLink } from '../useSoleDomainDeepLink';

type Domain = { _id: string; status: string };

function setup(initial: { hash: string; domains?: Domain[] }) {
	const hash = ref(initial.hash);
	const domains = ref<Domain[] | undefined>(initial.domains);
	const expanded = ref<string | null>(null);
	useSoleDomainDeepLink({
		hash: () => hash.value,
		domains: () => domains.value,
		isAnyExpanded: () => expanded.value !== null,
		expand: (id) => {
			expanded.value = id;
		},
	});
	return { hash, domains, expanded };
}

const ONE: Domain[] = [{ _id: 'domain-one', status: 'pending' }];

describe('useSoleDomainDeepLink', () => {
	it('opens the sole domain once the query answers', async () => {
		const page = setup({ hash: '#sending-domain-list' });
		expect(page.expanded.value).toBeNull();
		page.domains.value = ONE;
		await nextTick();
		expect(page.expanded.value).toBe('domain-one');
	});

	it('does not reopen a collapsed panel when the list updates live', async () => {
		const page = setup({ hash: '#sending-domain-list', domains: ONE });
		expect(page.expanded.value).toBe('domain-one');

		page.expanded.value = null; // the operator collapses the records
		page.domains.value = [{ _id: 'domain-one', status: 'verified' }]; // a DNS check lands
		await nextTick();

		expect(page.expanded.value).toBeNull();
	});

	it('answers a new navigation to the anchor again', async () => {
		const page = setup({ hash: '#sending-domain-list', domains: ONE });
		page.expanded.value = null;

		page.hash.value = '';
		await nextTick();
		page.hash.value = '#sending-domain-list';
		await nextTick();

		expect(page.expanded.value).toBe('domain-one');
	});

	it('spends the navigation on a list with several domains without opening any', async () => {
		const page = setup({
			hash: '#sending-domain-list',
			domains: [
				{ _id: 'domain-one', status: 'pending' },
				{ _id: 'domain-two', status: 'pending' },
			],
		});
		expect(page.expanded.value).toBeNull();

		page.domains.value = ONE; // one is removed later: no late expansion
		await nextTick();
		expect(page.expanded.value).toBeNull();
	});

	it('ignores any other hash', () => {
		const page = setup({ hash: '#something-else', domains: ONE });
		expect(page.expanded.value).toBeNull();
	});
});
