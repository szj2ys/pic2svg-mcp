/**
 * Is pic2svg-mcp ready to publish? Exits 1 with every reason it is not.
 *
 *   node scripts/check-release.mjs        (also runs before `npm publish`)
 *
 * Two answers only the maintainers can give live in package.json and keep
 * this check failing until they are given:
 *  - "license": "UNLICENSED" is the placeholder. Choose the licence the
 *    package is released under (and add its LICENSE file).
 *  - "private": true keeps npm from publishing it. Remove it when the server
 *    side (POST /api/v1/trace) is deployed and the package should go out.
 * The site's own launch check (scripts/check-launch-config.mjs) reads the same
 * "private" flag, because /mcp tells visitors to run `npx pic2svg-mcp`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const problems = [];
const need = (ok, message) => ok || problems.push(message);

need(/^[a-z0-9-]+$/.test(pkg.name ?? ""), "package.json needs a valid name");
need(/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(pkg.version ?? ""), "package.json needs a semver version");
need(typeof pkg.description === "string" && pkg.description.length > 20, "package.json needs a description");
need(pkg.engines?.node, "package.json needs engines.node");
for (const [name, target] of Object.entries(pkg.bin ?? {})) {
  need(existsSync(join(ROOT, target)), `bin ${name} points at a missing file: ${target}`);
  const head = existsSync(join(ROOT, target)) ? readFileSync(join(ROOT, target), "utf8").split(/\r?\n/)[0] : "";
  need(head === "#!/usr/bin/env node", `bin ${name} must start with "#!/usr/bin/env node"`);
}
for (const file of pkg.files ?? []) need(existsSync(join(ROOT, file)), `files lists a missing file: ${file}`);
need(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0, "the package is meant to have no runtime dependencies");

// Placeholders that need a maintainer decision.
need(pkg.license && pkg.license !== "UNLICENSED", 'choose a licence: package.json "license" is still the placeholder "UNLICENSED"');
need(pkg.license === "UNLICENSED" || existsSync(join(ROOT, "LICENSE")), "add the LICENSE file for the chosen licence");
need(pkg.private !== true, 'package.json "private": true still blocks publishing (remove it once /api/v1/trace is deployed)');

// What npm would actually ship.
try {
  const out = execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["pack", "--dry-run", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    shell: process.platform === "win32",
  });
  const shipped = JSON.parse(out)[0].files.map((f) => f.path).sort();
  for (const file of pkg.files ?? []) need(shipped.includes(file), `npm pack would not ship ${file}`);
  need(!shipped.some((f) => f.endsWith(".test.mjs")), "npm pack would ship test files");
  console.log(`npm pack --dry-run: ${shipped.join(", ")}`);
} catch (e) {
  problems.push(`npm pack --dry-run failed: ${e.message.split("\n")[0]}`);
}

if (problems.length) {
  console.error(`pic2svg-mcp is not ready to publish:\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}
console.log(`pic2svg-mcp ${pkg.version} is ready to publish.`);
