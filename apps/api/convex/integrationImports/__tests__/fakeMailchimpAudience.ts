/**
 * A Mailchimp audience behind a fake `GET /lists/{id}/members`, for tests that
 * change the audience while an import walks it. It honours what the adapter
 * sends: `count`, `offset`, `sort_field` (`timestamp_signup`, `last_changed`)
 * with `sort_dir=ASC`, and `since_last_changed`. Without a sort field the
 * members come back in insertion order, as the previous release read them.
 *
 * `beforeRequest(n)` runs before the n-th provider request (1-based) is
 * answered, which is where a test changes the audience "between two pages".
 */

import { vi } from 'vitest';

interface FakeMember {
	email: string;
	status: string;
	signedUpAt: number;
	changedAt: number;
}

export type FakeAudience = ReturnType<typeof fakeMailchimpAudience>;

const DAY_MS = 24 * 60 * 60 * 1000;

export function fakeMailchimpAudience(seed: { email: string; status: string }[]) {
	// Signed up and last changed well before the run, one millisecond apart.
	const base = Date.now() - DAY_MS;
	const members: FakeMember[] = seed.map((m, i) => ({
		...m,
		signedUpAt: base + i,
		changedAt: base + i,
	}));
	const requests: URL[] = [];
	let beforeRequest: ((n: number) => void) | undefined;

	function find(email: string): FakeMember {
		const member = members.find((m) => m.email === email);
		if (!member) throw new Error(`no member ${email}`);
		return member;
	}

	const fetch = vi.fn(async (input: unknown) => {
		const url = new URL(String(input));
		requests.push(url);
		beforeRequest?.(requests.length);

		const since = url.searchParams.get('since_last_changed');
		let view =
			since === null ? [...members] : members.filter((m) => m.changedAt > Date.parse(since));
		const sortField = url.searchParams.get('sort_field');
		if (sortField !== null) {
			if (sortField !== 'timestamp_signup' && sortField !== 'last_changed') {
				throw new Error(`fake cannot sort by ${sortField}`);
			}
			if (url.searchParams.get('sort_dir') !== 'ASC') throw new Error('fake sorts ASC only');
			const key = sortField === 'timestamp_signup' ? 'signedUpAt' : 'changedAt';
			view = view.sort((a, b) => a[key] - b[key]);
		}
		const offset = Number(url.searchParams.get('offset') ?? 0);
		const count = Number(url.searchParams.get('count') ?? 10);
		return new Response(
			JSON.stringify({
				members: view.slice(offset, offset + count).map((m) => ({
					email_address: m.email,
					status: m.status,
					merge_fields: { FNAME: 'F', LNAME: 'L' },
				})),
				total_items: view.length,
			}),
			{ status: 200 }
		);
	});

	return {
		members,
		fetch,
		requests,
		onRequest(hook: (n: number) => void) {
			beforeRequest = hook;
		},
		/** A new signup: last in signup order. */
		add(email: string, status = 'subscribed') {
			members.push({ email, status, signedUpAt: Date.now(), changedAt: Date.now() });
		},
		/** Permanently deleted from the audience. */
		remove(email: string) {
			members.splice(members.indexOf(find(email)), 1);
		},
		setStatus(email: string, status: string) {
			const member = find(email);
			member.status = status;
			member.changedAt = Date.now();
		},
	};
}
