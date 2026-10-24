// Copyright 2021 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
// @ts-check
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { DAY } from './utils/durations.mjs';
import { parseVersion } from './utils/parseVersion.mjs';
import { getBuildCreationTimestamp } from './utils/getBuildCreationTimestamp.mjs';
import packageJson from '../package.json' with { type: 'json' };

const buildCreation = getBuildCreationTimestamp();

const isNotUpdatable = !parseVersion(packageJson.version).isUpdatable;

// NB: Build expirations are also determined via users' auto-update settings; see
// getExpirationTimestamp
// Fork: self-built, never auto-updated, so give a build half a year before it
// refuses to start (upstream: 30 days for non-updatable builds, 90 otherwise).
// Rebuild before then — the Signal servers also retire old clients eventually.
const validDuration = DAY * 180;
const buildExpiration = buildCreation + validDuration;

const localProductionPath = join(
  import.meta.dirname,
  '../config/local-production.json'
);

const localProductionConfig = {
  buildCreation,
  buildExpiration,
  ...(isNotUpdatable ? { updatesEnabled: false } : {}),
};

writeFileSync(
  localProductionPath,
  `${JSON.stringify(localProductionConfig)}\n`
);
