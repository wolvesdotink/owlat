// Rule test for webhook-signature-presence-only: the file gate must admit
// this read form (bracket space). One form per file, so no other read
// can let the file through. Run with
//   semgrep --test --config .semgrep.yml .semgrep/tests/gate/bracket-space.ts

// prettier-ignore
export function bracketSpace(req, expected) {
	// ruleid: webhook-signature-presence-only
	const sig = req.headers [
	"X-SIGNATURE"
	];
	if (!sig) return 401;
	return 200;
}
