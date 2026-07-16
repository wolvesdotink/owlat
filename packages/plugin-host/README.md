# `@owlat/plugin-host`

Owlat's private, runtime-neutral plugin enforcement kernel. It sits outside
Convex and Nuxt so both composition targets apply the same capability,
enablement, gate, untrusted-text, and ordering rules.

This package only executes handlers that the build has statically composed.
It is not a runtime module loader and does not expose framework contexts.
Consumer-specific contribution interfaces and registry wiring belong to the
piece that opens each consumer seam.

For agent steps, the host owns the canonical six built-in placements and
validates every bundled insertion graph before code generation. Plugin chains
inherit their anchor's continuation status; only host-approved caution edges
are accepted. The core state machine is never merged with plugin declarations.
