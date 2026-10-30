import type { RiskLevel } from '@friday/shared';

export interface CommandAssessment {
  risk: RiskLevel;
  network: boolean;
  reasons: string[];
}

const ORDER: RiskLevel[] = ['none', 'low', 'medium', 'high', 'critical'];
const max = (a: RiskLevel, b: RiskLevel): RiskLevel =>
  ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b;

/** Rough word split for classification only; never used to build what actually runs. */
function words(argv: string[] | null, shellCommand: string | null): string[] {
  if (argv) return argv;
  return (shellCommand ?? '').split(/[\s;&|()<>`$]+/).filter(Boolean);
}

/**
 * Explain the risk of a command to the person approving it. Informational only: every command
 * needs approval regardless. Heuristics err toward flagging.
 */
export function assessCommand(
  argv: string[] | null,
  shellCommand: string | null,
): CommandAssessment {
  const reasons: string[] = [];
  let risk: RiskLevel = 'medium';
  let network = false;
  const w = words(argv, shellCommand).map((x) => x.toLowerCase());
  const exe = (w[0] ?? '').split('/').at(-1) ?? '';
  const has = (...xs: string[]) => xs.some((x) => w.includes(x));
  const flag = (level: RiskLevel, reason: string) => {
    risk = max(risk, level);
    reasons.push(reason);
  };

  if (shellCommand !== null) {
    const features = [
      [/\|/, 'pipes'],
      [/[<>]/, 'redirection'],
      [/&&|\|\||;/, 'command chaining'],
      [/\$\(|`/, 'command substitution'],
      [/\$\{?[A-Za-z_]/, 'variable expansion'],
      [/[*?]/, 'glob expansion'],
    ] as const;
    const used = features.filter(([re]) => re.test(shellCommand)).map(([, n]) => n);
    reasons.push(`Runs through /bin/sh${used.length ? ` and uses ${used.join(', ')}` : ''}.`);
    if (/(curl|wget)[^|]*\|\s*(ba|z)?sh/.test(shellCommand))
      flag('critical', 'Pipes a download into a shell.');
  }

  if (has('sudo', 'su', 'doas', 'pkexec')) flag('critical', 'Requests elevated (root) privileges.');
  if (exe === 'rm' || has('rm')) {
    if (w.some((x) => /^-[a-z]*r/.test(x) || x === '--recursive'))
      flag('high', 'Recursively deletes files.');
    else flag('high', 'Deletes files.');
  }
  if (has('dd', 'mkfs', 'shred', 'wipefs', 'fdisk', 'parted'))
    flag('critical', 'Low-level disk operation.');
  if (has('chmod', 'chown') && w.some((x) => x === '-r' || x === '--recursive'))
    flag('high', 'Recursively changes permissions or ownership.');
  if (has('kill', 'killall', 'pkill')) flag('high', 'Terminates processes.');
  if (has('systemctl', 'service', 'supervisorctl', 'pm2'))
    flag('high', 'Controls system services.');
  if (has('ufw', 'iptables', 'nft', 'firewall-cmd')) flag('critical', 'Changes firewall rules.');
  if (has('crontab')) flag('high', 'Changes scheduled jobs.');

  if (exe === 'git' || has('git')) {
    if (has('push')) {
      if (
        w.some((x) =>
          /^(-f|--force(-with-lease|-if-includes)?(=.*)?|--mirror|--delete|-d|\+.+)$/.test(x),
        )
      )
        flag(
          'critical',
          'Force-pushes or deletes remote history. Use git_push, which never forces.',
        );
      else flag('high', 'Pushes to a remote Git repository. Prefer git_push.');
    }
    if (has('reset') && has('--hard'))
      flag('high', 'Discards uncommitted changes (git reset --hard).');
    if (has('clean') && w.some((x) => /^-[a-z]*f/.test(x)))
      flag('high', 'Deletes untracked files (git clean).');
    if (has('checkout', 'restore') && has('--', '.'))
      flag('high', 'May discard working-tree changes.');
    if (has('rebase', 'merge', 'commit', 'tag', 'branch'))
      flag('medium', 'Changes Git history or refs.');
    if (has('clone', 'fetch', 'pull', 'push')) network = true;
  }

  const installers: Record<string, string[]> = {
    npm: ['install', 'i', 'ci', 'add', 'update', 'exec', 'publish'],
    pnpm: ['install', 'i', 'add', 'update', 'dlx', 'publish'],
    yarn: ['install', 'add', 'upgrade', 'dlx', 'publish'],
    bun: ['install', 'add', 'x'],
    pip: ['install', 'download'],
    pip3: ['install', 'download'],
    composer: ['install', 'require', 'update', 'create-project'],
    gem: ['install'],
    cargo: ['install', 'add'],
    go: ['get', 'install'],
  };
  for (const [tool, subs] of Object.entries(installers)) {
    if (exe === tool || (w.includes(tool) && subs.some((s) => w.includes(s)))) {
      if (subs.some((s) => w.includes(s))) {
        network = true;
        flag(
          'high',
          `Installs or fetches packages with ${tool}; this downloads code and may run its install scripts.`,
        );
      }
    }
  }
  if (has('npx', 'pnpx', 'bunx')) {
    network = true;
    flag('high', 'Downloads and runs a package on the fly (npx).');
  }
  if (has('publish')) flag('critical', 'Publishes a package.');

  if (has('curl', 'wget', 'nc', 'ncat', 'telnet', 'ftp')) {
    network = true;
    flag('medium', 'Makes network requests.');
  }
  if (has('ssh', 'scp', 'rsync', 'sftp')) {
    network = true;
    flag('high', 'Connects to a remote host.');
  }
  if (has('docker', 'podman')) {
    if (
      has('run', 'exec', 'compose', 'build', 'pull', 'push', 'rm', 'rmi', 'prune', 'stop', 'kill')
    ) {
      flag('high', 'Controls containers or images.');
    }
    if (has('pull', 'push', 'build')) network = true;
  }
  if (has('kubectl', 'helm', 'terraform', 'pulumi', 'ansible-playbook'))
    flag('critical', 'Infrastructure or cluster operation.');
  if (
    has('mysql', 'psql', 'redis-cli', 'mongo', 'mongosh') ||
    (has('artisan') && has('migrate', 'db:seed', 'db:wipe'))
  ) {
    flag('high', 'Database operation.');
  }
  if (network && !reasons.some((r) => r.includes('network')))
    reasons.push('May access the network.');
  return { risk, network, reasons };
}
