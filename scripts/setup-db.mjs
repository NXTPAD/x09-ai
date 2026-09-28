// Cloudflare build step: finds (or creates) the x09-db D1 database and writes its ID
// into wrangler.toml, so no one has to paste IDs by hand. Safe to run on every build.
import { execSync } from "node:child_process";
import fs from "node:fs";

const NAME = "x09-db"; // the shared X09 database (same one X09 AI and X09 Hub use)
const FILE = fs.existsSync("wrangler.jsonc") ? "wrangler.jsonc" : "wrangler.toml";
const toml = fs.readFileSync(FILE, "utf8");
if (!toml.includes("PASTE_YOUR_D1_DATABASE_ID")) { console.log(`${FILE} already has a database ID.`); process.exit(0); }

const run = (cmd) => execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const find = () => {
  const out = run("npx wrangler d1 list --json");
  const list = JSON.parse(out.slice(out.indexOf("[")));
  return list.find((d) => d.name === NAME)?.uuid || "";
};

let id = find();
if (!id) { console.log(`${NAME} not found — creating it`); run(`npx wrangler d1 create ${NAME}`); id = find(); }
if (!id) { console.error(`Could not find or create ${NAME}`); process.exit(1); }
fs.writeFileSync(FILE, toml.replace("PASTE_YOUR_D1_DATABASE_ID", id));
console.log(`Using D1 database ${NAME} (${id})`);
