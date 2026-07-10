/**
 * Provider credential validators — fire real requests so the setup flow never
 * silently accepts a typo'd API key.
 *
 * Single source of truth shared by the `owlat-setup` CLI wizard and the web
 * setup endpoint (`apps/web/server/api/setup/validate-provider.post.ts`), so
 * the two can never drift apart on which status codes mean "valid".
 *
 * API-key providers are checked with `fetch`; the generic SMTP relay is checked
 * with a real SMTP handshake + AUTH exchange (`validateSmtpRelay`) over Node's
 * `net`/`tls` sockets. Both entry points are only ever imported server-side (the
 * Nitro setup endpoint and the CLI) — never bundled into the browser — so the
 * Node built-ins below are safe.
 */

import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';

export interface ValidationResult {
	ok: boolean;
	message: string;
}

export type SetupProvider = 'resend' | 'openai' | 'openrouter' | 'posthog' | 'safebrowsing';

const TIMEOUT_MS = 8_000;

/**
 * Block hosts that resolve to private, loopback, link-local, or cloud-metadata
 * addresses. `validatePostHogHost` fires a server-side request to a
 * caller-supplied host, so without this guard the setup endpoint is an SSRF
 * gadget for probing internal services (e.g. http://169.254.169.254/,
 * http://127.0.0.1:6379/). Hostname-literal check only — it stops the direct
 * IP-literal SSRF; DNS-rebinding to a public name is out of scope here, which is
 * why the endpoint should also remain behind the setup-token gate.
 */
function isBlockedSsrfHost(hostname: string): boolean {
	const h = hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
	if (
		h === 'localhost' ||
		h.endsWith('.localhost') ||
		h.endsWith('.local') ||
		h.endsWith('.internal')
	) {
		return true;
	}
	const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (v4) {
		const o = v4.slice(1).map(Number);
		if (o.some((n) => n > 255)) return true; // malformed → block
		const [a, b] = o as [number, number, number, number];
		if (a === 0 || a === 127 || a === 10) return true;
		if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
		if (a === 172 && b >= 16 && b <= 31) return true;
		if (a === 192 && b === 168) return true;
		if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
		return false;
	}
	if (h.includes(':')) {
		// IPv6 literal
		if (h === '::1' || h === '::') return true;
		if (h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd')) return true;
		if (h.startsWith('::ffff:')) return true; // IPv4-mapped — conservatively block
		return false;
	}
	return false;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

export async function validateOpenAIKey(
	apiKey: string,
	baseUrl = 'https://api.openai.com/v1'
): Promise<ValidationResult> {
	try {
		const res = await fetchWithTimeout(`${baseUrl}/models`, {
			headers: { Authorization: `Bearer ${apiKey}` },
		});
		if (res.status === 200) return { ok: true, message: 'OpenAI key accepted.' };
		if (res.status === 401)
			return { ok: false, message: 'OpenAI rejected the key (401 Unauthorized).' };
		return { ok: false, message: `OpenAI returned HTTP ${res.status}.` };
	} catch (e) {
		return { ok: false, message: `OpenAI request failed: ${(e as Error).message}` };
	}
}

export async function validateOpenRouterKey(apiKey: string): Promise<ValidationResult> {
	try {
		const res = await fetchWithTimeout('https://openrouter.ai/api/v1/models', {
			headers: { Authorization: `Bearer ${apiKey}` },
		});
		if (res.status === 200) return { ok: true, message: 'OpenRouter key accepted.' };
		if (res.status === 401)
			return { ok: false, message: 'OpenRouter rejected the key (401 Unauthorized).' };
		return { ok: false, message: `OpenRouter returned HTTP ${res.status}.` };
	} catch (e) {
		return { ok: false, message: `OpenRouter request failed: ${(e as Error).message}` };
	}
}

export async function validateResendKey(apiKey: string): Promise<ValidationResult> {
	try {
		const res = await fetchWithTimeout('https://api.resend.com/domains', {
			headers: { Authorization: `Bearer ${apiKey}` },
		});
		if (res.status === 200) return { ok: true, message: 'Resend key accepted.' };
		if (res.status === 401 || res.status === 403) {
			return { ok: false, message: 'Resend rejected the key.' };
		}
		return { ok: false, message: `Resend returned HTTP ${res.status}.` };
	} catch (e) {
		return { ok: false, message: `Resend request failed: ${(e as Error).message}` };
	}
}

export async function validatePostHogHost(
	host: string,
	apiKey?: string
): Promise<ValidationResult> {
	let base: URL;
	try {
		base = new URL(host.startsWith('http') ? host : `https://${host}`);
	} catch {
		return { ok: false, message: 'PostHog host is not a valid URL.' };
	}
	if (base.protocol !== 'http:' && base.protocol !== 'https:') {
		return { ok: false, message: 'PostHog host must use http or https.' };
	}
	if (isBlockedSsrfHost(base.hostname)) {
		// Refuse private/loopback/link-local targets so this validator can't be
		// abused to probe internal services (SSRF).
		return { ok: false, message: 'PostHog host must be a public address.' };
	}
	try {
		const url = new URL('/decide', base);
		const res = await fetchWithTimeout(url.toString(), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ token: apiKey ?? 'health-check', distinct_id: 'owlat-setup' }),
		});
		// PostHog returns 200 even on a bad token; we just verify the host is reachable.
		if (res.status < 500) return { ok: true, message: 'PostHog host reachable.' };
		return { ok: false, message: `PostHog host returned HTTP ${res.status}.` };
	} catch {
		// Do not echo the raw fetch error — it leaks a reachability/port-probe
		// oracle (ECONNREFUSED vs timeout vs DNS) to an unauthenticated caller.
		return { ok: false, message: 'PostHog host is not reachable.' };
	}
}

export async function validateGoogleSafeBrowsingKey(apiKey: string): Promise<ValidationResult> {
	try {
		const res = await fetchWithTimeout(
			`https://safebrowsing.googleapis.com/v4/threatLists?key=${encodeURIComponent(apiKey)}`,
			{}
		);
		if (res.status === 200) return { ok: true, message: 'Google Safe Browsing key accepted.' };
		if (res.status === 400 || res.status === 403) {
			return { ok: false, message: 'Google Safe Browsing rejected the key.' };
		}
		return { ok: false, message: `Google Safe Browsing returned HTTP ${res.status}.` };
	} catch (e) {
		return { ok: false, message: `Google Safe Browsing request failed: ${(e as Error).message}` };
	}
}

// ── Generic SMTP relay ───────────────────────────────────────────────────────

/**
 * Instance-level SMTP relay connection to validate before it is written to the
 * `SMTP_RELAY_*` env. `secure: true` opens an implicit-TLS connection (usually
 * 465); `secure: false` connects in cleartext and upgrades via STARTTLS (587) —
 * matching the backend `smtp` send adapter's semantics exactly.
 */
export interface SmtpRelayInput {
	host: string;
	port: number;
	secure: boolean;
	username: string;
	password: string;
}

interface SmtpReply {
	code: number;
	/** Whole reply, lines joined by spaces — used only for error strings. */
	text: string;
	/** Each raw reply line (code prefix intact) — parsed for AUTH mechanisms. */
	lines: string[];
}

/** Per-step read/connect bound so a hung relay can't stall setup indefinitely. */
const SMTP_PROBE_TIMEOUT_MS = 10_000;

/**
 * A minimal SMTP client that drives just enough of the submission handshake to
 * prove a relay's host/port/TLS/credentials are usable: greeting → EHLO →
 * (STARTTLS →) EHLO → AUTH. It never sends a message. The `net`/`tls` socket is
 * swapped in place on the STARTTLS upgrade, so the reader re-binds to the TLS
 * socket after the upgrade.
 */
class SmtpProbe {
	private buffer = '';
	private pendingLines: string[] = [];
	private readonly replyQueue: SmtpReply[] = [];
	private waiter: { resolve: (r: SmtpReply) => void; reject: (e: Error) => void } | null = null;
	private failure: Error | null = null;

	private readonly onData = (chunk: Buffer): void => this.ingest(chunk.toString('utf8'));
	private readonly onError = (e: Error): void =>
		this.fail(e instanceof Error ? e : new Error(String(e)));
	private readonly onClose = (): void => this.fail(new Error('connection closed'));

	private constructor(private socket: Socket | TLSSocket) {
		this.bind(socket);
	}

	static open(host: string, port: number, secure: boolean): Promise<SmtpProbe> {
		return new Promise((resolve, reject) => {
			const socket = secure
				? tlsConnect({ host, port, servername: host })
				: netConnect({ host, port });
			const timer = setTimeout(() => {
				socket.destroy();
				reject(new Error('timeout'));
			}, SMTP_PROBE_TIMEOUT_MS);
			const onErr = (e: Error): void => {
				clearTimeout(timer);
				socket.destroy();
				reject(e);
			};
			socket.once(secure ? 'secureConnect' : 'connect', () => {
				clearTimeout(timer);
				socket.removeListener('error', onErr);
				resolve(new SmtpProbe(socket));
			});
			socket.once('error', onErr);
		});
	}

	private bind(socket: Socket | TLSSocket): void {
		socket.on('data', this.onData);
		socket.on('error', this.onError);
		socket.on('close', this.onClose);
	}

	private unbind(socket: Socket | TLSSocket): void {
		socket.removeListener('data', this.onData);
		socket.removeListener('error', this.onError);
		socket.removeListener('close', this.onClose);
	}

	private ingest(chunk: string): void {
		this.buffer += chunk;
		let idx: number;
		while ((idx = this.buffer.indexOf('\n')) !== -1) {
			let line = this.buffer.slice(0, idx);
			this.buffer = this.buffer.slice(idx + 1);
			if (line.endsWith('\r')) line = line.slice(0, -1);
			this.pendingLines.push(line);
			// A reply is complete when a line has a space (not a hyphen) after the
			// 3-digit code, or is too short to be a continuation.
			if (line.length < 4 || line.charAt(3) === ' ') {
				const code = Number.parseInt(line.slice(0, 3), 10);
				const lines = this.pendingLines;
				this.pendingLines = [];
				this.deliver({ code: Number.isFinite(code) ? code : 0, text: lines.join(' '), lines });
			}
		}
	}

	private deliver(reply: SmtpReply): void {
		if (this.waiter) {
			const w = this.waiter;
			this.waiter = null;
			w.resolve(reply);
		} else {
			this.replyQueue.push(reply);
		}
	}

	private fail(e: Error): void {
		if (this.failure) return;
		this.failure = e;
		if (this.waiter) {
			const w = this.waiter;
			this.waiter = null;
			w.reject(e);
		}
	}

	private read(): Promise<SmtpReply> {
		const queued = this.replyQueue.shift();
		if (queued) return Promise.resolve(queued);
		if (this.failure) return Promise.reject(this.failure);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiter = null;
				reject(new Error('timeout'));
			}, SMTP_PROBE_TIMEOUT_MS);
			this.waiter = {
				resolve: (r) => {
					clearTimeout(timer);
					resolve(r);
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			};
		});
	}

	private send(command: string): void {
		this.socket.write(`${command}\r\n`);
	}

	private async expect(ok: (code: number) => boolean, context: string): Promise<SmtpReply> {
		const reply = await this.read();
		if (!ok(reply.code)) throw new Error(`${context}: ${reply.code} ${reply.text}`.trim());
		return reply;
	}

	/** Send EHLO and return the advertised AUTH mechanisms (upper-cased). */
	private async ehlo(): Promise<Set<string>> {
		this.send('EHLO owlat-setup');
		const reply = await this.expect((c) => c >= 200 && c < 300, 'SMTP relay rejected EHLO');
		const mechs = new Set<string>();
		for (const line of reply.lines) {
			const match = line.slice(4).match(/^AUTH\s+(.+)$/i);
			if (match?.[1]) {
				for (const mech of match[1].trim().split(/\s+/)) mechs.add(mech.toUpperCase());
			}
		}
		return mechs;
	}

	private async startTls(host: string): Promise<void> {
		this.unbind(this.socket);
		const raw = this.socket as Socket;
		const tlsSocket = await new Promise<TLSSocket>((resolve, reject) => {
			const s = tlsConnect({ socket: raw, servername: host }, () => {
				s.removeListener('error', onErr);
				resolve(s);
			});
			const onErr = (e: Error): void => reject(e);
			s.once('error', onErr);
		});
		this.socket = tlsSocket;
		this.buffer = '';
		this.pendingLines = [];
		this.bind(tlsSocket);
	}

	private async authenticate(mechs: Set<string>, input: SmtpRelayInput): Promise<ValidationResult> {
		if (mechs.has('PLAIN')) {
			const token = Buffer.from(`\0${input.username}\0${input.password}`).toString('base64');
			this.send(`AUTH PLAIN ${token}`);
		} else if (mechs.has('LOGIN')) {
			this.send('AUTH LOGIN');
			await this.expect((c) => c === 334, 'SMTP relay did not start AUTH LOGIN');
			this.send(Buffer.from(input.username).toString('base64'));
			await this.expect((c) => c === 334, 'SMTP relay rejected the username exchange');
			this.send(Buffer.from(input.password).toString('base64'));
		} else {
			return {
				ok: false,
				message:
					'The SMTP relay did not offer a supported AUTH mechanism (PLAIN or LOGIN). Double-check the host and port.',
			};
		}
		const reply = await this.read();
		if (reply.code === 235) {
			this.send('QUIT');
			return { ok: true, message: 'SMTP relay accepted the credentials.' };
		}
		if (reply.code === 530 || reply.code === 534 || reply.code === 535 || reply.code === 538) {
			return { ok: false, message: 'The SMTP relay rejected the username or password.' };
		}
		return { ok: false, message: `SMTP relay authentication failed: ${reply.code} ${reply.text}` };
	}

	async run(input: SmtpRelayInput): Promise<ValidationResult> {
		await this.expect((c) => c >= 200 && c < 400, 'SMTP relay did not send a greeting');
		await this.ehlo();
		if (!input.secure) {
			this.send('STARTTLS');
			await this.expect((c) => c >= 200 && c < 300, 'SMTP relay refused STARTTLS');
			await this.startTls(input.host);
		}
		const mechs = await this.ehlo();
		return this.authenticate(mechs, input);
	}

	close(): void {
		try {
			this.socket.destroy();
		} catch {
			/* already closed */
		}
	}
}

/** Turn a raw socket/timeout error into an operator-facing sentence. */
function describeSmtpError(e: unknown): string {
	const msg = e instanceof Error ? e.message : String(e);
	if (msg === 'timeout') return 'The SMTP relay did not respond in time. Check the host and port.';
	// `expect()` failures already read as full sentences; pass them through.
	if (msg.startsWith('SMTP relay')) return msg;
	const lower = msg.toLowerCase();
	if (lower.includes('econnrefused')) {
		return 'Connection refused by the SMTP relay. Check the host and port.';
	}
	if (lower.includes('enotfound') || lower.includes('eai_again')) {
		return 'Could not resolve the SMTP relay host. Check the hostname.';
	}
	if (lower.includes('certificate') || lower.includes('ssl') || lower.includes('tls')) {
		return `TLS handshake with the SMTP relay failed: ${msg}`;
	}
	return `Could not reach the SMTP relay: ${msg}`;
}

/**
 * Validate a generic SMTP relay by opening a real connection and running the
 * submission handshake through AUTH — no message is sent. SSRF-guarded (the host
 * is caller-supplied and the connection is server-side) and bounded by
 * `SMTP_PROBE_TIMEOUT_MS`, so an operator finds a bad host/port/credential here
 * rather than at first send.
 */
export async function validateSmtpRelay(input: SmtpRelayInput): Promise<ValidationResult> {
	if (!input.host.trim()) return { ok: false, message: 'SMTP relay host is required.' };
	if (isBlockedSsrfHost(input.host)) {
		return { ok: false, message: 'SMTP relay host must be a public address.' };
	}
	if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
		return { ok: false, message: 'SMTP relay port must be a whole number between 1 and 65535.' };
	}
	if (!input.username || !input.password) {
		return { ok: false, message: 'SMTP relay username and password are required.' };
	}

	let probe: SmtpProbe | null = null;
	try {
		probe = await SmtpProbe.open(input.host, input.port, input.secure);
		return await probe.run(input);
	} catch (e) {
		return { ok: false, message: describeSmtpError(e) };
	} finally {
		probe?.close();
	}
}

/** Dispatch to the right validator by provider name (used by the web endpoint). */
export async function validateProvider(
	provider: SetupProvider,
	apiKey: string,
	host?: string
): Promise<ValidationResult> {
	switch (provider) {
		case 'resend':
			return validateResendKey(apiKey);
		case 'openai':
			return validateOpenAIKey(apiKey);
		case 'openrouter':
			return validateOpenRouterKey(apiKey);
		case 'posthog':
			if (!host) return { ok: false, message: 'PostHog host is required.' };
			return validatePostHogHost(host, apiKey);
		case 'safebrowsing':
			return validateGoogleSafeBrowsingKey(apiKey);
		default:
			return { ok: false, message: `Unknown provider: ${provider as string}` };
	}
}
