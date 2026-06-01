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

## [2.18.0](https://github.com/antonbabenko/deliberation/compare/v2.17.0...v2.18.0) (2026-06-01)


### Features

* rewrite /consensus as a thin driver over consensus-step ([#108](https://github.com/antonbabenko/deliberation/issues/108)) ([243d093](https://github.com/antonbabenko/deliberation/commit/243d09334735288b62389429e7efd64efbb8713d))

## [2.17.0](https://github.com/antonbabenko/deliberation/compare/v2.16.0...v2.17.0) (2026-06-01)


### Features

* persist consensus-auto runs + route session-revisit (PR2b-4b) ([#106](https://github.com/antonbabenko/deliberation/issues/106)) ([8d6d3d5](https://github.com/antonbabenko/deliberation/commit/8d6d3d52fd64dccca5c2000988b8568c8c4f50c4))

