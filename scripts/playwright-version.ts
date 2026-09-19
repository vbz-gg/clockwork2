/**
 * Prints the pinned Playwright version. CI uses it as a browser cache key: if
 * the key does not move with the version, a version bump silently reuses stale
 * browsers and the job launches a binary Playwright did not ask for.
 */
import pkg from "../e2e/package.json" with { type: "json" }

const version = pkg.devDependencies["@playwright/test"]
if (!version) {
  console.error("e2e/package.json has no @playwright/test devDependency")
  process.exit(1)
}
console.log(version.replace(/^[^0-9]*/, ""))
