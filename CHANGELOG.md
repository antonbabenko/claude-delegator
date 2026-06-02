## [3.3.0](https://github.com/antonbabenko/deliberation/compare/v3.2.0...v3.3.0) (2026-06-02)


### Features

* single-source command fallbacks + capability-gate expert personas ([#119](https://github.com/antonbabenko/deliberation/issues/119)) ([ba5b5ba](https://github.com/antonbabenko/deliberation/commit/ba5b5ba319bea61161075027618ca16731f81deb))

## [3.2.0](https://github.com/antonbabenko/deliberation/compare/v3.1.1...v3.2.0) (2026-06-02)


### Features

* performance observability + per-provider progress for ask-all/consensus ([#117](https://github.com/antonbabenko/deliberation/issues/117)) ([a4e1617](https://github.com/antonbabenko/deliberation/commit/a4e161730e971e2a84c2ed083267e8a9c0b6a23c)), closes [#8](https://github.com/antonbabenko/deliberation/issues/8)

## [3.1.1](https://github.com/antonbabenko/deliberation/compare/v3.1.0...v3.1.1) (2026-06-01)


### Bug Fixes

* pin mcp-publisher asset name in the registry publish step ([#115](https://github.com/antonbabenko/deliberation/issues/115)) ([78e5d05](https://github.com/antonbabenko/deliberation/commit/78e5d05412d61f15e0b8c7a160923368384c017c))

## [3.1.0](https://github.com/antonbabenko/deliberation/compare/v3.0.0...v3.1.0) (2026-06-01)


### Features

* auto-publish on release, npm README, per-tenant key seam (extras A) ([#113](https://github.com/antonbabenko/deliberation/issues/113)) ([bf0355b](https://github.com/antonbabenko/deliberation/commit/bf0355b43703d27e7376493b37c58b52e8074a27))

## [3.0.0](https://github.com/antonbabenko/deliberation/compare/v2.18.0...v3.0.0) (2026-06-01)


### ⚠ BREAKING CHANGES

* the `consensus-auto` MCP tool is removed (folded into `consensus`, which
now runs the loop by default); the one-shot `consensus` behavior moves behind
`synthesizeAlways:true`. Session `schemaVersion` is 1 (no v2 reader); records written
before this change are not supported by session-revisit.

### Features

* unify consensus tools into one + drop schema versioning ([#111](https://github.com/antonbabenko/deliberation/issues/111)) ([6974bb9](https://github.com/antonbabenko/deliberation/commit/6974bb908e9a07dfbe0ac36703161b70b24461fc))

