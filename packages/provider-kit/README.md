# @owlat/provider-kit

Runtime-neutral contracts for deterministic Owlat send-provider bundles.

The host assigns bundle provenance and owns authentication, retries, persistence,
and operator secrets. Provider code supplies bounded transport and semantic
modules; it cannot elevate its own trust.
