// GONDOLA — the hand-in program for the threejs-fps-02 entry.
//
// What it does, and nothing else: it copies this repository's game/ (the
// playable game: static ES modules plus the kit's three.js 0.187.0) and
// screenshots/ (four real renders of the game running in a browser) into the
// output directory, then writes /output/dossier.json with the kit's own
// buildDossier from vendor/makefun-threejs.ts. The grader runs this program
// twice and compares the two outputs byte for byte, so the program is
// deterministic: no timestamps, no random choices, no network.
//
// Run it locally the same way the grader does, with MAKEFUN_OUTPUT_DIR
// standing in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-threejs.ts';

// The repository root is the directory this file lives in.
const here = fileURLToPath(new URL('.', import.meta.url));
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output.
const out = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

mkdirSync(out, { recursive: true });

// game/ — the whole playable game, copied file for file.
cpSync(join(here, 'game'), join(out, 'game'), { recursive: true });

// screenshots/ — the four renders, first by name is the cover.
mkdirSync(join(out, 'screenshots'), { recursive: true });
if (existsSync(join(here, 'screenshots'))) {
  cpSync(join(here, 'screenshots'), join(out, 'screenshots'), { recursive: true });
}

// dossier.json — the summary the judge reads, written by the kit's library
// with the competition's own caps: source text at most 160 KiB, at most four
// screenshots of at most 256 KiB each, game/ at most 993 files and 48 MiB.
const dossierPath = join(out, 'dossier.json');
const dossier = buildDossier(out, {
  text_max_bytes: 163840,
  screenshots: { max: 4, max_bytes: 262144 },
  game_max_files: 993,
  game_max_bytes: 50331648,
});
writeFileSync(dossierPath, dossier);

// A short human-readable receipt on stdout (never written to /output, so the
// two grader runs stay byte-identical): what was handed in and how big it is.
const shots = readdirSync(join(out, 'screenshots')).filter((n) => !n.startsWith('.'));
console.log(
  'GONDOLA handed in: game/ + ' + shots.length + ' screenshots (' + shots.join(', ') +
  ') + dossier.json (' + dossier.length + ' bytes)',
);
