import { startProxy, stopProxy, post, check, summary } from "./_helpers.mjs";

const PORT = 19892;
const proxy = await startProxy(PORT);
const valid = { model: "test", messages: [{ role: "user", content: "hi" }] };

const auth = (key, headers = {}) => post(PORT, {
  body: valid,
  headers: { ...(key !== undefined ? { Authorization: `Bearer ${key}` } : {}), ...headers },
});

check("missing auth → 401", (await auth(undefined, { Authorization: null })).status === 401);
check("wrong key → 401", (await auth("nope")).status === 401);
check("empty key → 401", (await auth("")).status === 401);
check("X-Api-Key header honored", (await auth(undefined, { "X-Api-Key": "pen-test-key" })).status !== 401);

await stopProxy(proxy);
summary();
