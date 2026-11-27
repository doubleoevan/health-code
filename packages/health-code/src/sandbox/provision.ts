import { packageManagerTools, toArchivePath } from "./packageManagerVersions.ts"

/**
 * Provisions trusted tools before repository-controlled files execute.
 */
export function provision(): string {
	// verify each tool archive before linking its executable
	const downloads = [
		toInstallSteps("node", nodeTool),
		...Object.entries(packageManagerTools).map(([name, tool]) =>
			toInstallSteps(name, {
				archive: toArchivePath({ packageName: tool.package, version: tool.bundledPackageManagerVersion }),
				hash: tool.bundledHash,
				bin: tool.bin,
			}),
		),
	]
	return [
		"set -eu",
		'test "$(uname -m)" = x86_64',

		// Allow tools to reserve sparse address space within the VM's physical memory limit.
		"echo 1 > /proc/sys/vm/overcommit_memory",
		"mkdir -p /opt/health-code/bin /var/lib/health-code",
		"export DEBIAN_FRONTEND=noninteractive",
		"apt-get -qq update",
		"apt-get -qq install -y bubblewrap procps strace tcpdump git curl openssl ca-certificates util-linux iproute2 slirp4netns python3-seccomp",
		configureGuestNetwork,
		...downloads,
	].join("\n")
}

// the node runtime that runs the guest tools, with the hash its archive must match
const nodeTool = {
	archive: "node-linux-x64/-/node-linux-x64-24.14.0.tgz",
	hash: "BW+LjMox8A7Dh632x6aMw793/davUra1+JatUmW9abd62tlpzpTQGVL2ZqTRC2WNjnGyh91eWxZOpZOy4AK7KA==",
	bin: "bin/node",
}

// download one tool archive, verify its hash and link its executable
function toInstallSteps(name: string, tool: { archive: string; hash: string; bin: string }): string {
	return [
		`curl -fsS --max-time 75 https://registry.npmjs.org/${tool.archive} -o /tmp/hc-${name}.tgz`,
		`test "$(openssl dgst -sha512 -binary /tmp/hc-${name}.tgz | openssl base64 -A)" = "${tool.hash}"`,
		`mkdir -p /opt/health-code/tools/${name}`,
		`tar xzf /tmp/hc-${name}.tgz --strip-components=1 -C /opt/health-code/tools/${name}`,
		`ln -sf /opt/health-code/tools/${name}/${tool.bin} /opt/health-code/bin/${name}`,
	].join("\n")
}

// the reasons the package manager install script reports, by the marker it prints
export const packageManagerInstallFailures: Record<string, string> = {
	unpublished: "is not published",
	deprecated: "is deprecated",
	recent: "was published less than a day ago",
	integrity: "did not match the registry's integrity",
	hash: "did not match the hash in packageManager",
}

/**
 * Installs a declared package manager version after verifying its release and archive against the registry.
 */
export const packageManagerInstallScript = [
	// read the tool name, package, archive path, version, executable path, command name and optional declared hash
	`set -eu
name="$1"; package="$2"; archive="$3"; version="$4"; bin="$5"; command_name="$6"; declared_hash="$7"
record=/tmp/hc-install-$name.json; download=/tmp/hc-install-$name.tgz; target=/opt/health-code/tools/$name-$version
fail() { echo "hc-install:$1" >&2; exit 1; }
curl -fsS --max-time 45 "https://registry.npmjs.org/$package" -o "$record"`,

	// read the release's status and integrity from the registry's record
	`integrity=$(/opt/health-code/bin/node -e '
const [file, version] = process.argv.slice(1)
const record = JSON.parse(require("node:fs").readFileSync(file, "utf8"))
const release = Object.hasOwn(record.versions ?? {}, version) ? record.versions[version] : undefined
const fail = (reason) => { console.error("hc-install:" + reason); process.exit(1) }`,

	// reject a release that is missing, deprecated, under a day old or without a sha512 integrity
	`if (!release) fail("unpublished")
if (release.deprecated) fail("deprecated")
if (!(Date.parse((record.time ?? {})[version]) <= Date.now() - 86400000)) fail("recent")
const integrity = String((release.dist ?? {}).integrity ?? "")
if (!/^sha512-[A-Za-z0-9+/=]+$/.test(integrity)) fail("integrity")
process.stdout.write(integrity.slice(7))' "$record" "$version")`,

	// verify the archive before anything from it is unpacked
	`curl -fsS --max-time 120 "https://registry.npmjs.org/$archive" -o "$download"
test "$(openssl dgst -sha512 -binary "$download" | openssl base64 -A)" = "$integrity" || fail integrity
if [ -n "$declared_hash" ]; then
  test "$(openssl dgst "-\${declared_hash%%.*}" -r "$download" | cut -d" " -f1)" = "\${declared_hash#*.}" || fail hash
fi`,

	// unpack beside the bundled tools and point the command at the declared version
	`mkdir -p "$target"
tar xzf "$download" --strip-components=1 -C "$target"
chmod -R a+rX "$target"
ln -sf "$target/$bin" "/opt/health-code/bin/$command_name"
rm -f "$record" "$download"`,
].join("\n")

/**
 * Checks out the supplied commit or resolves the default branch to a commit.
 */
export const checkout = [
	`set -eu
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 HOME=/var/empty
url="$1"
ref="$2"
if [ -z "$ref" ]; then ref=$(git -c credential.helper= -c http.followRedirects=false ls-remote --exit-code "$url" HEAD | cut -f1); fi`,

	// fetch the requested revision with submodule recursion disabled
	`git -c init.templateDir= init -q /var/lib/health-code/source
git -C /var/lib/health-code/source -c credential.helper= -c http.followRedirects=false -c fetch.recurseSubmodules=false fetch -q --depth=1 "$url" "$ref"
git -C /var/lib/health-code/source -c core.hooksPath=/dev/null -c submodule.recurse=false checkout -q --detach FETCH_HEAD`,

	// verify the checked-out revision and select yarn for this checkout
	`actual=$(git -C /var/lib/health-code/source rev-parse HEAD)
test "$actual" = "$ref"
if [ -e /var/lib/health-code/source/.yarnrc.yml ] || (test -f /var/lib/health-code/source/yarn.lock && test ! -L /var/lib/health-code/source/yarn.lock && grep -q '__metadata:' /var/lib/health-code/source/yarn.lock); then ln -sf /opt/health-code/tools/yarn-modern/bin/yarn.js /opt/health-code/bin/yarn; fi
printf '%s' "$actual"`,
].join("\n")

// restore the working tree from the inspected checkout
export const restore = [
	`set -eu
rm -rf /var/lib/health-code/work
mkdir -p /var/lib/health-code/work
cp -a --reflink=auto /var/lib/health-code/source/. /var/lib/health-code/work/`,

	// remove repository metadata and private environment files
	`rm -rf /var/lib/health-code/work/.git
find /var/lib/health-code/work -type f \\( -name .env -o -name ".env.*" \\) ! -name .env.example -delete
cd /var/lib/health-code/work`,

	// reserve the inspection directories before transferring ownership
	`test ! -e .health-code && test ! -L .health-code
mkdir -p .health-code/home .health-code/tmp
chown -R --no-dereference 65534:65534 /var/lib/health-code/work`,
].join("\n")

// Keep the repository user away from services on the runtime and private networks.
const configureGuestNetwork = [
	`set -eu
test "$(df -BG --output=size / | tail -1 | tr -dc 0-9)" -le 256
ip netns add health-code
mkdir -p /etc/netns/health-code
printf 'nameserver 10.0.2.3\n' > /etc/netns/health-code/resolv.conf
chmod 644 /etc/netns/health-code/resolv.conf`,

	// start the network bridge with host loopback disabled
	`nohup setsid slirp4netns --configure --disable-host-loopback --netns-type=path /run/netns/health-code tap0 </dev/null >/var/lib/health-code/network.log 2>&1 &
bridge=$!
i=0
until ip -n health-code route show default | grep -q tap0; do
  kill -0 "$bridge" && test "$i" -lt 50 || { cat /var/lib/health-code/network.log >&2; exit 1; }
  sleep .1; i=$((i+1))
done`,

	// prohibit routes to private and multicast destinations
	`for network in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 224.0.0.0/4; do
  ip -n health-code route add prohibit "$network"
done`,

	// write the syscall filter launcher
	`cat > /opt/health-code/execute.py <<'PYTHON'
import errno, os, seccomp, sys
rules = seccomp.SyscallFilter(defaction=seccomp.ALLOW)
for call in ("socket", "socketpair"):
    for family in range(3, 10):
        rules.add_rule(seccomp.ERRNO(errno.EAFNOSUPPORT), call, seccomp.Arg(0, seccomp.EQ, family))
    rules.add_rule(seccomp.ERRNO(errno.EAFNOSUPPORT), call, seccomp.Arg(0, seccomp.GT, 10))`,

	// deny privileged syscalls before starting the repository process
	`for call in ("io_uring_setup", "setns", "unshare", "bpf", "ptrace"):
    rules.add_rule(seccomp.ERRNO(errno.EPERM), call)
rules.load()
os.execvp(sys.argv[1], sys.argv[1:])
PYTHON`,
].join("\n")
