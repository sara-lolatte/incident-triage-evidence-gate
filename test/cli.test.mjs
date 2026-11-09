import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'triage.mjs');
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

test('default run summarises the matched scenario as REVIEW', () => {
  const result = run();
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Outcome\s+: REVIEW/);
  assert.match(result.stdout, /Human review\s+: required/);
  assert.match(result.stdout, /No live model call/);
});

test('scenario names work with and without the .json suffix', () => {
  for (const name of ['wrong_request', 'wrong_request.json']) {
    const result = run(name);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Outcome\s+: ABSTAIN/);
    assert.match(result.stdout, /0 request-and-trace matched pair/);
  }
});

test('--proposal validates a hand-written proposal instead of the prewritten one', () => {
  const result = run('matched_request', '--proposal', 'overconfident');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Outcome\s+: ABSTAIN/);
  assert.match(result.stdout, /rollback_production/);
  assert.match(result.stdout, /Do not execute this proposal/);
});

test('--all lists every scenario and proposal with the documented outcomes', () => {
  const result = run('--all');
  assert.equal(result.status, 0);
  const outcomes = Object.fromEntries(
    result.stdout.split('\n').map((line) => line.match(/^(\w+)\s+(REVIEW|ABSTAIN)\s/)).filter(Boolean).map((m) => [m[1], m[2]])
  );
  assert.deepEqual(outcomes, {
    matched_request: 'REVIEW',
    missing_telemetry: 'ABSTAIN',
    retry_only: 'ABSTAIN',
    wrong_request: 'ABSTAIN',
    wrong_service: 'ABSTAIN',
    fabricated_citation: 'ABSTAIN',
    overconfident: 'ABSTAIN'
  });
});

test('--report prints the Markdown report', () => {
  const result = run('matched_request', '--report');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^# Synthetic triage review: CI\\-1042/);
  assert.match(result.stdout, /Decision: \*\*REVIEW\*\*/);
});

test('unknown scenarios, path-like names and unknown options fail with usage and exit code 2', () => {
  for (const args of [['no_such_scenario'], ['../package.json'], ['matched_request', '--bogus'], ['matched_request', '--proposal'], ['matched_request', '--proposal', 'nope']]) {
    const result = run(...args);
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, /Usage:/);
    assert.equal(result.stdout, '');
  }
});

test('--help prints usage and exits 0', () => {
  const result = run('--help');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
});


test('CLI summary safely prints malformed JSON-compatible status and candidate values', async () => {
  const { formatSummary } = await import('../src/triage.mjs');
  const malformed = JSON.parse('{"toString":null,"valueOf":null}');
  const record = {
    input: { scenario: malformed },
    result: {
      evidence: { runId: malformed, testStatus: malformed, retryPassed: true, login5xx: [], authErrors: [], pairs: [] },
      candidate: { claimType: malformed, claimScope: malformed, nextAction: malformed, evidenceIds: [malformed] },
      review: { outcome: 'ABSTAIN', reason: 'Invalid input', evidenceIds: [], safeAction: 'Inspect', humanReviewRequired: true }
    }
  };
  const output = formatSummary(record);
  assert.match(output, /Outcome\s+: ABSTAIN/);
  assert.match(output, /\[unsupported value\]/);
});
