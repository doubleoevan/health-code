#!/usr/bin/env bash
set -euo pipefail
# create a disposable consumer for the packed library
root=$(pwd)
consumer=$(mktemp -d)
trap 'rm -rf "$consumer"' EXIT
# pack the release and reject development-only directories
npm_config_cache="$consumer/npm-cache" npm pack ./packages/health-code --silent --pack-destination "$consumer" >/dev/null
cd "$consumer"
archive=$(basename ./*.tgz)
tar -tf "$archive" | awk '/^package\/(test|src|fixtures|guest|scripts|\.tsbuild)\// { bad=1 } END {exit bad}'
# Give the tarball exactly the dependency graph installed by the frozen workspace.
mkdir -p node_modules/health-code
tar -xf "$archive" -C node_modules/health-code --strip-components=1
# link the dependencies declared by the installed tarball
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
# exercise the public library from an independent consumer
echo '{"private":true,"type":"module"}' > package.json
cat > consumer.mjs <<'JS'
import assert from "node:assert/strict"
import { createFakeSandboxProvider, inspectRepository } from "health-code"
import { readFileSync } from "node:fs"
const sandboxProvider = createFakeSandboxProvider(JSON.parse(readFileSync("fixture.json", "utf8")))
const card = await inspectRepository({repositoryUrl:"https://github.com/example/project",sandboxProvider,callerModelExecution:"local",models:{fix:"legacy"}})
assert.equal(card.version,1)
assert.equal(card.baseline.install.status,"passed")
assert.equal(card.timeline.at(-1).type,"inspection.finished")
const pricing = {inputUsdPerMillion:1,outputUsdPerMillion:2,maxInputTokens:2048}
const host = {model:{modelId:"fixture",doGenerate(){throw Error("Unexpected model call")}},pricing}
const route = {protocol:"anthropic",modelId:"fixture",baseUrl:"https://model.example/v1",pricing,
  credential:{name:"fixture",header:"x-api-key",valueTemplate:"${credential}"}}
const recording = JSON.parse(readFileSync("fixture.json","utf8"))
const command = (args,data) => ({argv:["node","/opt/health-code/project.mjs",...args],result:{stdout:JSON.stringify(data)}})
recording.commands = [recording.commands[0],recording.commands[2],command(["installed-size"],10),
  command(["tests","--inventory"],{counts:{passed:1,failed:0,todo:0,skipped:0},testFileErrors:[]}),recording.commands[4],
  command(["integrity","0"],{files:["src.test.ts"],hooks:[],testFileErrors:[],cases:[["src.test.ts","case","passed"]]})]
const replay = []
const reportV2 = await inspectRepository({repositoryUrl:"https://github.com/example/project",
  sandboxProvider:createFakeSandboxProvider(recording),
  models:{repair:route,featureAdoption:route,releaseSummary:host,featureMatch:host},limits:{maxUpgrades:0},
  onEvent:event=>{replay.push(event)}})
const modelRequestSandboxProvider = createFakeSandboxProvider(recording)
const modelRequestSandboxOptions = {repositoryUrl:"https://github.com/example/project",sandboxProvider:modelRequestSandboxProvider,
  callerModelExecution:"modelRequestSandbox",models:{releaseSummary:route,featureMatch:route,repair:route,featureAdoption:route},limits:{maxUpgrades:0}}
const modelRequestSandboxCard=await inspectRepository(modelRequestSandboxOptions)
assert.equal(modelRequestSandboxCard.version,2)
assert.equal(modelRequestSandboxCard.runtimeUsage.runtimes.length,1)
assert.deepEqual(modelRequestSandboxProvider.modelRequestSandboxEvents,[])
await assert.rejects(inspectRepository({...modelRequestSandboxOptions,sandboxProvider:{...modelRequestSandboxProvider,modelRequestSandbox:undefined}}),/capability/)
assert.equal(reportV2.version,2)
assert.equal(reportV2.limits.agent.repair.maxTurns,40)
assert.equal(reportV2.limits.agent.featureAdoption.maxTurns,25)
const previous = await inspectRepository({repositoryUrl:"https://github.com/example/project",
  sandboxProvider:createFakeSandboxProvider(recording), models:{releaseSummary:host,featureMatch:host,fix:route,adoption:route},
  limits:{maxUpgrades:0,agent:{fix:{maxIterations:2},adoption:{maxIterations:0}}}})
assert.equal(previous.limits.agent.repair.maxTurns,2)
assert.equal(previous.limits.agent.featureAdoption.maxTurns,0)
assert.equal(Object.hasOwn(previous.limits.agent,"fix"),false)
const migrating = await inspectRepository({repositoryUrl:"https://github.com/example/project",
  sandboxProvider:createFakeSandboxProvider(recording), models:{releaseSummary:host,featureMatch:host,repair:route,adoption:route},
  limits:{maxUpgrades:0,agent:{fix:{maxTurns:2},repair:{maxIterations:1,maxTurns:3},featureAdoption:{maxIterations:0}}}})
assert.equal(migrating.limits.agent.repair.maxTurns,1)
assert.equal(migrating.limits.agent.featureAdoption.maxTurns,0)
assert.deepEqual(replay,reportV2.timeline)
assert.equal(replay.at(-1).type,"inspection.finished")
for(const asset of ["dist/guest.mjs","dist/observe.mjs","dist/agent.mjs","dist/patch.mjs",
  ...["repair","featureAdoption","releaseSummary","featureMatch"].map(role=>"prompts/"+role+".md")]) {
  assert.ok(readFileSync("node_modules/health-code/"+asset).length)
}
JS
# Exercise the guest bundles without workspace module resolution.
mkdir -p standalone/project
cp node_modules/health-code/dist/{guest,observe}.mjs standalone/
cp "$root/packages/health-code/test/fixtures/recorded/npm/"{package.json,package-lock.json} standalone/project/
(cd standalone/project && node ../guest.mjs detect | node -e 'const data=JSON.parse(require("node:fs").readFileSync(0));if(data.manager!=="npm"||data.sources.widget["."]!=="1.2.0")process.exit(1)')
# replay the same inspection under node and bun
cp "$root/scripts/fixtures/recorded/inspection.json" fixture.json
node consumer.mjs
bun consumer.mjs
# typecheck both report card versions against the packed declarations
cat > consumer.ts <<'TS'
import { inspectRepository, type InspectionOptions, type ReportCard } from "health-code"
import type {InspectionOptionsV2, ReportCardV2} from "health-code"
export function inspectWithModels(options: InspectionOptionsV2): Promise<ReportCardV2> {
  return inspectRepository(options)
}
export function modelRequestSandbox(options: import("health-code").ModelRequestSandboxOptions): Promise<import("health-code").ModelRequestSandboxReportCard> {
  return inspectRepository(options)
}
export const local: InspectionOptionsV2["onEvent"] = event => {
  if(event.type !== "sandbox.event") return
  const known: "agent-started"|"created"|"credentials-withheld"|"network-locked"|"connection-blocked"|"deleted"=event.action
  void known
}
export function checkFormerType(options: import("health-code").EnrichedInspectionOptions): Promise<import("health-code").EnrichedReportCard> {
  return inspectRepository(options)
}
export function inspect(options: InspectionOptions): Promise<ReportCard> {
  return inspectRepository(options)
}
TS
"$root/node_modules/.bin/tsc" --types node,json-schema --typeRoots node_modules/health-code/node_modules/@types --strict --noEmit --module nodenext --target es2022 consumer.ts
