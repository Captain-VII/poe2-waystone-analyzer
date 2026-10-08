// Sets the app version everywhere it lives and opens its CHANGELOG section.
// Usage: npm run bump -- 1.0.0      (or 1.0.0-beta.1)
//
// The version is repeated in five files; release.yml refuses a tag that
// doesn't match package.json and tauri.conf.json, and a stale lockfile is
// easy to miss by hand. This rewrites only the app's own version field in
// each file, then turns CHANGELOG.md's "## Unreleased" section into
// "## <version>" (keeping an empty "## Unreleased" above it).
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version ?? "")) {
  console.error("Usage: npm run bump -- <version>   e.g. 1.0.0 or 1.0.0-beta.1");
  process.exit(1);
}

function edit(path, transform) {
  const before = readFileSync(path, "utf8");
  const after = transform(before);
  if (after === before) throw new Error(`${path}: nothing changed, check its format`);
  writeFileSync(path, after);
  console.log(`updated ${path}`);
}

// Rewrites only the first `"version": "..."` occurrences (the app's own, at
// the top of each file), leaving the rest of the formatting untouched.
const jsonVersion = (path, occurrences) =>
  edit(path, (text) => {
    let left = occurrences;
    return text.replace(/("version":\s*)"[^"]*"/g, (m, key) => (left-- > 0 ? `${key}"${version}"` : m));
  });

jsonVersion("package.json", 1);
jsonVersion("package-lock.json", 2); // root + packages[""]
jsonVersion("src-tauri/tauri.conf.json", 1);
edit("src-tauri/Cargo.toml", (t) => t.replace(/^(name = "waystone-overlay"\r?\nversion = )"[^"]*"/m, `$1"${version}"`));
edit("src-tauri/Cargo.lock", (t) => t.replace(/^(name = "waystone-overlay"\r?\nversion = )"[^"]*"/m, `$1"${version}"`));
edit("CHANGELOG.md", (t) => {
  if (t.includes(`\n## ${version}\n`)) throw new Error(`CHANGELOG.md already has a ${version} section`);
  return t.replace(/^## Unreleased\r?\n/m, `## Unreleased\n\n## ${version}\n`);
});

console.log(`\nNow write the player-facing notes under "## ${version}" in CHANGELOG.md, then commit.`);
