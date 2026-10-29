import fs from 'node:fs/promises';
import path from 'node:path';

export interface ProjectDetection {
  stack: string[];
  packageManagers: string[];
  manifests: string[];
  isGitRepo: boolean;
  /** npm/composer scripts by manifest, e.g. { "package.json": { test: "vitest" } } */
  scripts: Record<string, Record<string, string>>;
  workspaces: string[];
  topLevel: string[];
  notes: string[];
}

const MAX_MANIFEST_BYTES = 512 * 1024;

async function exists(p: string): Promise<boolean> {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false);
}

async function readJson(p: string): Promise<Record<string, unknown> | null> {
  try {
    const stat = await fs.stat(p);
    if (stat.size > MAX_MANIFEST_BYTES) return null;
    const parsed: unknown = JSON.parse(await fs.readFile(p, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function readSmallText(p: string): Promise<string | null> {
  try {
    const stat = await fs.stat(p);
    return stat.size > MAX_MANIFEST_BYTES ? null : await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

const stringRecord = (v: unknown): Record<string, string> =>
  v && typeof v === 'object'
    ? (Object.fromEntries(
        Object.entries(v as Record<string, unknown>).filter(([, x]) => typeof x === 'string'),
      ) as Record<string, string>)
    : {};

const NODE_FRAMEWORKS: Array<[string, string]> = [
  ['next', 'Next.js'],
  ['nuxt', 'Nuxt'],
  ['@sveltejs/kit', 'SvelteKit'],
  ['svelte', 'Svelte'],
  ['@angular/core', 'Angular'],
  ['vue', 'Vue'],
  ['react', 'React'],
  ['@nestjs/core', 'NestJS'],
  ['express', 'Express'],
  ['fastify', 'Fastify'],
  ['koa', 'Koa'],
  ['electron', 'Electron'],
  ['vite', 'Vite'],
  ['webpack', 'webpack'],
  ['tailwindcss', 'Tailwind CSS'],
  ['typescript', 'TypeScript'],
  ['prisma', 'Prisma'],
  ['vitest', 'Vitest'],
  ['jest', 'Jest'],
  ['@playwright/test', 'Playwright'],
];

/**
 * Identify languages, frameworks, package managers and manifests from well-known files.
 * Reads only small manifest files at the top level of the project.
 */
export async function detectProject(root: string): Promise<ProjectDetection> {
  const stack = new Set<string>();
  const packageManagers = new Set<string>();
  const manifests: string[] = [];
  const scripts: Record<string, Record<string, string>> = {};
  const notes: string[] = [];
  let workspaces: string[] = [];

  const dirents = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const names = new Set(dirents.map((d) => d.name));
  const has = (n: string) => names.has(n);
  const topLevel = dirents
    .filter((d) => !['node_modules', '.git', 'vendor'].includes(d.name))
    .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
    .sort()
    .slice(0, 100);

  if (has('package.json')) {
    manifests.push('package.json');
    stack.add('Node.js');
    const pkg = await readJson(path.join(root, 'package.json'));
    if (pkg) {
      const deps = {
        ...stringRecord(pkg['dependencies']),
        ...stringRecord(pkg['devDependencies']),
      };
      for (const [dep, label] of NODE_FRAMEWORKS) if (dep in deps) stack.add(label);
      const s = stringRecord(pkg['scripts']);
      if (Object.keys(s).length) scripts['package.json'] = s;
      const ws = pkg['workspaces'];
      if (Array.isArray(ws)) workspaces = ws.filter((w): w is string => typeof w === 'string');
      else if (
        ws &&
        typeof ws === 'object' &&
        Array.isArray((ws as { packages?: unknown }).packages)
      ) {
        workspaces = (ws as { packages: unknown[] }).packages.filter(
          (w): w is string => typeof w === 'string',
        );
      }
      if (typeof pkg['packageManager'] === 'string')
        packageManagers.add(pkg['packageManager'].split('@')[0]!);
    } else {
      notes.push('package.json could not be parsed');
    }
  }
  const lockfiles: Array<[string, string]> = [
    ['package-lock.json', 'npm'],
    ['npm-shrinkwrap.json', 'npm'],
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['bun.lock', 'bun'],
    ['composer.lock', 'composer'],
    ['poetry.lock', 'poetry'],
    ['uv.lock', 'uv'],
    ['Pipfile.lock', 'pipenv'],
    ['Cargo.lock', 'cargo'],
    ['go.sum', 'go modules'],
    ['Gemfile.lock', 'bundler'],
  ];
  for (const [file, pm] of lockfiles) if (has(file)) packageManagers.add(pm);
  if (packageManagers.has('npm') && packageManagers.has('yarn'))
    notes.push('Multiple JS lockfiles present (npm and yarn)');

  if (has('composer.json')) {
    manifests.push('composer.json');
    stack.add('PHP');
    const composer = await readJson(path.join(root, 'composer.json'));
    const req = {
      ...stringRecord(composer?.['require']),
      ...stringRecord(composer?.['require-dev']),
    };
    if ('laravel/framework' in req || has('artisan')) stack.add('Laravel');
    if ('symfony/framework-bundle' in req) stack.add('Symfony');
    if ('phpunit/phpunit' in req) stack.add('PHPUnit');
    if ('pestphp/pest' in req) stack.add('Pest');
    const s = stringRecord(composer?.['scripts']);
    if (Object.keys(s).length) scripts['composer.json'] = s;
    if (!packageManagers.has('composer')) packageManagers.add('composer');
  }

  const pyManifests = ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile'].filter(has);
  if (pyManifests.length) {
    manifests.push(...pyManifests);
    stack.add('Python');
    const text = (await Promise.all(pyManifests.map((m) => readSmallText(path.join(root, m)))))
      .join('\n')
      .toLowerCase();
    for (const [needle, label] of [
      ['django', 'Django'],
      ['flask', 'Flask'],
      ['fastapi', 'FastAPI'],
      ['pytest', 'pytest'],
    ] as const) {
      if (text.includes(needle)) stack.add(label);
    }
    if (!packageManagers.size || pyManifests.includes('requirements.txt'))
      packageManagers.add('pip');
  }

  const simple: Array<[string, string, string?]> = [
    ['go.mod', 'Go'],
    ['Cargo.toml', 'Rust', 'cargo'],
    ['Gemfile', 'Ruby', 'bundler'],
    ['pom.xml', 'Java (Maven)', 'maven'],
    ['build.gradle', 'JVM (Gradle)', 'gradle'],
    ['build.gradle.kts', 'JVM (Gradle)', 'gradle'],
    ['deno.json', 'Deno'],
  ];
  for (const [file, label, pm] of simple) {
    if (has(file)) {
      manifests.push(file);
      stack.add(label);
      if (pm) packageManagers.add(pm);
    }
  }
  if (has('Gemfile') && (await readSmallText(path.join(root, 'Gemfile')))?.includes('rails'))
    stack.add('Rails');
  if ([...names].some((n) => n.endsWith('.csproj') || n.endsWith('.sln'))) stack.add('.NET');

  const devops: Array<[string, string]> = [
    ['Dockerfile', 'Docker'],
    ['docker-compose.yml', 'Docker Compose'],
    ['docker-compose.yaml', 'Docker Compose'],
    ['compose.yml', 'Docker Compose'],
    ['compose.yaml', 'Docker Compose'],
    ['Makefile', 'Make'],
    ['Procfile', 'Procfile'],
    ['ecosystem.config.js', 'PM2'],
    ['nginx.conf', 'Nginx config'],
    ['vercel.json', 'Vercel'],
    ['netlify.toml', 'Netlify'],
    ['wrangler.toml', 'Cloudflare Workers'],
  ];
  for (const [file, label] of devops) {
    if (has(file)) {
      stack.add(label);
      manifests.push(file);
    }
  }
  if ([...names].some((n) => n.endsWith('.tf'))) stack.add('Terraform');
  if (await exists(path.join(root, '.github', 'workflows'))) {
    stack.add('GitHub Actions');
    manifests.push('.github/workflows/');
  }
  if (has('.gitlab-ci.yml')) stack.add('GitLab CI');

  return {
    stack: [...stack],
    packageManagers: [...packageManagers],
    manifests,
    isGitRepo: has('.git'),
    scripts,
    workspaces,
    topLevel,
    notes,
  };
}
