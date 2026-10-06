// Rule test for webhook-signature-presence-only: the file gate must admit
// this read form (multiline args). One form per file, so no other read
// can let the file through. Run with
//   semgrep --test --config .semgrep.yml .semgrep/tests/gate/multiline-args.ts

// prettier-ignore
export function multilineArgs(req, expected) {
	// ruleid: webhook-signature-presence-only
	const sig = req.headers.get(
	'X-SIGNATURE'
	);
	if (!sig) return 401;
	return 200;
}
