/**
 * Filesystem loaders for the reconciliation evaluation corpus
 * (test/fixtures/reconciliation/v1/). Shared by the eval runner script and
 * the vitest regression gates so both see identical fixture parsing.
 */

import fs from 'node:fs';
import path from 'node:path';
import type {
  GoldenProjectionFixture,
  PairCorpusFile,
  ScenarioFixture,
} from './reconciliation.js';

export interface LoadedPairCorpusFile {
  filename: string;
  file: PairCorpusFile;
}

export interface LoadedScenario {
  name: string;
  scenario: ScenarioFixture;
  golden: GoldenProjectionFixture;
}

export function loadPairCorpus(casesDir: string): LoadedPairCorpusFile[] {
  const files = fs.readdirSync(casesDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((filename) => ({
      filename,
      file: JSON.parse(fs.readFileSync(path.join(casesDir, filename), 'utf8')) as PairCorpusFile,
    }));
  if (files.length === 0) throw new Error(`no pair corpus case files found in ${casesDir}`);
  return files;
}

export function loadScenarios(scenariosDir: string): LoadedScenario[] {
  const names = fs.readdirSync(scenariosDir)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.golden.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
  if (names.length === 0) throw new Error(`no scenario files found in ${scenariosDir}`);
  return names.map((name) => ({
    name,
    scenario: JSON.parse(fs.readFileSync(path.join(scenariosDir, `${name}.json`), 'utf8')) as ScenarioFixture,
    golden: JSON.parse(fs.readFileSync(path.join(scenariosDir, `${name}.golden.json`), 'utf8')) as GoldenProjectionFixture,
  }));
}
