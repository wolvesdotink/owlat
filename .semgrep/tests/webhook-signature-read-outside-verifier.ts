// Semgrep rule test for `webhook-signature-read-outside-verifier` in
// .semgrep.yml. Never imported or compiled: `semgrep --test` reads the
// annotations below. A "ruleid" annotation marks a line the rule must report,
// an "ok" annotation a line it must not. Run from the repo root
// (security.yml runs every file in .semgrep/tests/):
//
//   semgrep --test --config .semgrep.yml .semgrep/tests/webhook-signature-read-outside-verifier.ts
//
// This file is not in the rule's allowlist of verification modules, so every
// signature-header read in it is reported, whether or not the value is then
// verified. That is the convention: only the reviewed modules read these
// headers, and a handler routes the request through their verifiers instead.
// The read forms with whitespace or comments inside them live one per file in
// .semgrep/tests/read-forms/.

// ── Read forms: each one is reported ───────────────────────────────────────

export const presenceOnly = httpAction(async (ctx, request) => {
	// ruleid: webhook-signature-read-outside-verifier
	const signature = request.headers.get('x-hub-signature-256');
	if (!signature) return new Response('Missing signature', { status: 401 });
	return new Response('OK', { status: 200 });
});

// Reported even though it is verified: it is outside the allowlist.
export const verifiedOutsideAllowlist = httpAction(async (ctx, request) => {
	// ruleid: webhook-signature-read-outside-verifier
	const signature = request.headers.get('x-hub-signature-256');
	if (!signature) return new Response('Missing signature', { status: 401 });
	const rawBody = await request.text();
	if (!(await verifyGithubSignature(rawBody, signature, secret))) {
		return new Response('Invalid signature', { status: 401 });
	}
	return new Response('OK', { status: 200 });
});

export function inlineTest(req: Request) {
	// ruleid: webhook-signature-read-outside-verifier
	if (!req.headers.get('x-signature')) return 401;
	return 200;
}

export function inlineTernary(req: Request) {
	// ruleid: webhook-signature-read-outside-verifier
	return req.headers.get('X-Twilio-Signature') ? 200 : 401;
}

// prettier-ignore
export function doubleQuoted(req: Request) {
	// ruleid: webhook-signature-read-outside-verifier
	const sig = req.headers.get("svix-signature");
	return sig;
}

export function nodeBracket(req: IncomingMessage) {
	// ruleid: webhook-signature-read-outside-verifier
	const signature = req.headers['x-hub-signature-256'];
	return signature === undefined ? 401 : 200;
}

export async function detachedHeaders(delivery: Delivery) {
	const { headers } = delivery;
	// ruleid: webhook-signature-read-outside-verifier
	const signature = headers.get('svix-signature');
	return signature;
}

export function detachedGetFunction(req: Request) {
	const get = req.headers.get.bind(req.headers);
	// ruleid: webhook-signature-read-outside-verifier
	const sig = get('x-signature');
	return sig;
}

// A re-read handed straight to a verifier is still a read.
export async function rereadIntoVerifier(req: Request, rawBody: string) {
	// ruleid: webhook-signature-read-outside-verifier
	if (!(await verifyGithubSignature(rawBody, req.headers.get('x-hub-signature-256'), secret))) {
		return 401;
	}
	return 200;
}

// ── Not a signature-header read ────────────────────────────────────────────

export function otherHeader(req: Request) {
	// ok: webhook-signature-read-outside-verifier
	const eventType = req.headers.get('x-github-event');
	return eventType;
}

export function signatureInText(req: Request) {
	// ok: webhook-signature-read-outside-verifier
	return new Response('Missing X-Hub-Signature-256 header', { status: 401 });
}

export function signatureAsObjectKey(signature: string) {
	// ok: webhook-signature-read-outside-verifier
	return new Request('https://example.com', { headers: { 'x-owlat-signature': signature } });
}

// ── Known limit: names that are not plain string literals ───────────────
// These are reads the rule does not see ("todoruleid"). A rule that learns
// one shows up as a test change.

const SIGNATURE_HEADER = 'x-hub-signature-256';
export function constantHeaderName(req: Request) {
	// todoruleid: webhook-signature-read-outside-verifier
	const signature = req.headers.get(SIGNATURE_HEADER);
	return signature;
}

export function templateLiteralHeader(req: Request) {
	// todoruleid: webhook-signature-read-outside-verifier
	const signature = req.headers.get(`x-SIGNATURE`);
	return signature;
}

export function templateSubstitutionHeader(req: Request, provider: string) {
	// todoruleid: webhook-signature-read-outside-verifier
	const signature = req.headers.get(`x-${provider}-signature`);
	return signature;
}

// prettier-ignore
export function escapedHeaderName(req: Request) {
	// todoruleid: webhook-signature-read-outside-verifier
	const signature = req.headers.get('x-\x73ignature');
	return signature;
}
