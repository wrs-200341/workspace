import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const verifyDirName = '.next-verify';

function isPortListening(port, host = '127.0.0.1') {
  return new Promise((resolveResult) => {
    const socket = net.createConnection({ host, port });
    const finish = (value) => {
      socket.destroy();
      resolveResult(value);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    // Give a busy local server enough time to accept the probe; a false
    // negative here would make the build overwrite the live .next directory.
    socket.setTimeout(1500, () => finish(false));
  });
}

const liveServer = await isPortListening(3000);
const distDir = liveServer ? verifyDirName : '.next';
const distPath = resolve(root, distDir);
const buildNodeOptions = process.env.WORKSPACE_BUILD_NODE_OPTIONS || '--max-old-space-size=8192';
if (relative(root, distPath).startsWith(`..${sep}`) || relative(root, distPath) === '..') {
  throw new Error(`Refusing to use build directory outside workspace: ${distPath}`);
}
if (liveServer && existsSync(distPath)) rmSync(distPath, { recursive: true, force: true });

const nextBin = join(root, 'node_modules', 'next', 'dist', 'bin', 'next');
const child = spawn(process.execPath, [nextBin, 'build'], {
  cwd: root,
  env: {
    ...process.env,
    NODE_OPTIONS: buildNodeOptions,
    ...(liveServer ? { WORKSPACE_NEXT_DIST_DIR: verifyDirName } : { WORKSPACE_NEXT_DIST_DIR: '' }),
  },
  stdio: 'inherit',
  windowsHide: true,
});

function restoreProjectTypeReferences() {
  if (!liveServer) return;
  const nextEnvPath = join(root, 'next-env.d.ts');
  if (existsSync(nextEnvPath)) {
    const content = readFileSync(nextEnvPath, 'utf8').replaceAll('./.next-verify/', './.next/');
    writeFileSync(nextEnvPath, content);
  }
  const tsconfigPath = join(root, 'tsconfig.json');
  if (existsSync(tsconfigPath)) {
    try {
      const config = JSON.parse(readFileSync(tsconfigPath, 'utf8'));
      if (Array.isArray(config.include)) config.include = config.include.filter((item) => item !== '.next-verify/types/**/*.ts');
      writeFileSync(tsconfigPath, `${JSON.stringify(config, null, 2)}\n`);
    } catch (error) {
      console.warn('Unable to restore tsconfig.json after isolated build:', error);
    }
  }
}

child.once('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  restoreProjectTypeReferences();
  if (signal) {
    console.error(`next build terminated by ${signal}`);
    process.exitCode = 1;
  } else {
    if (liveServer) console.log(`Live server detected; build kept isolated in ${verifyDirName}/.`);
    process.exitCode = code ?? 1;
  }
});
