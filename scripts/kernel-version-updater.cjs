/**
 * Keeps KERNEL_VERSION in step with the kernel's package.json.
 *
 * `packages/engine/src/index.ts` declares the constant by hand, and that
 * constant is written into every Recording.kernelVersion and every frame
 * handshake. It was not in .versionrc.json's bumpFiles, so the next release
 * would have bumped the package and left the constant behind, and every
 * recording stored after that would have claimed a kernel version that did not
 * produce it. Nothing would have reported it.
 *
 * CommonJS because commit-and-tag-version loads an updater with require, and
 * the workspace is "type": "module".
 */

const PATTERN = /(export const KERNEL_VERSION = ")([^"]+)(")/

module.exports.readVersion = (contents) => {
  const match = PATTERN.exec(contents)
  if (match === null) {
    throw new Error(
      'no `export const KERNEL_VERSION = "..."` in the kernel\'s index.ts',
    )
  }
  return match[2]
}

module.exports.writeVersion = (contents, version) => {
  if (!PATTERN.test(contents)) {
    throw new Error(
      'no `export const KERNEL_VERSION = "..."` in the kernel\'s index.ts',
    )
  }
  return contents.replace(PATTERN, `$1${version}$3`)
}
