/**
 * Keeps the skill's game templates asking for the engine being released.
 *
 * Both templates' package.json asked for `^0.1.0` from 0.1.0 to 0.7.3. On a
 * 0.x version a caret admits only the same minor, so a game scaffolded from
 * them installed a 0.1 engine that predates everything the templates use.
 * Writing the range by hand fixes it once and leaves it to go stale at the
 * next minor; listing the files in bumpFiles makes every release commit
 * write `^<version>` itself.
 *
 * It rewrites the one string in place rather than re-serialising the JSON,
 * so the file's formatting is left as it was.
 *
 * CommonJS because commit-and-tag-version loads an updater with require, and
 * the workspace is "type": "module".
 */

const PATTERN = /("@clockwork2\/engine":\s*")\^([^"]+)(")/

function first(contents) {
  const match = PATTERN.exec(contents)
  if (match === null) {
    throw new Error(
      'no `"@clockwork2/engine": "^..."` in a template package.json; if the ' +
        "template stopped depending on the engine, drop it from bumpFiles",
    )
  }
  return match[2]
}

module.exports.readVersion = (contents) => first(contents)

module.exports.writeVersion = (contents, version) => {
  first(contents)
  return contents.replace(PATTERN, `$1^${version}$3`)
}
