// Zero-dependency, side-effect-free defaults. No imports, no process.env reads
// at module scope — importing this file must be free so tests, the CLI and the
// entrypoints can all share one source of truth for every magic number.
// Env overrides still win at runtime (see loadConfig in core.js).

// User-facing proxy ports — keep these in the 1879x range.
export const DEFAULT_PORTS = Object.freeze({ openai: 18791, anthropic: 18792 });

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PROXY_KEY = "mewmew";

// External contract: must match the AutoClaw desktop app's gateway.
export const LOCAL_GATEWAY_HOST = "127.0.0.1";
export const LOCAL_GATEWAY_PORT = 18789;

// Test-infrastructure ports, kept out of the user-facing 1879x range.
export const TEST_PROXY_PORT = 19799; // --test-models child proxy
export const PEN_TEST_PORTS = Object.freeze({ p1: 19891, p2: 19892, p3: 19893, p4: 19894, p5: 19895 });
