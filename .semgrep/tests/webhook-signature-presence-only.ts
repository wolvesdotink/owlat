// Semgrep rule test for `webhook-signature-presence-only` in .semgrep.yml.
// Never imported or compiled: `semgrep --test` reads the annotations below.
// A "ruleid" annotation marks a line the rule must report, an "ok" annotation
// a line it must not.
// Run from the repo root:
//
//   semgrep --test --config .semgrep.yml .semgrep/tests/webhook-signature-presence-only.ts
//
// The verifying shapes copy the real handlers: webhooks/githubHttp.ts,
// webhooks/adapters/twilio.ts, webhooks/adapters/meta.ts and the Svix arm of
// plugins/inboundSignature.ts.

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

export function nodeBracketPresenceOnly(req: IncomingMessage): number {
	// ruleid: webhook-signature-presence-only
	const signature = req.headers['x-hub-signature-256'];
	if (signature === undefined) return 401;
	return 200;
}

export async function detachedGetPresenceOnly(delivery: Delivery) {
	const { headers } = delivery;
	// ruleid: webhook-signature-presence-only
	const signature = headers.get('svix-signature');
	if (signature === null || signature === '') return { ok: false };
	return { ok: true };
}

// ── A verifier is called, but not on the header, or its result is unused ──

export const verifiesSomethingElse = httpAction(async (ctx, request) => {
	// ruleid: webhook-signature-presence-only
	const signature = request.headers.get('x-hub-signature-256');
	if (!signature) return new Response('Missing signature', { status: 401 });
	if (!(await verifyUser(request.headers.get('authorization')))) {
		return new Response('Unauthorized', { status: 401 });
	}
	return new Response('OK', { status: 200 });
});

export const verifierGetsOtherValue = httpAction(async (ctx, request) => {
	// ruleid: webhook-signature-presence-only
	const signature = request.headers.get('x-hub-signature-256');
	if (!signature) return new Response('Missing signature', { status: 401 });
	const rawBody = await request.text();
	if (!(await verifyGithubSignature(rawBody, request.headers.get('x-github-event'), secret))) {
		return new Response('Invalid signature', { status: 401 });
	}
	return new Response('OK', { status: 200 });
});

export const unawaitedVerifier = httpAction(async (ctx, request) => {
	// ruleid: webhook-signature-presence-only
	const signature = request.headers.get('x-hub-signature-256');
	if (!signature) return new Response('Missing signature', { status: 401 });
	const rawBody = await request.text();
	// A Promise is always truthy, so this never rejects.
	if (!verifyGithubSignature(rawBody, signature, secret)) {
		return new Response('Invalid signature', { status: 401 });
	}
	return new Response('OK', { status: 200 });
});

export const unusedNestedVerifier = httpAction(async (ctx, request) => {
	// ruleid: webhook-signature-presence-only
	const signature = request.headers.get('x-hub-signature-256');
	if (!signature) return new Response('Missing signature', { status: 401 });
	const rawBody = await request.text();
	const check = async () => {
		if (!(await verifyGithubSignature(rawBody, signature, secret))) {
			throw new Error('Invalid signature');
		}
	};
	return new Response('OK', { status: 200 });
});

export async function resultNeverTested(request: Request, rawBody: string) {
	// ruleid: webhook-signature-presence-only
	const signature = request.headers.get('x-twilio-signature');
	if (!signature) return new Response('Missing signature', { status: 401 });
	const valid = await verifyTwilioRequest(request.url, rawBody, signature, authToken);
	return new Response('OK', { status: 200 });
}

// A verification nested in a branch or a try block may not run, so it does
// not count.
export async function verifiedOnlyInBranch(request: Request, rawBody: string) {
	// ruleid: webhook-signature-presence-only
	const signature = request.headers.get('x-hub-signature-256');
	if (!signature) return new Response('Missing signature', { status: 401 });
	if (strictMode) {
		if (!(await verifyMetaSignature(rawBody, signature, appSecret))) {
			return new Response('Invalid signature', { status: 401 });
		}
	}
	return new Response('OK', { status: 200 });
}

export async function verifiedOnlyInTry(request: Request, rawBody: string) {
	// ruleid: webhook-signature-presence-only
	const signature = request.headers.get('x-hub-signature-256');
	if (!signature) return new Response('Missing signature', { status: 401 });
	try {
		if (!(await verifyMetaSignature(rawBody, signature, appSecret))) {
			return new Response('Invalid signature', { status: 401 });
		}
	} catch {
		// swallowed: the request goes on unverified
	}
	return new Response('OK', { status: 200 });
}

// ── Inline verification: a compare in the handler itself ────────────────

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

// The compare takes a value derived from the header, through a variable.
export async function derivedInline(request: Request, rawBody: string): Promise<Response> {
	// ok: webhook-signature-presence-only
	const signature = request.headers.get('x-hub-signature-256');
	if (!signature) return new Response('Missing signature', { status: 401 });
	const provided = signature.slice('sha256='.length);
	const valid = secretMatches(provided, await hmacSha256Hex(secret, rawBody));
	if (!valid) return new Response('Invalid signature', { status: 401 });
	return new Response('OK', { status: 200 });
}

export const webCryptoInline = async (request: Request, key: CryptoKey, rawBody: string) => {
	// ok: webhook-signature-presence-only
	const sig = request.headers.get('x-hub-signature-256');
	if (!sig) return new Response('Missing signature', { status: 401 });
	const ok = await crypto.subtle.verify('HMAC', key, hexToBytes(sig), encode(rawBody));
	if (!ok) return new Response('Invalid signature', { status: 401 });
	return new Response('OK', { status: 200 });
};

export function nodeBracketInline(req: IncomingMessage, expected: Buffer): number {
	// ok: webhook-signature-presence-only
	const signature = req.headers['x-hub-signature-256'];
	if (!signature) return 401;
	if (!crypto.timingSafeEqual(Buffer.from(signature), expected)) return 401;
	return 200;
}

// ── Helper verification: the shape of the real handlers ─────────────────

export const handleGithubWebhook = httpAction(async (ctx, request) => {
	// ok: webhook-signature-presence-only
	const signature = request.headers.get('x-hub-signature-256');
	if (!signature) {
		return new Response('Missing X-Hub-Signature-256 header', { status: 401 });
	}
	let rawBody: string;
	try {
		rawBody = await readBodyText(request, 5 * 1024 * 1024);
	} catch (error) {
		return new Response('Unreadable body', { status: 400 });
	}
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

export async function verifyPluginSvixDelivery(delivery: Delivery, contract: Contract) {
	const { headers, nowMs } = delivery;
	const id = headers.get('svix-id');
	const timestamp = headers.get('svix-timestamp');
	// ok: webhook-signature-presence-only
	const signature = headers.get('svix-signature');
	if (id === null || id === '' || signature === null || signature === '') {
		return { ok: false, status: 401, reason: 'Missing inbound signature' };
	}
	const verified = await verifySvixHeaders(
		delivery.rawBody,
		id,
		timestamp,
		signature,
		contract.secret,
		Math.floor(nowMs / 1000)
	);
	if (!verified) {
		return { ok: false, status: 401, reason: 'Inbound signature mismatch' };
	}
	return { ok: true };
}

// A method call on a verifier object, and a returned verdict, count too.
export async function registryVerified(request: Request, rawBody: string, verifier: Verifier) {
	// ok: webhook-signature-presence-only
	const signature = request.headers.get('x-provider-signature');
	if (!signature) return new Response('Missing signature', { status: 401 });
	const result = await verifier.verifyRequest(rawBody, signature);
	if (!result.ok) return new Response('Invalid signature', { status: 401 });
	return new Response('OK', { status: 200 });
}

export async function returnsVerdict(request: Request, rawBody: string): Promise<boolean> {
	// ok: webhook-signature-presence-only
	const signature = request.headers.get('x-hub-signature-256');
	if (!signature) return false;
	return await verifyGithubSignature(rawBody, signature, secret);
}

// Reading a non-signature header and checking presence is not this rule's concern.
export async function eventTypeOnly(request: Request) {
	// ok: webhook-signature-presence-only
	const eventType = request.headers.get('x-github-event');
	if (!eventType) return new Response('Missing event', { status: 400 });
	return new Response('OK', { status: 200 });
}
