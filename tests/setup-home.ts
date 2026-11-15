// Every test file starts with ASTERISK_HOME pointing at a fresh temp dir.
// Without it, a test that never set one read and wrote the developer's real
// ~/.asterisk — the database, its settings and, once memory began saving every
// turn automatically, hundreds of junk notes. Tests that set their own home in
// beforeEach still do; they restore to this one, never to the real home.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['ASTERISK_HOME'] = mkdtempSync(join(tmpdir(), 'asterisk-test-home-'));
