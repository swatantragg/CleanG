// CI gate: fail on any high/critical npm advisory EXCEPT a documented allowlist.
// Reads `audit.json` (produced by `npm audit --json`) from the working directory.
//
// An allowlist entry is only justified when BOTH hold:
//   (a) no fixed version exists, and
//   (b) the advisory does not apply to how this app uses the package.
// Revisit each entry whenever dependencies are bumped — drop it once a fix ships.
import { readFileSync } from "node:fs";

const ALLOW = new Map([
  // react-router "RSC Mode CSRF Bypass". This is a client-only SPA (BrowserRouter,
  // no server / React Server Components / server actions), so the affected RSC
  // action path is never reachable. Every published react-router is flagged by
  // some advisory and the latest (7.18.1) has no fixed release for this one.
  ["GHSA-qwww-vcr4-c8h2", "react-router RSC-mode CSRF — N/A to a client SPA, no fix released"],
]);

const BLOCK_SEVERITY = new Set(["high", "critical"]);
const ghsa = (url) => (url || "").split("/").pop();

let report;
try {
  report = JSON.parse(readFileSync("audit.json", "utf8"));
} catch (e) {
  console.error(`audit-gate: cannot read audit.json — ${e.message}`);
  process.exit(2);
}

// Collect the distinct advisories behind every vulnerability (a `via` entry is
// either another package name (string) or an advisory object with a url).
const advisories = new Map();
for (const vuln of Object.values(report.vulnerabilities || {})) {
  for (const via of vuln.via || []) {
    if (via && typeof via === "object" && via.url) advisories.set(via.url, via);
  }
}

const severe = [...advisories.values()].filter((a) => BLOCK_SEVERITY.has(a.severity));
const waived = severe.filter((a) => ALLOW.has(ghsa(a.url)));
const blocking = severe.filter((a) => !ALLOW.has(ghsa(a.url)));

for (const a of waived) {
  console.log(`allowlisted: ${ghsa(a.url)} — ${ALLOW.get(ghsa(a.url))}`);
}

if (blocking.length) {
  console.error(`\naudit-gate: ${blocking.length} high/critical advisory(ies) not allowlisted:`);
  for (const a of blocking) console.error(`  - ${ghsa(a.url)} [${a.severity}] ${a.title}`);
  console.error(
    "\nUpgrade to a fixed version. Only if there is no fix AND it cannot affect this app," +
      " add the GHSA id to ALLOW in scripts/audit-gate.mjs with a justification."
  );
  process.exit(1);
}

console.log(`\naudit-gate: OK — ${waived.length} allowlisted, 0 blocking high/critical advisories.`);
