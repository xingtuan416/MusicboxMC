import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * tsc only compiles .ts, so the renderer's .html/.css/.js, the icon and the bundled
 * resource pack all have to be copied into dist by hand.
 *
 * The destinations must match how src/main/index.ts derives its paths:
 *   dist/src/main/index.js → __dirname/../renderer = dist/src/renderer
 *   dist/src/main/index.js → __dirname/../assets   = dist/src/assets
 */
const root = dirname(dirname(fileURLToPath(import.meta.url)));

function copyIntoDist(from, to, label) {
  if (!existsSync(from)) {
    console.error(`[copy-assets] missing source: ${from}`);
    process.exitCode = 1;
    return;
  }
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
  console.log(`[copy-assets] ${label}: ${from} → ${to}`);
}

copyIntoDist(join(root, 'src', 'renderer'), join(root, 'dist', 'src', 'renderer'), 'renderer');

// The resource pack ships inside the app, so the user never has to go looking for it.
copyIntoDist(join(root, 'assets'), join(root, 'dist', 'src', 'assets'), 'assets');

const iconFrom = join(root, 'icon.png');
if (existsSync(iconFrom)) {
  const iconTo = join(root, 'dist', 'src', 'main', 'icon.png');
  mkdirSync(dirname(iconTo), { recursive: true });
  cpSync(iconFrom, iconTo);
  console.log(`[copy-assets] icon: ${iconFrom} → ${iconTo}`);
}
