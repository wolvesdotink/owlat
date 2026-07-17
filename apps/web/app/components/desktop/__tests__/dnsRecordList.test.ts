// @vitest-environment happy-dom
/**
 * DesktopDnsRecordList (DNS setup revamp piece E2) — the copy-friendly DNS
 * record table the server-setup wizard renders its instructions through (the
 * one renderer, used at two sites in pages/desktop/setup.vue).
 *
 * Covers the rendering contract the wizard depends on:
 *   - one row per record: hostname, uppercased type badge, value;
 *   - real rows get a labelled copy button that copies the record's VALUE — the
 *     target the operator pastes into their DNS provider — keyed so per-row
 *     "Copied" feedback is independent;
 *   - placeholder rows (no real address yet) render muted with NO copy button,
 *     so a literal "your server's IP" can never be pasted;
 *   - an optional note renders under its row;
 *   - the real wizard rows from `buildDnsRecords` render end-to-end.
 *
 * `useCopyToClipboard` is stubbed at the auto-import seam (same approach as the
 * other desktop component tests) so the copy call and the per-key "Copied"
 * state are asserted without a real clipboard.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { ref } from 'vue';

import DnsRecordList from '../DnsRecordList.vue';
import { deriveHostnames } from '~/lib/desktop/provisioning';
import { buildDnsRecords } from '~/lib/desktop/provisioningForm';

const copiedKey = ref<string | null>(null);
const copyMock = vi.fn((_text: string, key?: string) => {
	copiedKey.value = key ?? _text;
	return Promise.resolve(true);
});

enableAutoUnmount(afterEach);

beforeAll(() => {
	vi.stubGlobal('useCopyToClipboard', () => ({
		copy: copyMock,
		isCopied: (key: string) => copiedKey.value === key,
	}));
});

beforeEach(() => {
	copyMock.mockClear();
	copiedKey.value = null;
});

const iconStub = { props: ['name'], template: '<i class="icon" :data-name="name" />' };

type Rec = { name: string; type: string; value: string; placeholder?: boolean; note?: string };

function mountList(records: Rec[]) {
	return mount(DnsRecordList, {
		props: { records },
		global: { components: { Icon: iconStub } },
	});
}

const A_RECORD: Rec = { name: 'owlat.wolves.ink', type: 'A', value: '203.0.113.5' };

describe('DesktopDnsRecordList', () => {
	it('renders a row per record — hostname, uppercased type badge, and value', () => {
		const w = mountList([
			A_RECORD,
			{ name: 'bounce.wolves.ink', type: 'mx', value: 'mail.wolves.ink' },
		]);
		const text = w.text();
		expect(text).toContain('owlat.wolves.ink');
		expect(text).toContain('203.0.113.5');
		expect(text).toContain('bounce.wolves.ink');
		expect(text).toContain('mail.wolves.ink');
		// The type badge is uppercased by CSS, but the value passed through verbatim.
		const badges = w.findAll('span.uppercase');
		expect(badges.map((b) => b.text())).toEqual(['A', 'mx']);
	});

	it('copies the record VALUE (the pasteable target), not the hostname, keyed per row', async () => {
		const w = mountList([A_RECORD]);
		const btn = w.get(`button[aria-label="Copy value for ${A_RECORD.name}"]`);
		await btn.trigger('click');
		// Regression guard: an A row must yield the IP, never the hostname.
		expect(copyMock).toHaveBeenCalledWith(A_RECORD.value, `${A_RECORD.name}/${A_RECORD.type}`);
		expect(copyMock).not.toHaveBeenCalledWith(A_RECORD.name, expect.anything());
	});

	it('swaps the copy affordance to a "Copied" state for the copied row only', async () => {
		const rows: Rec[] = [A_RECORD, { name: 'api.wolves.ink', type: 'A', value: '198.51.100.9' }];
		const w = mountList(rows);
		await w.get(`button[aria-label="Copy value for ${A_RECORD.name}"]`).trigger('click');

		// The clicked row flips to "Copied"; the sibling row keeps its copy title.
		expect(w.get(`button[aria-label="Copy value for ${A_RECORD.name}"]`).attributes('title')).toBe(
			'Copied'
		);
		expect(w.get('button[aria-label="Copy value for api.wolves.ink"]').attributes('title')).toBe(
			'Copy value for api.wolves.ink'
		);
	});

	it('renders placeholder rows muted with NO copy button (an un-pasteable value is never copyable)', () => {
		const w = mountList([
			{ name: 'owlat.wolves.ink', type: 'A', value: "your server's IP", placeholder: true },
		]);
		expect(w.find('button').exists()).toBe(false);
		// The value cell is flagged as a placeholder (italic/amber), not a real target.
		const valueCell = w.findAll('span.select-all').find((s) => s.text() === "your server's IP");
		expect(valueCell?.classes()).toContain('italic');
	});

	it('mixes real and placeholder rows — only the real one is copyable', () => {
		const w = mountList([
			A_RECORD,
			{ name: 'mail.wolves.ink', type: 'A', value: "your server's IP", placeholder: true },
		]);
		const buttons = w.findAll('button');
		expect(buttons).toHaveLength(1);
		expect(buttons[0]?.attributes('aria-label')).toBe(`Copy value for ${A_RECORD.name}`);
	});

	it('renders an optional note under its row', () => {
		const w = mountList([
			{ ...A_RECORD, note: 'Also set reverse DNS (PTR) for this IP at your host.' },
		]);
		const note = w.get('p');
		expect(note.text()).toContain('reverse DNS (PTR)');
	});

	it('omits the note element when a record has no note', () => {
		const w = mountList([A_RECORD]);
		expect(w.find('p').exists()).toBe(false);
	});

	it('renders the wizard’s real buildDnsRecords output and copies each row’s value', async () => {
		// Bind the test to the actual rows the wizard feeds this component. A real
		// server IP means every row is copyable (no placeholders), and the bounce
		// host repeats (MX + SPF TXT), so match buttons positionally, not by name.
		const hosts = deriveHostnames('wolves.ink');
		const records = buildDnsRecords({ hosts, withMta: true, serverIp: '203.0.113.5' });
		expect(records.every((r) => !r.placeholder)).toBe(true);
		const w = mountList(records);

		const buttons = w.findAll('button');
		expect(buttons).toHaveLength(records.length);
		for (let i = 0; i < records.length; i++) {
			const r = records[i]!;
			await buttons[i]!.trigger('click');
			// Copying yields the row's VALUE, keyed by name/type.
			expect(copyMock).toHaveBeenLastCalledWith(r.value, `${r.name}/${r.type}`);
		}
		// The MTA install surfaces the SPF value verbatim for copying.
		expect(records.some((r) => r.type === 'TXT' && r.value.startsWith('v=spf1'))).toBe(true);
	});
});
