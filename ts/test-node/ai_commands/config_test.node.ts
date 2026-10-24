// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadConfig,
  normalizeConfig,
  toClientConfig,
} from '../../../app/ai_commands/config.node.ts';

describe('ai_commands/config', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ai-commands-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates a default config with a generated token when missing', () => {
    const path = join(dir, 'ai-commands.json');
    const loaded = loadConfig(path);
    assert.isTrue(loaded.created);
    assert.deepStrictEqual(loaded.warnings, []);
    assert.isTrue(loaded.config.enabled);
    assert.isAtLeast(loaded.config.localApi.token.length, 32);
    assert.strictEqual(loaded.config.localApi.host, '127.0.0.1');
    assert.strictEqual(loaded.config.llm.model, 'mrhuang');
    const insult = loaded.config.commands.find(c => c.id === 'insult-sean');
    assert.isDefined(insult);
    assert.strictEqual(insult?.levels?.count, 10);
    assert.isTrue(insult?.pinned);

    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    assert.strictEqual(onDisk.localApi.token, loaded.config.localApi.token);
  });

  it('normalizes a sparse user config and reports warnings', () => {
    const warnings: Array<string> = [];
    const { config, tokenGenerated } = normalizeConfig(
      {
        localApi: { port: 99999, host: '0.0.0.0' },
        llm: { baseUrl: 'ftp://nope', timeoutMs: 'soon' },
        commands: [
          { id: 'ok', prompt: 'do it', levels: 5 },
          { id: 'dup', prompt: 'a' },
          { id: 'dup', prompt: 'b' },
          { id: 'bad id!', prompt: 'c' },
          { id: 'noprompt' },
          {
            id: 'full',
            label: 'Full',
            prompt: 'p',
            levels: { count: 3, default: 9, evolving: false },
          },
        ],
      },
      message => warnings.push(message)
    );
    assert.isTrue(tokenGenerated);
    assert.strictEqual(config.localApi.port, 65535);
    assert.strictEqual(config.llm.timeoutMs, 180_000);
    assert.deepStrictEqual(
      config.commands.map(c => c.id),
      ['ok', 'dup', 'full']
    );
    assert.deepStrictEqual(config.commands[0]?.levels, {
      count: 5,
      default: 3,
      evolving: true,
      describe: 'intensity',
    });
    assert.strictEqual(config.commands[2]?.levels?.default, 3);
    assert.isFalse(config.commands[2]?.levels?.evolving);
    assert.isTrue(warnings.some(w => w.includes('not loopback')));
    assert.isTrue(warnings.some(w => w.includes('duplicate id "dup"')));
    assert.isTrue(
      warnings.some(w => w.includes('bad id!') || w.includes('commands[3]'))
    );
    assert.isTrue(warnings.some(w => w.includes('missing "prompt"')));
    assert.isTrue(warnings.some(w => w.includes('not an http(s) URL')));
  });

  it('falls back to defaults on an unreadable file instead of throwing', () => {
    const path = join(dir, 'ai-commands.json');
    writeFileSync(path, '{ this is not json');
    const loaded = loadConfig(path);
    assert.isFalse(loaded.created);
    assert.isTrue(loaded.warnings.some(w => w.includes('config unreadable')));
    assert.isAbove(loaded.config.commands.length, 0);
  });

  it('never leaks secrets into the client config', () => {
    const path = join(dir, 'ai-commands.json');
    writeFileSync(
      path,
      JSON.stringify({
        localApi: { token: 'supersecrettoken-supersecret' },
        llm: { apiKey: 'sk-secret' },
        commands: [{ id: 'x', prompt: 'y' }],
      })
    );
    const client = toClientConfig(loadConfig(path));
    const serialized = JSON.stringify(client);
    assert.notInclude(serialized, 'supersecret');
    assert.notInclude(serialized, 'sk-secret');
    assert.strictEqual(client.commands[0]?.id, 'x');
  });
});
