#!/usr/bin/env bash
set -euo pipefail
root=$(pwd)
consumer=$(mktemp -d)
trap 'rm -rf "$consumer"' EXIT
bun run --cwd packages/health-code build
npm_config_cache="$consumer/npm-cache" npm pack ./packages/health-code --ignore-scripts --silent --pack-destination "$consumer" >/dev/null
cd "$consumer"
archive=$(basename ./*.tgz)
tar -tf "$archive" | awk '/^package\/(test|src|fixtures|guest|scripts|\.tsbuild)\// { bad=1 } END {exit bad}'
# Give the tarball exactly the dependency graph installed by the frozen workspace.
mkdir -p node_modules/health-code
tar -xf "$archive" -C node_modules/health-code --strip-components=1
node --input-type=module - "$root" <<'JS'
import {mkdirSync,readFileSync,realpathSync,symlinkSync} from "node:fs"
import {dirname,join} from "node:path"
const library = "node_modules/health-code"
const manifest = JSON.parse(readFileSync(join(library, "package.json"), "utf8"))
for (const name of Object.keys(manifest.dependencies)) {
  const target = join(library, "node_modules", name)
  mkdirSync(dirname(target), {recursive:true})
  symlinkSync(realpathSync(join(process.argv[2], "packages/health-code/node_modules", name)), target, "dir")
}
JS
echo '{"private":true,"type":"module"}' > package.json
cat > consumer.mjs <<'JS'
import assert from "node:assert/strict"
import { createFakeSandboxProvider, inspectRepository } from "health-code"
import { readFileSync } from "node:fs"
const sandboxProvider = createFakeSandboxProvider(JSON.parse(readFileSync("fixture.json", "utf8")))
const card = await inspectRepository({repositoryUrl:"https://github.com/example/project",sandboxProvider})
assert.equal(card.version,1)
assert.equal(card.baseline.install.status,"passed")
assert.equal(card.timeline.at(-1).type,"inspection.finished")
JS
# Exercise the guest bundles without workspace module resolution.
mkdir -p standalone/project
cp node_modules/health-code/dist/{guest,observe}.mjs standalone/
cp "$root/packages/health-code/test/fixtures/recorded/npm/"{package.json,package-lock.json} standalone/project/
(cd standalone/project && node ../guest.mjs detect | node -e 'const data=JSON.parse(require("node:fs").readFileSync(0));if(data.manager!=="npm"||data.sources.widget["."]!=="1.2.0")process.exit(1)')
cp "$root/scripts/fixtures/recorded/inspection.json" fixture.json
node consumer.mjs
bun consumer.mjs
cat > consumer.ts <<'TS'
import { inspectRepository, type InspectionOptions, type ReportCard } from "health-code"
export function inspect(options: InspectionOptions): Promise<ReportCard> {
  return inspectRepository(options)
}
TS
"$root/node_modules/.bin/tsc" --strict --noEmit --module nodenext --target es2022 consumer.ts
