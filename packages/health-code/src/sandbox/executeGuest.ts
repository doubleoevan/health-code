import type { Command } from "../contracts.ts"

const reserved =
	/^(?:PATH|HOME|TMP.*|TEMP|PWD|SHELL|USER|LOGNAME|IFS|ENV|BASH_ENV|NODE.*|BUN.*|NPM.*|npm_.*|YARN.*|PNPM.*|GIT.*|LD_.*|DYLD_.*|SSL_.*|.*PROXY|RUNTA_.*|COREPACK.*|XDG_.*|CI|LANG|LC_.*|SHELLOPTS|BASHOPTS)$/i
export function guestArguments(command: Command, observation: string | undefined): string[] {
	// Build a minimal filesystem with one persistent writable project directory.
	const args = [
		"ip",
		"netns",
		"exec",
		"health-code",
		"bwrap",
		"--die-with-parent",
		"--new-session",
		"--unshare-pid",
		"--unshare-ipc",
		"--unshare-uts",
		"--ro-bind",
		"/usr",
		"/usr",
		"--symlink",
		"usr/bin",
		"/bin",
		"--symlink",
		"usr/lib",
		"/lib",
		"--symlink",
		"usr/lib64",
		"/lib64",
		"--perms",
		"0755",
		"--dir",
		"/opt",
		"--ro-bind",
		"/opt/health-code",
		"/opt/health-code",
		"--perms",
		"0755",
		"--dir",
		"/etc",
		"--ro-bind",
		"/etc/ssl",
		"/etc/ssl",
		"--ro-bind",
		"/etc/resolv.conf",
		"/etc/resolv.conf",
		"--ro-bind",
		"/etc/hosts",
		"/etc/hosts",
		"--ro-bind",
		"/etc/passwd",
		"/etc/passwd",
		"--ro-bind",
		"/etc/group",
		"/etc/group",
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--tmpfs",
		"/tmp",
		"--chmod",
		"1777",
		"/tmp",
		"--bind",
		"/var/lib/health-code/work",
		"/project",
		"--chdir",
		"/project",
	]
	if (observation) {
		args.push("--bind", observation, "/evidence")
	}
	args.push("--")
	if (observation) {
		args.push(
			"strace",
			"-ttt",
			"-qq",
			"-f",
			"-yy",
			"-s",
			"256",
			"-o",
			"|head -c 33554432 > /evidence/syscalls; cat >/dev/null",
			"-e",
			"trace=%file,%network,write,writev,pwrite64,pwritev,pwritev2,ftruncate,fallocate,sendfile,copy_file_range,splice,mmap,mprotect,pkey_mprotect,fchmod,fchown,fsetxattr,fremovexattr,fchdir,dup,dup2,clone,clone3,fork,vfork",
			"--",
		)
	}
	args.push(
		"setpriv",
		"--reuid=65534",
		"--regid=65534",
		"--clear-groups",
		"--no-new-privs",
		"--inh-caps=-all",
		"--ambient-caps=-all",
		"--bounding-set=-all",
		"env",
		"-i",
		"PATH=/opt/health-code/bin:/usr/bin:/bin",
		"HOME=/project/.health-code/home",
		"TMPDIR=/project/.health-code/tmp",
		"CI=1",
		"NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt",
		"GIT_TERMINAL_PROMPT=0",
		"LANG=C.UTF-8",
		"npm_config_cache=/project/.health-code/npm",
		"PNPM_HOME=/project/.health-code/pnpm",
	)
	for (const name of command.environment ?? []) {
		if (/^[A-Z_][A-Z0-9_]{0,127}$/i.test(name) && !reserved.test(name)) {
			args.push(`${name}=placeholder`)
		}
	}
	args.push("/usr/bin/python3", "-I", "/opt/health-code/execute.py", ...command.argv)
	return args
}

/** Keeps DNS capture and trace files outside the repository user's reach. */
export const observe = `set -eu
dir="$1"; shift
mkdir -m 700 "$dir"
(ulimit -f 65536; cd /var/lib/health-code/work && find . -type l -print0) > "$dir/links"
(ulimit -f 65536; exec ip netns exec health-code tcpdump --immediate-mode -U -nn -l -tt -i any 'port 53') > "$dir/dns" 2>"$dir/status" &
capture=$!
trap 'kill -INT "$capture" 2>/dev/null || true; wait "$capture" || true' EXIT
i=0
until grep -q 'listening on' "$dir/status"; do
  kill -0 "$capture" && test "$i" -lt 40 || exit 125
  sleep .05; i=$((i+1))
done
"$@"`
