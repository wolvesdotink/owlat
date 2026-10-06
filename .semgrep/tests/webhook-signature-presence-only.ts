// Semgrep rule test for `webhook-signature-presence-only` in .semgrep.yml.
// Never imported or compiled: `semgrep --test` reads the annotations below.
// A "ruleid" annotation marks a line the rule must report, an "ok" annotation
// a line it must not.
// Run from the repo root:
//
//   semgrep --test --config .semgrep.yml .semgrep/tests/webhook-signature-presence-only.ts
//
// The verifying shapes copy the real handlers: webhooks/githubHttp.ts,
// webhooks/adapters/twilio.ts and webhooks/adapters/meta.ts.

// ── Presence-only: the header is read and checked, never verified ──────

export const githubPresenceOnly = httpAction(async (ctx, request) => {
	// ruleid: webhook-signature-presence-only
	const signature = request.headers.get('x-hub-signature-256');
	if (!signature) {
		return new Response('Missing X-Hub-Signature-256 header', { status: 401 });
	}
	const rawBody = await request.text();
	await ctx.runMutation(internal.github.ingest, { rawBody });
	return new Response('OK', { status: 200 });
});

export const twilioPresenceOnly = httpAction(async (ctx, request) => {
	// ruleid: webhook-signature-presence-only
	const signature = request.headers.get('x-twilio-signature');
	if (!signature) return new Response('Missing X-Twilio-Signature header', { status: 401 });
	await ctx.runMutation(internal.sms.ingest, { rawBody: await request.text() });
	return new Response('OK', { status: 200 });
});

export async function metaPresenceOnly(request: Request): Promise<Response> {
	// ruleid: webhook-signature-presence-only
	const signature = request.headers.get('X-Hub-Signature-256');
	if (signature === null) {
		return new Response('Missing X-Hub-Signature-256 header', { status: 401 });
	}
	return new Response('OK', { status: 200 });
}

export const svixPresenceOnly = async (req: Request) => {
	// ruleid: webhook-signature-presence-only
	const sig = req.headers.get('svix-signature');
	if (!sig || !req.body) {
		return new Response('Missing signature', { status: 401 });
	}
	return new Response('OK', { status: 200 });
};

export const handleLoosePresenceOnly = httpAction(async (ctx, req) => {
	// ruleid: webhook-signature-presence-only
	const sig = req.headers.get('X-Twilio-Signature');
	if (sig == null) return new Response('Missing signature', { status: 401 });
	return new Response('OK', { status: 200 });
});

export const providerPresenceOnly = {
	async handle(request: Request): Promise<Response> {
		// ruleid: webhook-signature-presence-only
		const signature = request.headers.get('x-provider-signature');
		if (!signature) {
			return new Response('Missing signature', { status: 401 });
		}
		return new Response('OK', { status: 200 });
	},
};

// ── Inline verification: an HMAC compared in the handler itself ─────────

export const githubInline = httpAction(async (ctx, request) => {
	// ok: webhook-signature-presence-only
	const signature = request.headers.get('x-hub-signature-256');
	if (!signature) {
		return new Response('Missing X-Hub-Signature-256 header', { status: 401 });
	}
	const rawBody = await request.text();
	const expected = `sha256=${await hmacSha256Hex(secret, rawBody)}`;
	if (!constantTimeEqual(expected, signature)) {
		return new Response('Invalid signature', { status: 401 });
	}
	return new Response('OK', { status: 200 });
});

export async function twilioInline(request: Request, rawBody: string): Promise<Response> {
	// ok: webhook-signature-presence-only
	const signature = request.headers.get('x-twilio-signature');
	if (!signature) {
		return new Response('Missing X-Twilio-Signature header', { status: 401 });
	}
	try {
		const expected = await hmacSha1Base64(authToken, rawBody);
		const valid = secretMatches(signature, expected);
		if (!valid) return new Response('Invalid signature', { status: 401 });
	} catch {
		return new Response('Unverifiable', { status: 401 });
	}
	return new Response('OK', { status: 200 });
}

export const webCryptoInline = async (request: Request, key: CryptoKey, rawBody: string) => {
	// ok: webhook-signature-presence-only
	const sig = request.headers.get('x-hub-signature-256');
	if (!sig) return new Response('Missing signature', { status: 401 });
	const ok = await crypto.subtle.verify('HMAC', key, hexToBytes(sig), encode(rawBody));
	return new Response(ok ? 'OK' : 'Invalid', { status: ok ? 200 : 401 });
};

// ── Helper verification: the shape of the three real handlers ──────────

export const handleGithubWebhook = httpAction(async (ctx, request) => {
	// ok: webhook-signature-presence-only
	const signature = request.headers.get('x-hub-signature-256');
	if (!signature) {
		return new Response('Missing X-Hub-Signature-256 header', { status: 401 });
	}
	const rawBody = await readBodyText(request, 5 * 1024 * 1024);
	if (!(await verifyGithubSignature(rawBody, signature, secret))) {
		return new Response('Invalid GitHub signature', { status: 401 });
	}
	return new Response('OK', { status: 200 });
});

export const twilioAdapter: InboundAdapter = {
	source: 'twilio',

	// ok: webhook-signature-presence-only
	missingSignatureHeaders: (request) =>
		request.headers.get('x-twilio-signature') ? null : 'Missing X-Twilio-Signature header',

	async verifySignature(request, rawBody, ctx) {
		const authToken = await resolveChannelInboundSecret('sms', 'signature', 'TOKEN', ctx);
		if (!authToken) {
			return missingChannelSecretResult('TOKEN', 'SMS channel Auth Token');
		}

		// ok: webhook-signature-presence-only
		const signature = request.headers.get('x-twilio-signature');
		if (!signature) {
			return { ok: false, status: 401, reason: 'Missing X-Twilio-Signature header' };
		}

		const valid = await verifyTwilioRequest(request.url, rawBody, signature, authToken);
		if (!valid) {
			return { ok: false, status: 401, reason: 'Invalid Twilio signature' };
		}

		return { ok: true };
	},
};

export const metaAdapter: InboundAdapter = {
	source: 'meta',

	async verifySignature(request, rawBody, ctx) {
		// ok: webhook-signature-presence-only
		const signature = request.headers.get('x-hub-signature-256');
		if (!signature) {
			return { ok: false, status: 401, reason: 'Missing X-Hub-Signature-256 header' };
		}

		const valid = await verifyMetaSignature(rawBody, signature, appSecret);
		if (!valid) {
			return { ok: false, status: 401, reason: 'Invalid Meta signature' };
		}

		return { ok: true };
	},
};

// A method call on a verifier object counts too.
export async function registryVerified(request: Request, rawBody: string, verifier: Verifier) {
	// ok: webhook-signature-presence-only
	const signature = request.headers.get('x-provider-signature');
	if (!signature) return new Response('Missing signature', { status: 401 });
	const result = await verifier.verifyRequest(rawBody, signature);
	return new Response(result.ok ? 'OK' : 'Invalid', { status: result.ok ? 200 : 401 });
}

// Reading a non-signature header and checking presence is not this rule's concern.
export async function eventTypeOnly(request: Request) {
	// ok: webhook-signature-presence-only
	const eventType = request.headers.get('x-github-event');
	if (!eventType) return new Response('Missing event', { status: 400 });
	return new Response('OK', { status: 200 });
}
