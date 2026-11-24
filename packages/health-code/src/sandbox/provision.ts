const tools = [
	[
		"node",
		"node-linux-x64/-/node-linux-x64-24.14.0.tgz",
		"BW+LjMox8A7Dh632x6aMw793/davUra1+JatUmW9abd62tlpzpTQGVL2ZqTRC2WNjnGyh91eWxZOpZOy4AK7KA==",
		"bin/node",
	],
	[
		"bun",
		"@oven/bun-linux-x64/-/bun-linux-x64-1.4.3.tgz",
		"RArgnpjeXjaGzjp5h7Rs89cUYJutO8IyqR3itE8OBaBzEt8KNm2jp/YozxBHq4eFovwrQLryeSwTAcmiT+zcoA==",
		"bin/bun",
	],
	[
		"npm",
		"npm/-/npm-11.11.0.tgz",
		"82gRxKrh/eY5UnNorkTFcdBQAGpgjWehkfGVqAGlJjejEtJZGGJUqjo3mbBTNbc5BTnPKGVtGPBZGhElujX5cw==",
		"bin/npm-cli.js",
	],
	[
		"pnpm",
		"pnpm/-/pnpm-10.19.0.tgz",
		"yfxyNukq31yK9C/VvxYS35nCzrYvJwRwMvRyCzP46s3eMRhl6RxBHyd09hjYLzIICOy1Fxi/qCwGDEunx2oyuA==",
		"bin/pnpm.cjs",
	],
	[
		"yarn",
		"yarn/-/yarn-1.22.22.tgz",
		"prL3kGtyG7o9Z9Sv8IPfBNrWTDmXB4Qbes8A9rEzt6wkJV8mUvoirjU0Mp3GGAU06Y0XQyA3/2/RQFVuK7MTfg==",
		"bin/yarn.js",
	],
	[
		"yarn-modern",
		"@yarnpkg/cli-dist/-/cli-dist-4.9.2.tgz",
		"qrMyWzvEnWhaWOflvE1pGxWGiVOPsO/q4XfGCeRPnLU8ECkvhrhJEfCNakcy3s3VHcApBASQ4fmL0sOEw6xtZQ==",
		"bin/yarn.js",
	],
] as const

/**
 * Provisions trusted tools before repository-controlled files execute.
 */
export function provision(): string {
	// verify each pinned tool archive before linking its executable
	const downloads = tools.map(([name, tar, hash, bin]) =>
		[
			`curl -fsS --max-time 75 https://registry.npmjs.org/${tar} -o /tmp/hc-${name}.tgz`,
			`test "$(openssl dgst -sha512 -binary /tmp/hc-${name}.tgz | openssl base64 -A)" = "${hash}"`,
			`mkdir -p /opt/health-code/tools/${name}`,
			`tar xzf /tmp/hc-${name}.tgz --strip-components=1 -C /opt/health-code/tools/${name}`,
			`ln -sf /opt/health-code/tools/${name}/${bin} /opt/health-code/bin/${name}`,
		].join("\n"),
	)
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
