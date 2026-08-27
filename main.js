#!/usr/bin/env node

/**
 * Backwards compatibility shim: main.js -> openai.js
 * In v2.0.0, main.js was renamed to openai.js to clarify format entrypoints.
 */

console.warn("[WARN] main.js is deprecated and will be removed in a future release. Please use openai.js or `npm start` instead.");

import("./openai.js");
