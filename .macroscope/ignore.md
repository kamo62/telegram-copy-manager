# Macroscope ignore patterns

Note: creating this file REPLACES Macroscope's built-in defaults rather than
extending them, so the common defaults are restated below.

The corpus fixture is a verbatim 1,945-message snapshot of live provider
traffic held as a single JSON string. It is test data, not logic, and at ~493KB
it alone pushed a review past the workspace cost limit, which is why PR #10 was
skipped entirely.

apps/api/src/fixtures/provider-messages.ts

# Defaults
**/node_modules/**
**/dist/**
**/build/**
**/*.lock
**/*.lockb
**/bun.lock
**/package-lock.json
