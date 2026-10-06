// Rule test for webhook-signature-read-outside-verifier: header names that
// do not contain the word, with the word next to the literal (in a comment,
// an `as` / `satisfies` type, an angle-bracket cast) or around it in
// parentheses. Only the literal's content is checked, so none is reported.
// The last function is the control: the same shapes around a signature name
// are reported. Run with
//   semgrep --test --config .semgrep.yml .semgrep/tests/read-forms/not-signature-names.ts

type SignatureHeader = string;

// prettier-ignore
export function names(req, get) {
	// ok: webhook-signature-read-outside-verifier
	const n_0_0 = req.headers.get('x-event' as SignatureHeader);
	// ok: webhook-signature-read-outside-verifier
	const n_0_1 = req.headers.get(('x-event' as SignatureHeader));
	// ok: webhook-signature-read-outside-verifier
	const n_0_2 = req.headers.get(<SignatureHeader>'x-event');
	// ok: webhook-signature-read-outside-verifier
	const n_0_3 = req.headers.get('x-event' /* signature */);
	// ok: webhook-signature-read-outside-verifier
	const n_0_4 = req.headers.get(('x-event' /* signature */));
	// ok: webhook-signature-read-outside-verifier
	const n_0_5 = req.headers.get('x-event' as 'x-signature');
	// ok: webhook-signature-read-outside-verifier
	const n_0_6 = req.headers.get('x-event' as string);
	// ok: webhook-signature-read-outside-verifier
	const n_0_7 = req.headers.get('x-event' satisfies SignatureHeader);
	// ok: webhook-signature-read-outside-verifier
	const n_0_8 = req.headers.get('x-event'!);
	// ok: webhook-signature-read-outside-verifier
	const n_1_0 = get('x-event' as SignatureHeader);
	// ok: webhook-signature-read-outside-verifier
	const n_1_1 = get(('x-event' as SignatureHeader));
	// ok: webhook-signature-read-outside-verifier
	const n_1_2 = get(<SignatureHeader>'x-event');
	// ok: webhook-signature-read-outside-verifier
	const n_1_3 = get('x-event' /* signature */);
	// ok: webhook-signature-read-outside-verifier
	const n_1_4 = get(('x-event' /* signature */));
	// ok: webhook-signature-read-outside-verifier
	const n_1_5 = get('x-event' as 'x-signature');
	// ok: webhook-signature-read-outside-verifier
	const n_1_6 = get('x-event' as string);
	// ok: webhook-signature-read-outside-verifier
	const n_1_7 = get('x-event' satisfies SignatureHeader);
	// ok: webhook-signature-read-outside-verifier
	const n_1_8 = get('x-event'!);
	// ok: webhook-signature-read-outside-verifier
	const n_2_0 = req.headers['x-event' as SignatureHeader];
	// ok: webhook-signature-read-outside-verifier
	const n_2_1 = req.headers[('x-event' as SignatureHeader)];
	// ok: webhook-signature-read-outside-verifier
	const n_2_2 = req.headers[<SignatureHeader>'x-event'];
	// ok: webhook-signature-read-outside-verifier
	const n_2_3 = req.headers['x-event' /* signature */];
	// ok: webhook-signature-read-outside-verifier
	const n_2_4 = req.headers[('x-event' /* signature */)];
	// ok: webhook-signature-read-outside-verifier
	const n_2_5 = req.headers['x-event' as 'x-signature'];
	// ok: webhook-signature-read-outside-verifier
	const n_2_6 = req.headers['x-event' as string];
	// ok: webhook-signature-read-outside-verifier
	const n_2_7 = req.headers['x-event' satisfies SignatureHeader];
	// ok: webhook-signature-read-outside-verifier
	const n_2_8 = req.headers['x-event'!];
}

// prettier-ignore
export function signatureNames(req, get) {
	// ruleid: webhook-signature-read-outside-verifier
	const s_0 = req.headers.get(('x-signature' /* checked */));
	// ruleid: webhook-signature-read-outside-verifier
	const s_1 = get('x-signature' as SignatureHeader);
	// ruleid: webhook-signature-read-outside-verifier
	const s_2 = req.headers['x-signature' satisfies SignatureHeader];
	// ruleid: webhook-signature-read-outside-verifier
	const s_3 = req.headers.get('x-signature' satisfies SignatureHeader);
	// ruleid: webhook-signature-read-outside-verifier
	const s_4 = get('x-signature'!);
	// ruleid: webhook-signature-read-outside-verifier
	const s_5 = req.headers['x-signature'!];
}
