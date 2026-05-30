# [2.0.0](https://github.com/antonbabenko/claude-delegator/compare/v1.18.0...v2.0.0) (2026-05-30)


### BREAKING CHANGES

* The plugin is renamed `claude-delegator` -> `deliberation`. The plugin name, slash namespace (`/deliberation:*`), config path (`~/.claude/deliberation/config.json`), Grok cache, rules dir (`~/.claude/rules/deliberation/`), and the four bridge MCP servers (`deliberation-codex`, `deliberation-gemini`, `deliberation-grok`, `deliberation-openrouter`) all change. 1.x backward-compat is removed: no legacy config-path fallback, no `CLAUDE_DELEGATOR_CONFIG` env, no dual-path globs. See the README "Upgrade from 1.x" section for the one-time migration.


### Features

* **core:** extract a host-neutral `core/` library (provider adapters, `askAll` fan-out, single-round `consensus`, per-alias OpenRouter expansion, `DelegationResult` union) and a unified stdio MCP server (`server/mcp`), plus a strict `tsc --checkJs` typecheck gate
* **plugin:** rebrand to `deliberation`, namespace the four bridge MCP servers, add a host-neutral description


### Bug Fixes

* **openrouter:** move delegate selection and dispatch server-side so a disabled alias can never be dispatched from a stale client-side selection
* **setup:** collapse setup into one idempotent Bash call; isolate uninstall removal
* **release:** switch the release preset from `angular` to `conventionalcommits` so `feat!:` / `BREAKING CHANGE:` commits bump major automatically



# [1.18.0](https://github.com/antonbabenko/claude-delegator/compare/v1.17.0...v1.18.0) (2026-05-30)


### Features

* **openrouter:** add server-side delegate selection to openrouter-list ([#48](https://github.com/antonbabenko/claude-delegator/issues/48)) ([0ee7796](https://github.com/antonbabenko/claude-delegator/commit/0ee7796b80099829345f33a292b702e148ed6228))



# [1.17.0](https://github.com/antonbabenko/claude-delegator/compare/v1.16.1...v1.17.0) (2026-05-30)


### Features

* **openrouter:** add OpenRouter as a config-driven advisory provider ([#40](https://github.com/antonbabenko/claude-delegator/issues/40)) ([51bff5b](https://github.com/antonbabenko/claude-delegator/commit/51bff5b79e16d77e155f95fa8a0820a712bd7316))



## [1.16.1](https://github.com/antonbabenko/claude-delegator/compare/v1.16.0...v1.16.1) (2026-05-29)


### Bug Fixes

* **codex:** inherit model from ~/.codex/config.toml instead of hardcoding ([#37](https://github.com/antonbabenko/claude-delegator/issues/37)) ([c06ba37](https://github.com/antonbabenko/claude-delegator/commit/c06ba375ef2a99cf5cbd84b7cdab129772821629))



# [1.16.0](https://github.com/antonbabenko/claude-delegator/compare/v1.15.2...v1.16.0) (2026-05-28)


### Features

* **consensus:** add llm-council Stage 2 blind cross-review ([#35](https://github.com/antonbabenko/claude-delegator/issues/35)) ([55229d9](https://github.com/antonbabenko/claude-delegator/commit/55229d9b6a43ee1c15899a712cc11c689f92edbb))



## [1.15.2](https://github.com/antonbabenko/claude-delegator/compare/v1.15.1...v1.15.2) (2026-05-28)


### Bug Fixes

* **setup:** quote ${CLAUDE_PLUGIN_ROOT} so MCP bridges resolve current plugin version per spawn ([#33](https://github.com/antonbabenko/claude-delegator/issues/33)) ([ed7ba2f](https://github.com/antonbabenko/claude-delegator/commit/ed7ba2f14bced0105d7b5f1b51152a90ba73f963))



