import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const { scanMock } = vi.hoisted(() => ({ scanMock: vi.fn() }));
vi.mock('@owlat/email-scanner/clamav', () => ({
	createClamClient: vi.fn(() => ({
		start: vi.fn(),
		scan: scanMock,
		ping: vi.fn().mockResolvedValue(true),
		getStatus: vi.fn(() => ({ healthy: true, activeScanCount: 0, pendingCount: 0 })),
	})),
}));

import { createScanRoutes } from '../scan.js';
import type { MtaConfig } from '../../config.js';

const config = { apiKey: 'master-key' } as MtaConfig;

function post(body: BodyInit | null, headers: Record<string, string> = {}) {
	const app = createScanRoutes(config);
	return app.request('/attachment', {
		method: 'POST',
		headers: { Authorization: 'Bearer master-key', 'X-Filename': 'doc.pdf', ...headers },
		body,
	});
}

// %PDF magic bytes so the file-type validator accepts the body as a PDF.
const pdfBytes = Buffer.from('%PDF-1.4 fake pdf content');

beforeEach(() => {
	scanMock.mockReset().mockResolvedValue({ clean: true });
});

describe('POST /scan/attachment', () => {
	it('rejects a missing bearer token with 401', async () => {
		const app = createScanRoutes(config);
		const res = await app.request('/attachment', { method: 'POST', body: pdfBytes });
		expect(res.status).toBe(401);
	});

	it('rejects a wrong bearer token with 401', async () => {
		const res = await post(pdfBytes, { Authorization: 'Bearer nope' });
		expect(res.status).toBe(401);
	});

	it('rejects a missing X-Filename header with 400', async () => {
		const app = createScanRoutes(config);
		const res = await app.request('/attachment', {
			method: 'POST',
			headers: { Authorization: 'Bearer master-key' },
			body: pdfBytes,
		});
		expect(res.status).toBe(400);
	});

	it('rejects an empty body with 400', async () => {
		const res = await post(Buffer.alloc(0));
		expect(res.status).toBe(400);
	});

	it('rejects an oversized attachment with 413 before scanning', async () => {
		const res = await post(Buffer.alloc(25 * 1024 * 1024 + 1));
		expect(res.status).toBe(413);
		expect(scanMock).not.toHaveBeenCalled();
	});

	it('blocks a disallowed file type before ClamAV runs', async () => {
		// MZ header = Windows executable
		const res = await post(Buffer.from('MZ\x90\x00executable'), {
			'X-Filename': 'invoice.pdf.exe',
		});
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.clean).toBe(false);
		expect(json.stage).toBe('file_type_validation');
		expect(scanMock).not.toHaveBeenCalled();
	});

	it('lets a legacy Word document through to ClamAV', async () => {
		// `.doc` and `.xls` are OLE2 compound documents, which share their magic
		// number with the `.msi` installer. The type gate used to answer every
		// one of them `clean: false, stage: 'file_type_validation'` — and the
		// inbound path read that as malware, quarantining a customer's contract.
		const ole2 = Buffer.concat([
			Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
			Buffer.from(' a Word 97 document'),
		]);
		const res = await post(ole2, { 'X-Filename': 'report.doc' });
		const json = await res.json();
		expect(json).toEqual({ clean: true });
		expect(scanMock).toHaveBeenCalled();
	});

	it('decodes a percent-encoded filename before judging the type', async () => {
		// An HTTP header value is a ByteString, so a Cyrillic or CJK filename
		// cannot ride raw — the caller percent-encodes it. Ordinary ASCII (and
		// therefore every extension this gate judges) is untouched by that
		// encoding, but the name the log and ClamAV see has to be the real one.
		const res = await post(pdfBytes, {
			'X-Filename': '%D1%80%D0%B0%D1%85%D1%83%D0%BD%D0%BE%D0%BA.pdf',
		});
		const json = await res.json();
		expect(json).toEqual({ clean: true });
		expect(scanMock).toHaveBeenCalled();
	});

	it('still blocks an executable whose encoded name decodes to one', async () => {
		const res = await post(Buffer.from('MZ\x90\x00executable'), {
			'X-Filename': 'invoice.pdf%00.exe',
		});
		const json = await res.json();
		expect(json.clean).toBe(false);
		expect(json.stage).toBe('file_type_validation');
		expect(scanMock).not.toHaveBeenCalled();
	});

	it('takes a lone percent in a filename literally rather than refusing the scan', async () => {
		// `100%.pdf` is a legal filename and a malformed escape sequence. Failing
		// the request would send the caller down its fail-open path and leave the
		// bytes unscanned — the outcome the encoding exists to prevent.
		const res = await post(pdfBytes, { 'X-Filename': '100%.pdf' });
		const json = await res.json();
		expect(json).toEqual({ clean: true });
		expect(scanMock).toHaveBeenCalled();
	});

	it('still blocks the same OLE2 bytes under an installer name', async () => {
		const ole2 = Buffer.concat([
			Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
			Buffer.from(' an installer'),
		]);
		const res = await post(ole2, { 'X-Filename': 'setup.msi' });
		const json = await res.json();
		expect(json.clean).toBe(false);
		expect(json.stage).toBe('file_type_validation');
		expect(scanMock).not.toHaveBeenCalled();
	});

	it('reports malware found by ClamAV', async () => {
		scanMock.mockResolvedValue({ clean: false, virus: 'Eicar-Signature' });
		const res = await post(pdfBytes);
		const json = await res.json();
		expect(json).toMatchObject({ clean: false, virus: 'Eicar-Signature', stage: 'clamav' });
	});

	it('fails open (clean+skipped) when ClamAV is unavailable', async () => {
		scanMock.mockResolvedValue({ clean: true, skipped: true, error: 'connect refused' });
		const res = await post(pdfBytes);
		const json = await res.json();
		expect(json).toMatchObject({ clean: true, skipped: true });
	});

	it('returns clean for a clean scan', async () => {
		const res = await post(pdfBytes);
		const json = await res.json();
		expect(json).toEqual({ clean: true });
	});
});

describe('GET /scan/health', () => {
	it('requires auth and reports ClamAV status', async () => {
		const app = createScanRoutes(config);
		const unauthed = await app.request('/health');
		expect(unauthed.status).toBe(401);

		const res = await app.request('/health', {
			headers: { Authorization: 'Bearer master-key' },
		});
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.clamav).toMatchObject({ healthy: true, pingOk: true });
	});
});
