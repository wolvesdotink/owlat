// @vitest-environment happy-dom
/**
 * Guided Add-Domain form — piece C2 of the DNS Setup Revamp.
 *
 * The modal body is now a real component, so these are REAL MOUNTS (not source
 * assertions): we drive the two fields and assert the composed value, the live
 * preview, the apex path, paste-a-full-domain round-tripping through the shared
 * PSL module (including co.uk suffixes), and that the freemail block still fires
 * and gates submit.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { splitZone } from '@owlat/shared';

import AddDomainForm from '../AddDomainForm.vue';

const stubs = {
	Icon: { template: '<i />' },
	NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
};

function mountForm() {
	return mount(AddDomainForm, { global: { stubs } });
}

const domainInput = (w: ReturnType<typeof mountForm>) => w.get('#add-domain-name');
const subInput = (w: ReturnType<typeof mountForm>) => w.get('#add-domain-sub');
const preview = (w: ReturnType<typeof mountForm>) => w.find('[data-testid="address-preview"]');

describe('AddDomainForm — compose + preview', () => {
	beforeEach(() => {
		// The blur handler fires a fail-soft DoH NS lookup; keep tests offline and
		// deterministic. (dohQuery already swallows errors, but this avoids the
		// network round-trip entirely.)
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ ok: false, json: async () => ({}) }))
		);
	});

	it('defaults to the recommended mail subdomain and previews it as an example promise', async () => {
		const w = mountForm();
		await domainInput(w).setValue('example.com');
		await domainInput(w).trigger('blur');
		// domain + default sub compose to mail.example.com.
		expect(preview(w).text()).toContain("You'll send as");
		expect(preview(w).text()).toContain('you@mail.example.com');
	});

	it('recomposes the preview live as the subdomain changes', async () => {
		const w = mountForm();
		await domainInput(w).setValue('example.com');
		await subInput(w).setValue('post');
		expect(preview(w).text()).toContain('you@post.example.com');
	});

	it('frames the empty state as an example, not a promise', () => {
		const w = mountForm();
		// Nothing typed yet → example wording, plain (non-bold) address.
		expect(preview(w).exists()).toBe(true);
		expect(preview(w).text()).toContain('For example');
		expect(preview(w).find('strong').exists()).toBe(false);
	});

	it('exposes the preview to the domain input via aria-describedby', async () => {
		const w = mountForm();
		await domainInput(w).setValue('example.com');
		expect(domainInput(w).attributes('aria-describedby')).toBe('add-domain-preview');
		expect(preview(w).attributes('id')).toBe('add-domain-preview');
	});
});

describe('AddDomainForm — error messages bound to their inputs', () => {
	it('binds the domain error to the domain input via aria-describedby', async () => {
		const w = mountForm();
		await w.get('form').trigger('submit'); // empty → required error
		const err = w.get('#add-domain-error');
		expect(err.text()).toContain('Enter your domain');
		// The error is suppressed-with-preview, so describedby names the error id.
		const describedBy = domainInput(w).attributes('aria-describedby') ?? '';
		expect(describedBy.split(' ')).toContain('add-domain-error');
	});

	it('binds the subdomain error to the subdomain input via aria-describedby', async () => {
		const w = mountForm();
		await domainInput(w).setValue('example.com');
		await subInput(w).setValue('not_valid');
		await subInput(w).trigger('blur');
		const err = w.get('#add-domain-sub-error');
		expect(err.text().toLowerCase()).toContain('letters, digits and hyphens');
		expect(subInput(w).attributes('aria-describedby')).toBe('add-domain-sub-error');
	});
});

describe('AddDomainForm — subdomain suggestions + apex', () => {
	it('lets a suggestion set the subdomain', async () => {
		const w = mountForm();
		await domainInput(w).setValue('example.com');
		const sendButton = w.findAll('button').find((b) => b.text() === 'send');
		expect(sendButton).toBeTruthy();
		await sendButton!.trigger('click');
		expect((subInput(w).element as HTMLInputElement).value).toBe('send');
		expect(preview(w).text()).toContain('you@send.example.com');
	});

	it('treats apex ("none") as first-class: previews the bare domain and shows the trade-off note', async () => {
		const w = mountForm();
		await domainInput(w).setValue('example.com');
		const apexButton = w.findAll('button').find((b) => b.text().includes('none'));
		await apexButton!.trigger('click');
		// Preview is the apex itself, no subdomain.
		expect(preview(w).text()).toContain('you@example.com');
		expect(preview(w).text()).not.toContain('mail.example.com');
		// Trade-off note names shared reputation + SPF merge (record UI lives elsewhere).
		const note = w.find('[data-testid="apex-note"]');
		expect(note.exists()).toBe(true);
		expect(note.text()).toContain('example.com');
		expect(note.text().toLowerCase()).toContain('reputation');
		expect(note.text().toLowerCase()).toContain('spf');
	});

	it('does not show the apex note while a subdomain is set', async () => {
		const w = mountForm();
		await domainInput(w).setValue('example.com');
		expect(w.find('[data-testid="apex-note"]').exists()).toBe(false);
	});
});

describe('AddDomainForm — paste-a-full-domain round-trip (shared PSL)', () => {
	it('reflows a pasted mail.example.com into domain=example.com + sub=mail', async () => {
		const w = mountForm();
		await domainInput(w).setValue('mail.example.com');
		await domainInput(w).trigger('blur');
		expect((domainInput(w).element as HTMLInputElement).value).toBe('example.com');
		expect((subInput(w).element as HTMLInputElement).value).toBe('mail');
		// Round-trips to the same string it came from.
		expect(preview(w).text()).toContain('you@mail.example.com');
	});

	it('an explicit paste subdomain wins over the current one', async () => {
		const w = mountForm();
		await subInput(w).setValue('post'); // user had chosen post
		await domainInput(w).setValue('news.example.com');
		await domainInput(w).trigger('blur');
		expect((domainInput(w).element as HTMLInputElement).value).toBe('example.com');
		expect((subInput(w).element as HTMLInputElement).value).toBe('news');
		expect(preview(w).text()).toContain('you@news.example.com');
	});

	it('round-trips multi-label subs and co.uk-style suffixes', async () => {
		const w = mountForm();
		await domainInput(w).setValue('a.b.example.co.uk');
		await domainInput(w).trigger('blur');
		expect((domainInput(w).element as HTMLInputElement).value).toBe('example.co.uk');
		expect((subInput(w).element as HTMLInputElement).value).toBe('a.b');
		expect(preview(w).text()).toContain('you@a.b.example.co.uk');
		// Anchor to the shared module — the same split the component relies on.
		const split = splitZone('a.b.example.co.uk');
		expect(split.registrable).toBe('example.co.uk');
		expect(split.sub).toBe('a.b');
	});
});

describe('AddDomainForm — submit', () => {
	it('emits the composed single domain string', async () => {
		const w = mountForm();
		await domainInput(w).setValue('example.com');
		await subInput(w).setValue('mail');
		await w.get('form').trigger('submit');
		expect(w.emitted('submit')).toBeTruthy();
		expect(w.emitted('submit')![0]).toEqual(['mail.example.com']);
	});

	it('emits the apex domain when no subdomain is set', async () => {
		const w = mountForm();
		await domainInput(w).setValue('example.com');
		const apexButton = w.findAll('button').find((b) => b.text().includes('none'));
		await apexButton!.trigger('click');
		await w.get('form').trigger('submit');
		expect(w.emitted('submit')![0]).toEqual(['example.com']);
	});

	it('rejects an empty domain (required) without emitting', async () => {
		const w = mountForm();
		await w.get('form').trigger('submit');
		expect(w.emitted('submit')).toBeFalsy();
		expect(w.text()).toContain('Enter your domain');
	});

	it('validates the subdomain label with the shared isDnsLabel rule', async () => {
		const w = mountForm();
		await domainInput(w).setValue('example.com');
		await subInput(w).setValue('not_valid'); // underscore is rejected
		await subInput(w).trigger('blur');
		expect(w.emitted('submit')).toBeFalsy();
		await w.get('form').trigger('submit');
		expect(w.emitted('submit')).toBeFalsy();
		expect(w.text().toLowerCase()).toContain('letters, digits and hyphens');
	});
});

describe('AddDomainForm — NS advisory', () => {
	it('clears the stale NS warning the moment the zone changes mid-edit', async () => {
		// DoH returns NXDOMAIN so the advisory fires for the typo'd zone.
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ ok: true, json: async () => ({ Status: 3 }) }))
		);
		const w = mountForm();
		await domainInput(w).setValue('exmaple.com'); // typo
		await domainInput(w).trigger('blur');
		await flushPromises();
		const warning = w.find('[data-testid="ns-warning"]');
		expect(warning.exists()).toBe(true);
		expect(warning.text()).toContain('exmaple.com');
		// Editing the domain recomputes the zone — the old verdict must not
		// re-label onto the new zone before the next blur re-checks it.
		await domainInput(w).setValue('example.com');
		expect(w.find('[data-testid="ns-warning"]').exists()).toBe(false);
	});
});

describe('AddDomainForm — freemail block still fires (on the combined value)', () => {
	it('blocks a freemail apex and suppresses the preview', async () => {
		const w = mountForm();
		await domainInput(w).setValue('gmail.com');
		const apexButton = w.findAll('button').find((b) => b.text().includes('none'));
		await apexButton!.trigger('click');
		const warning = w.find('[data-testid="freemail-warning"]');
		expect(warning.exists()).toBe(true);
		expect(warning.text()).toContain('gmail.com');
		// A contradicting preview is suppressed.
		expect(preview(w).exists()).toBe(false);
	});

	it('blocks a subdomain under a freemail zone (mail.gmail.com) and gates submit', async () => {
		const w = mountForm();
		await domainInput(w).setValue('gmail.com'); // sub defaults to mail → mail.gmail.com
		expect(w.find('[data-testid="freemail-warning"]').exists()).toBe(true);
		const submitBtn = w.findAll('button').find((b) => b.attributes('type') === 'submit')!;
		expect(submitBtn.attributes('disabled')).toBeDefined();
		await w.get('form').trigger('submit');
		expect(w.emitted('submit')).toBeFalsy();
	});
});
