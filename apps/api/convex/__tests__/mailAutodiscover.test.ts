/**
 * Mail-server autodiscovery on the backend: the autoconfig parser, and the
 * action the generic IMAP connect form calls because the web app's CSP lets the
 * browser reach no third-party endpoint.
 *
 * DNS (`resolveMx`, and the SSRF guard's `lookup`) and `fetch` are stubbed, so
 * nothing here touches the network.
 */

import type * as DnsModule from 'dns';
import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import { parseAutoconfigXml } from '../mail/external/autodiscover';

const sessionMocks = vi.hoisted(() => ({
	getBetterAuthSessionWithRole: vi.fn(),
}));

const dnsMocks = vi.hoisted(() => ({ resolveMx: vi.fn(), lookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ default: dnsMocks, ...dnsMocks }));
// The SSRF guard resolves the destination through `dns.promises.lookup` before
// it fetches; the stub decides whether a host looks public or private.
vi.mock('dns', async (importOriginal) => {
	const actual = await importOriginal<typeof DnsModule>();
	const promises = { ...actual.promises, lookup: dnsMocks.lookup };
	return { ...actual, promises, default: { ...actual, promises } };
});

vi.mock('../lib/sessionOrganization', async () => {
	const actual = (await vi.importActual('../lib/sessionOrganization')) as Record<string, unknown>;
	const fromSession = async () => {
		const s = await sessionMocks.getBetterAuthSessionWithRole();
		if (!s) throw new Error('Not authenticated');
		return { userId: s.userId, role: s.role, activeOrganizationId: s.activeOrganizationId };
	};
	return {
		...actual,
		getBetterAuthSessionWithRole: sessionMocks.getBetterAuthSessionWithRole,
		requireOrgMember: vi.fn(fromSession),
		getMutationContext: vi.fn(fromSession),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn(async () => (await fromSession()).userId),
	};
});

const modules = import.meta.glob('../**/*.*s');

/** Minimal Thunderbird autoconfig document for a made-up provider. */
function autoconfigXml(opts?: {
	host?: string;
	imapSocket?: string;
	smtpSocket?: string;
	dropSmtp?: boolean;
}): string {
	const host = opts?.host ?? 'example.net';
	const smtp = opts?.dropSmtp
		? ''
		: `<outgoingServer type="smtp">
				<hostname>smtp.${host}</hostname>
				<port>465</port>
				<socketType>${opts?.smtpSocket ?? 'SSL'}</socketType>
			</outgoingServer>`;
	return `<?xml version="1.0" encoding="UTF-8"?>
		<clientConfig version="1.1">
			<emailProvider id="${host}">
				<domain>${host}</domain>
				<!-- the IMAP server -->
				<incomingServer type="pop3">
					<hostname>pop.${host}</hostname>
					<port>995</port>
					<socketType>SSL</socketType>
				</incomingServer>
				<incomingServer type="imap">
					<hostname>imap.${host}</hostname>
					<port>993</port>
					<socketType>${opts?.imapSocket ?? 'SSL'}</socketType>
				</incomingServer>
				${smtp}
			</emailProvider>
		</clientConfig>`;
}

const EXAMPLE_NET = {
	imapHost: 'imap.example.net',
	imapPort: 993,
	isImapSecure: true,
	smtpHost: 'smtp.example.net',
	smtpPort: 465,
	isSmtpSecure: true,
};

describe('parseAutoconfigXml', () => {
	it('reads the IMAP incoming and SMTP outgoing server', () => {
		expect(parseAutoconfigXml(autoconfigXml())).toEqual(EXAMPLE_NET);
	});

	it('treats STARTTLS and plain socketTypes as not implicit TLS', () => {
		const p = parseAutoconfigXml(autoconfigXml({ imapSocket: 'STARTTLS', smtpSocket: 'plain' }));
		expect(p?.isImapSecure).toBe(false);
		expect(p?.isSmtpSecure).toBe(false);
	});

	it('returns null when a server block is missing', () => {
		expect(parseAutoconfigXml(autoconfigXml({ dropSmtp: true }))).toBeNull();
	});

	it('decodes entities and CDATA in text', () => {
		const xml = autoconfigXml().replace(
			'<hostname>imap.example.net</hostname>',
			'<hostname><![CDATA[imap.example]]>&#x2e;net</hostname>'
		);
		expect(parseAutoconfigXml(xml)?.imapHost).toBe('imap.example.net');
	});

	it('returns null for a document that is not well-formed', () => {
		expect(parseAutoconfigXml('<clientConfig><emailProvider></clientConfig>')).toBeNull();
		expect(parseAutoconfigXml(autoconfigXml().replace('</clientConfig>', ''))).toBeNull();
		expect(parseAutoconfigXml('not xml at all')).toBeNull();
		expect(parseAutoconfigXml(autoconfigXml().replace('993', '99&3'))).toBeNull();
	});

	it('refuses a DOCTYPE, so no document can declare an entity', () => {
		const xml = `<!DOCTYPE clientConfig [<!ENTITY h "imap.example.net">]>${autoconfigXml().replace(
			'<?xml version="1.0" encoding="UTF-8"?>',
			''
		)}`;
		expect(parseAutoconfigXml(xml)).toBeNull();
	});

	it('returns null for a hostname or port no server could have', () => {
		expect(
			parseAutoconfigXml(autoconfigXml().replace('imap.example.net', 'imap example.net'))
		).toBeNull();
		expect(parseAutoconfigXml(autoconfigXml().replace('993', '99999'))).toBeNull();
	});
});

describe('autodiscoverActions.autodiscoverMailServer', () => {
	/** Bodies the stubbed network answers with, keyed on the requested URL. */
	let documents: Map<string, string>;
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		documents = new Map();
		dnsMocks.resolveMx.mockReset();
		dnsMocks.resolveMx.mockRejectedValue(Object.assign(new Error('nx'), { code: 'ENODATA' }));
		dnsMocks.lookup.mockReset();
		dnsMocks.lookup.mockResolvedValue([{ address: '93.184.215.14', family: 4 }]);
		fetchMock = vi.fn(async (input: string | URL) => {
			const body = documents.get(String(input));
			return body === undefined
				? new Response('not found', { status: 404 })
				: new Response(body, { status: 200, headers: { 'content-type': 'text/xml' } });
		});
		vi.stubGlobal('fetch', fetchMock);
		sessionMocks.getBetterAuthSessionWithRole.mockResolvedValue({
			userId: 'user-A',
			role: 'editor',
			activeOrganizationId: 'org-1',
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	async function discover(email: string) {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				featureFlags: { 'mail.external': true },
				createdAt: Date.now(),
			});
		});
		return await t.action(api.mail.external.autodiscoverActions.autodiscoverMailServer, {
			email,
		});
	}

	const requested = () => fetchMock.mock.calls.map(([input]) => String(input));

	it('answers from the Thunderbird ISP database', async () => {
		documents.set('https://autoconfig.thunderbird.net/v1.1/example.net', autoconfigXml());

		expect(await discover('Ada@Example.net')).toEqual(EXAMPLE_NET);
		expect(requested()).toEqual(['https://autoconfig.thunderbird.net/v1.1/example.net']);
	});

	it('falls back to the domain’s own autoconfig document', async () => {
		documents.set(
			'https://autoconfig.example.net/mail/config-v1.1.xml?emailaddress=ada%40example.net',
			autoconfigXml()
		);

		expect(await discover('ada@example.net')).toEqual(EXAMPLE_NET);
		expect(dnsMocks.resolveMx).not.toHaveBeenCalled();
	});

	it('falls back to the ISP database entry of the provider behind the MX', async () => {
		dnsMocks.resolveMx.mockResolvedValue([
			{ exchange: 'mx2.mailhost.example.com', priority: 20 },
			{ exchange: 'mx1.mailhost.example.com.', priority: 10 },
		]);
		documents.set(
			'https://autoconfig.thunderbird.net/v1.1/example.com',
			autoconfigXml({ host: 'example.com' })
		);

		const result = await discover('ada@acme.example');
		expect(result?.imapHost).toBe('imap.example.com');
		expect(dnsMocks.resolveMx).toHaveBeenCalledWith('acme.example');
		const urls = requested();
		expect(urls[urls.length - 1]).toBe('https://autoconfig.thunderbird.net/v1.1/example.com');
	});

	it('returns null without a fetch for an address with no usable domain', async () => {
		for (const email of ['nope', 'ada@', 'ada@localhost', 'ada@exa mple.net', 'ada@[10.0.0.1]']) {
			expect(await discover(email), email).toBeNull();
		}
		expect(fetchMock).not.toHaveBeenCalled();
		expect(dnsMocks.resolveMx).not.toHaveBeenCalled();
	});

	it('refuses an autoconfig host that resolves to a private address', async () => {
		dnsMocks.lookup.mockImplementation(async (host: string) =>
			host === 'autoconfig.example.net'
				? [{ address: '10.0.0.5', family: 4 }]
				: [{ address: '93.184.215.14', family: 4 }]
		);
		documents.set(
			'https://autoconfig.example.net/mail/config-v1.1.xml?emailaddress=ada%40example.net',
			autoconfigXml()
		);

		expect(await discover('ada@example.net')).toBeNull();
		expect(requested()).not.toContain(
			'https://autoconfig.example.net/mail/config-v1.1.xml?emailaddress=ada%40example.net'
		);
	});

	it('returns null when every answer is malformed', async () => {
		documents.set(
			'https://autoconfig.thunderbird.net/v1.1/example.net',
			'<clientConfig><emailProvider>'
		);
		documents.set(
			'https://autoconfig.example.net/mail/config-v1.1.xml?emailaddress=ada%40example.net',
			autoconfigXml({ dropSmtp: true })
		);

		expect(await discover('ada@example.net')).toBeNull();
	});

	it('does not follow a redirect', async () => {
		fetchMock.mockImplementation(
			async () =>
				new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } })
		);

		expect(await discover('ada@example.net')).toBeNull();
		expect(requested()).not.toContain('http://169.254.169.254/');
	});
});
