// Extracts one version's section out of CHANGELOG.md, for use as GitHub
// Release notes.
//
// The changelog is the single source of release notes: nobody writes them
// twice, and a release that says something different from the changelog is a
// release nobody can trust. The workflow calls this with the tag's version and
// fails the build if the section is missing, so cutting a tag without writing
// the entry is caught before anything is published.
//
//   bun scripts/release-notes.ts 0.2.0

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HEADING = /^## \[([^\]]+)\]/;

/** Returns the body of the section for `version`, or null if there is none. */
export function extractReleaseNotes(changelog: string, version: string): string | null {
  const lines = changelog.split('\n');
  const start = lines.findIndex((line) => HEADING.exec(line)?.[1] === version);
  if (start === -1) return null;

  const rest = lines.slice(start + 1);
  const nextHeading = rest.findIndex((line) => HEADING.test(line));
  const body = nextHeading === -1 ? rest : rest.slice(0, nextHeading);

  // Drop the trailing link-reference block ([0.2.0]: https://…), which is
  // markdown plumbing rather than something a reader wants in release notes.
  return body
    .filter((line) => !/^\[[^\]]+\]:\s+https?:\/\//.test(line))
    .join('\n')
    .trim();
}

function main(): void {
  const version = process.argv[2]?.replace(/^v/, '');
  if (!version) {
    console.error('usage: bun scripts/release-notes.ts <version>');
    process.exit(2);
  }

  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');
  const notes = extractReleaseNotes(changelog, version);

  if (notes === null) {
    console.error(
      `CHANGELOG.md has no "## [${version}]" section. Write the entry before tagging.`,
    );
    process.exit(1);
  }

  console.log(notes);
}

if (import.meta.main) main();
