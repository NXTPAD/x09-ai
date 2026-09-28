// Local test server for X09 AI (mock AI + mock Stripe + in-memory shared database).
//   node --experimental-sqlite test/dev-server.mjs   → http://localhost:8787
import path from "node:path";
import worker from "../src/worker.js";
import { makeHarness } from "./harness.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
export const { server, env, stripeCalls, sqlite, activate, PORT } = makeHarness(worker, ROOT);

if (process.argv[1] && process.argv[1].endsWith("dev-server.mjs")) {
  server.listen(PORT, () => console.log(`X09 AI test server on http://localhost:${PORT}`));
}
