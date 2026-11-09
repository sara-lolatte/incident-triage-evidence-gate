import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import core from '../src/core.cjs';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const load = (kind, name) => JSON.parse(readFileSync(join(fixtures, kind, `${name}.json`), 'utf8'));
const scenario = (name) => load('scenarios', name);
const proposal = (name) => load('proposals', name);
const validCandidate = () => core.defaultCandidate(core.collectEvidence(scenario('matched_request')));
const outcomeOf = (run, candidate) => core.evaluateRun(run, candidate).review.outcome;

// --- Shipped scenarios -------------------------------------------------------

test('request- and trace-matched login 500s support INVESTIGATE only', () => {
  const result = core.replayRun(scenario('matched_request'));
  assert.equal(result.review.outcome, 'REVIEW');
  assert.equal(result.evidence.pairs.length, 2);
  assert.match(result.review.safeClaim, /may have contributed/);
});

test('every shipped scenario produces its documented outcome', () => {
  const expected = {
    matched_request: 'REVIEW',
    missing_telemetry: 'ABSTAIN',
    retry_only: 'ABSTAIN',
    wrong_request: 'ABSTAIN',
    wrong_service: 'ABSTAIN'
  };
  for (const [name, outcome] of Object.entries(expected)) {
    assert.equal(core.replayRun(scenario(name)).review.outcome, outcome, name);
  }
});

test('passing retry without evidence results in ABSTAIN', () => {
  assert.equal(core.replayRun(scenario('retry_only')).review.outcome, 'ABSTAIN');
});

test('auth service error in different request does not corroborate', () => {
  const result = core.replayRun(scenario('wrong_request'));
  assert.equal(result.evidence.pairs.length, 0);
  assert.equal(result.review.outcome, 'ABSTAIN');
});

test('unrelated service error with valid login 500 does not corroborate', () => {
  const result = core.replayRun(scenario('wrong_service'));
  assert.equal(result.evidence.login5xx.length, 1);
  assert.equal(result.review.outcome, 'ABSTAIN');
});

test('missing logs is insufficient evidence, not proof of healthy service', () => {
  const result = core.replayRun(scenario('missing_telemetry'));
  assert.equal(result.review.outcome, 'ABSTAIN');
  assert.doesNotMatch(result.review.reason, /healthy|flaky/i);
});

test('retry-only case explains absent signals, not mismatched identifiers', () => {
  const result = core.replayRun(scenario('retry_only'));
  assert.equal(result.review.outcome, 'ABSTAIN');
  assert.match(result.review.reason, /No qualifying login HTTP 5xx/i);
  assert.doesNotMatch(result.review.reason, /same timestamp|do not share/i);
});

test('wrong-request case explains request identity mismatch', () => {
  const result = core.replayRun(scenario('wrong_request'));
  assert.equal(result.review.outcome, 'ABSTAIN');
  assert.match(result.review.reason, /no matching request\/trace identity/i);
});

test('the retry result does not influence the decision', () => {
  const retryPassed = scenario('matched_request');
  const retryFailed = scenario('matched_request');
  retryFailed.retry.status = 'failed';
  assert.equal(core.replayRun(retryPassed).review.outcome, 'REVIEW');
  assert.equal(core.replayRun(retryFailed).review.outcome, 'REVIEW');
});

// --- Shipped hand-written proposals -----------------------------------------

test('overconfident proposal fixture is rejected on scope and on action', () => {
  const result = core.evaluateRun(scenario('matched_request'), proposal('overconfident'));
  assert.equal(result.review.outcome, 'ABSTAIN');
  assert.match(result.review.reason, /scope/i);
  assert.match(result.review.reason, /allowlist/i);
  assert.match(result.review.safeAction, /human review/i);
});

test('fabricated citation proposal fixture is rejected', () => {
  const result = core.evaluateRun(scenario('matched_request'), proposal('fabricated_citation'));
  assert.equal(result.review.outcome, 'ABSTAIN');
  assert.deepEqual(result.review.evidenceIds, []);
});

// --- Proposal policy: claim, scope and action -------------------------------

test('rollback action outside allowlist rejected even when evidence is valid', () => {
  const candidate = { ...validCandidate(), nextAction: 'rollback_production', draftText: 'Roll back all production services immediately' };
  assert.equal(outcomeOf(scenario('matched_request'), candidate), 'ABSTAIN');
});

test('overbroad customer-impact claim rejected', () => {
  const candidate = { ...validCandidate(), claimScope: 'all_customers_affected', draftText: 'Every customer login is broken' };
  assert.equal(outcomeOf(scenario('matched_request'), candidate), 'ABSTAIN');
});

test('free-text overclaim is never reproduced in validated recommendation', () => {
  const candidate = { ...validCandidate(), draftText: 'PROVEN every customer is affected, roll back now' };
  const result = core.evaluateRun(scenario('matched_request'), candidate);
  assert.equal(result.review.outcome, 'REVIEW');
  assert.doesNotMatch(JSON.stringify(result.review), /PROVEN|roll back now/);
  assert.match(result.review.safeAction, /Inspect auth-service/);
});

test('unknown claim type cannot pass the evidence gate', () => {
  const candidate = { ...validCandidate(), claimType: 'helm_version_incompatibility_proven' };
  assert.equal(outcomeOf(scenario('matched_request'), candidate), 'ABSTAIN');
});

test('overconfident proposal fails both scope and rollback policy independently', () => {
  const candidate = { ...validCandidate(), claimScope: 'all_customers_affected', nextAction: 'rollback_production' };
  const result = core.evaluateRun(scenario('matched_request'), candidate);
  assert.equal(result.review.outcome, 'ABSTAIN');
  assert.match(result.review.reason, /scope/i);
  assert.match(result.review.reason, /allowlist/i);
});

test('an unsupported proposal requests review rather than falsely asking for missing evidence', () => {
  const candidate = { ...validCandidate(), claimScope: 'all_customers_affected', nextAction: 'rollback_production' };
  const result = core.evaluateRun(scenario('matched_request'), candidate);
  assert.equal(result.review.outcome, 'ABSTAIN');
  assert.match(result.review.safeAction, /human review/i);
  assert.doesNotMatch(result.review.safeAction, /missing evidence/i);
});

// --- Missing or malformed proposals -----------------------------------------
// The validator must never substitute the offline candidate for absent model output.

test('explicit null model candidate must ABSTAIN even with matching evidence', () => {
  const result = core.evaluateRun(scenario('matched_request'), null);
  assert.equal(result.review.outcome, 'ABSTAIN');
  assert.equal(result.candidate, null);
  assert.match(result.review.reason, /No model proposal was supplied/i);
});

test('undefined model candidate must ABSTAIN', () => {
  assert.equal(core.evaluateRun(scenario('matched_request'), undefined).review.outcome, 'ABSTAIN');
});

test('missing model candidate must ABSTAIN', () => {
  assert.equal(core.evaluateRun(scenario('matched_request')).review.outcome, 'ABSTAIN');
});

test('malformed candidate cannot become an offline fallback', () => {
  assert.equal(core.evaluateRun(scenario('matched_request'), false).review.outcome, 'ABSTAIN');
});

test('null model response reports that no proposal arrived, not a policy breach', () => {
  const result = core.evaluateRun(scenario('matched_request'), null);
  assert.equal(result.review.outcome, 'ABSTAIN');
  assert.match(result.review.reason, /No model proposal was supplied/i);
  assert.doesNotMatch(result.review.reason, /claim type|scope exceeds|allowlist/i);
});

test('malformed non-object model response explains malformed proposal', () => {
  const result = core.evaluateRun(scenario('matched_request'), false);
  assert.equal(result.review.outcome, 'ABSTAIN');
  assert.match(result.review.reason, /malformed/i);
});

test('array and non-array evidence citations are rejected', () => {
  for (const candidate of [[], { ...validCandidate(), evidenceIds: 'resp-1' }, { ...validCandidate(), evidenceIds: [['resp-1'], ['log-1']] }]) {
    assert.equal(outcomeOf(scenario('matched_request'), candidate), 'ABSTAIN');
  }
});

// --- Citation validation -----------------------------------------------------

test('invented citation rejected', () => {
  const candidate = { ...validCandidate(), evidenceIds: ['resp-1', 'log-made-up'] };
  assert.equal(outcomeOf(scenario('matched_request'), candidate), 'ABSTAIN');
});

test('valid but mismatched citation pair rejected', () => {
  const candidate = { ...validCandidate(), evidenceIds: ['resp-1', 'log-2'] };
  assert.equal(outcomeOf(scenario('matched_request'), candidate), 'ABSTAIN');
});

test('one valid pair plus fabricated extra ID is rejected', () => {
  const candidate = { ...validCandidate(), evidenceIds: ['resp-1', 'log-1', 'invented-id-999'] };
  const result = core.evaluateRun(scenario('matched_request'), candidate);
  assert.equal(result.review.outcome, 'ABSTAIN');
  assert.deepEqual(result.review.evidenceIds, []);
});

test('one valid pair plus unrelated but real event is rejected', () => {
  const candidate = { ...validCandidate(), evidenceIds: ['resp-1', 'log-1', 'resp-2'] };
  assert.equal(outcomeOf(scenario('matched_request'), candidate), 'ABSTAIN');
});

test('one valid pair plus half of another valid pair is rejected', () => {
  const candidate = { ...validCandidate(), evidenceIds: ['resp-1', 'log-1', 'resp-3'] };
  assert.equal(outcomeOf(scenario('matched_request'), candidate), 'ABSTAIN');
});

test('two complete independently verified pairs are allowed with canonical IDs', () => {
  const candidate = { ...validCandidate(), evidenceIds: ['resp-1', 'log-1', 'resp-3', 'log-2'] };
  const result = core.evaluateRun(scenario('matched_request'), candidate);
  assert.equal(result.review.outcome, 'REVIEW');
  assert.deepEqual(result.review.evidenceIds, ['resp-1', 'log-1', 'resp-3', 'log-2']);
});

test('duplicate evidence citation is rejected', () => {
  const candidate = { ...validCandidate(), evidenceIds: ['resp-1', 'log-1', 'resp-1'] };
  assert.equal(outcomeOf(scenario('matched_request'), candidate), 'ABSTAIN');
});

test('object-prototype names are not accepted as evidence IDs', () => {
  const candidate = { ...validCandidate(), evidenceIds: ['__proto__', 'constructor'] };
  assert.equal(outcomeOf(scenario('matched_request'), candidate), 'ABSTAIN');
});

// --- Request and trace correlation ------------------------------------------

test('same timestamps but different trace IDs never count', () => {
  const run = scenario('matched_request');
  run.firstAttempt.serviceLogs[0].traceId = 'tr-different';
  run.firstAttempt.serviceLogs.splice(1);
  assert.equal(core.collectEvidence(run).pairs.length, 0);
});

test('same trace ID but different request ID never counts', () => {
  const run = scenario('matched_request');
  run.firstAttempt.serviceLogs[0].requestId = 'login-different';
  run.firstAttempt.serviceLogs.splice(1);
  assert.equal(core.collectEvidence(run).pairs.length, 0);
});

test('out of window auth error never counts', () => {
  const run = scenario('matched_request');
  run.firstAttempt.serviceLogs[0].at = '2026-11-06T14:06:03.100Z';
  run.firstAttempt.serviceLogs.splice(1);
  assert.equal(core.collectEvidence(run).pairs.length, 0);
});

test('the time window is inclusive at exactly two seconds', () => {
  const run = scenario('matched_request');
  run.firstAttempt.serviceLogs.splice(1);
  run.firstAttempt.serviceLogs[0].at = '2026-11-06T14:05:05.102Z'; // response is at 14:05:03.102Z
  assert.equal(core.collectEvidence(run).pairs.length, 1);
  run.firstAttempt.serviceLogs[0].at = '2026-11-06T14:05:05.103Z';
  assert.equal(core.collectEvidence(run).pairs.length, 0);
});

test('a 200 HTTP response is not treated as 500', () => {
  const run = scenario('matched_request');
  run.firstAttempt.responses.forEach((response) => { response.status = 200; });
  assert.equal(core.replayRun(run).review.outcome, 'ABSTAIN');
});

test('non-failed initial attempt cannot be triaged as a test failure', () => {
  const run = scenario('matched_request');
  run.firstAttempt.status = 'passed';
  assert.equal(core.replayRun(run).review.outcome, 'ABSTAIN');
});

// --- Telemetry validation ----------------------------------------------------

test('non-string timestamps do not count as request-level evidence', () => {
  const run = scenario('matched_request');
  run.firstAttempt.responses.forEach((response) => { response.at = null; });
  assert.equal(core.replayRun(run).review.outcome, 'ABSTAIN');
});

test('timestamps that are not ISO 8601 do not count as request-level evidence', () => {
  for (const at of ['2026', '1', 'Nov 6 2026 14:05', '2026-11-06 14:05:03']) {
    const run = scenario('matched_request');
    run.firstAttempt.responses.forEach((response) => { response.at = at; });
    run.firstAttempt.serviceLogs.forEach((log) => { log.at = at; });
    assert.equal(core.replayRun(run).review.outcome, 'ABSTAIN', at);
  }
});

test('ISO 8601 timestamps with a UTC offset are compared as instants', () => {
  const run = scenario('matched_request');
  run.firstAttempt.responses[0].at = '2026-11-06T15:05:03.102+01:00';
  assert.equal(core.replayRun(run).review.outcome, 'REVIEW');
  assert.equal(core.collectEvidence(run).pairs[0].deltaMs, -2);
});

test('malformed null and primitive telemetry records are ignored, never crash the review', () => {
  const run = scenario('matched_request');
  run.firstAttempt.serviceLogs = [null, 23, undefined, ...run.firstAttempt.serviceLogs];
  run.firstAttempt.responses = [null, 'garbage', ...run.firstAttempt.responses];
  assert.equal(core.replayRun(run).review.outcome, 'REVIEW');
});

test('malformed runs abstain instead of throwing', () => {
  const malformed = [null, 'x', 7, { firstAttempt: null }, { firstAttempt: { status: 'failed', responses: {}, serviceLogs: 'x' } }];
  for (const run of malformed) {
    assert.equal(core.replayRun(run).review.outcome, 'ABSTAIN');
  }
});

test('numeric request and trace identifiers cannot establish request-level correlation', () => {
  const run = scenario('matched_request');
  run.firstAttempt.responses[0].requestId = 41;
  run.firstAttempt.serviceLogs[0].requestId = 41;
  run.firstAttempt.responses.splice(2);
  run.firstAttempt.serviceLogs.splice(1);
  assert.equal(core.replayRun(run).review.outcome, 'ABSTAIN');
});

test('missing evidence identifiers cannot establish correlation', () => {
  const run = scenario('matched_request');
  run.firstAttempt.responses[0].id = null;
  run.firstAttempt.responses.splice(2);
  run.firstAttempt.serviceLogs.splice(1);
  assert.equal(core.replayRun(run).review.outcome, 'ABSTAIN');
});

test('unrelated malformed observations do not poison verified cited evidence', () => {
  const run = scenario('matched_request');
  run.firstAttempt.responses.push({ method: 'POST', path: '/api/internal/login', status: 500, at: '2026-11-06T14:05:03.102Z', requestId: 'other', traceId: 'other' });
  run.firstAttempt.serviceLogs.push({ service: 'auth-api', level: 'ERROR', at: '2026-11-06T14:05:03.103Z', requestId: 'other2', traceId: 'other2' });
  assert.equal(core.replayRun(run).review.outcome, 'REVIEW');
});

// --- Duplicate evidence identifiers -----------------------------------------

test('duplicate observed IDs are treated as ambiguous, not corroborated', () => {
  const run = scenario('matched_request');
  run.firstAttempt.serviceLogs[0].id = 'resp-1';
  assert.equal(core.replayRun(run).review.outcome, 'ABSTAIN');
});

test('cited duplicated telemetry ID still fails despite otherwise valid evidence', () => {
  const run = scenario('matched_request');
  run.firstAttempt.serviceLogs.push({ ...run.firstAttempt.serviceLogs[0], requestId: 'unrelated', traceId: 'unrelated' });
  const result = core.replayRun(run);
  assert.equal(result.review.outcome, 'ABSTAIN');
  assert.match(result.review.reason, /duplicated|ambiguous/i);
});

test('duplicate cited ID in filtered-out raw event is rejected', () => {
  const run = scenario('matched_request');
  run.firstAttempt.serviceLogs.push({ id: 'resp-1', service: 'analytics-service', level: 'DEBUG', requestId: 'unrelated', traceId: 'unrelated', at: '2026-11-06T14:05:03.105Z' });
  const result = core.replayRun(run);
  assert.equal(result.review.outcome, 'ABSTAIN');
  assert.match(result.review.reason, /duplicated in raw telemetry/i);
});

test('unrelated uncited duplicate ID cannot poison valid cited pairs', () => {
  const run = scenario('matched_request');
  const unrelated = { id: 'not-cited', service: 'analytics-service', level: 'DEBUG', requestId: 'unrelated', traceId: 'unrelated', at: '2026-11-06T14:05:03.105Z' };
  run.firstAttempt.serviceLogs.push(unrelated, { ...unrelated });
  assert.equal(core.replayRun(run).review.outcome, 'REVIEW');
});

// --- Report output -----------------------------------------------------------

test('reported trace path is not represented as inspected content', () => {
  const result = core.replayRun(scenario('matched_request'));
  assert.equal(result.evidence.traceContentsInspected, false);
  assert.match(core.reportMarkdown(result), /trace content inspected: no/i);
});

test('report generation handles missing candidate safely', () => {
  const report = core.reportMarkdown(core.evaluateRun(scenario('matched_request'), null));
  assert.match(report, /Decision: \*\*ABSTAIN\*\*/);
});

test('candidate multiline markdown content cannot create fake sections in report', () => {
  const candidate = { ...validCandidate(), draftText: '<h1>unsafe</h1>' };
  const report = core.reportMarkdown(core.evaluateRun(scenario('matched_request'), candidate));
  assert.doesNotMatch(report, /^# unsafe/m);
});

test('untrusted values that are rendered in the report cannot add headings, links or lists', () => {
  const run = scenario('matched_request');
  run.runId = 'CI-1\n# Injected heading\n- injected item';
  run.traceArtifact = '[click](http://example.invalid)\n## Another heading';
  const candidate = { ...validCandidate(), claimType: '**bold**\n# Heading', nextAction: '`code`\n- item' };
  const report = core.reportMarkdown(core.evaluateRun(run, candidate));

  const headings = report.split('\n').filter((line) => line.startsWith('#'));
  assert.deepEqual(headings, ['# Synthetic triage review: CI\\-1 \\# Injected heading \\- injected item', '## Observations', '## Candidate and validation']);
  assert.doesNotMatch(report, /^- (injected|item)/m);
  assert.doesNotMatch(report, /(?<!\\)\[click\]|(?<!\\)\*\*bold|(?<!\\)`code/);
});

test('the report footer explains both outcomes', () => {
  const report = core.reportMarkdown(core.replayRun(scenario('matched_request')));
  assert.match(report, /REVIEW means a human should investigate/);
  assert.match(report, /ABSTAIN means insufficient support/);
});

// --- Public-repo audit regressions ------------------------------------------

test('impossible calendar dates cannot form a verified evidence pair', () => {
  const run = scenario('matched_request');
  for (const name of ['responses', 'serviceLogs']) {
    run.firstAttempt[name].forEach((event, i) => {
      event.at = `2026-02-30T12:00:0${i}Z`;
    });
  }
  const result = core.replayRun(run);
  assert.equal(result.evidence.pairs.length, 0);
  assert.equal(result.review.outcome, 'ABSTAIN');
});

test('a valid leap day is accepted as correlated evidence', () => {
  const run = scenario('matched_request');
  for (const name of ['responses', 'serviceLogs']) {
    run.firstAttempt[name].forEach((event, i) => {
      event.at = `2024-02-29T12:00:0${i}Z`;
    });
  }
  assert.equal(core.replayRun(run).review.outcome, 'REVIEW');
});

test('untrusted report fields cannot insert raw HTML tags', () => {
  const run = scenario('matched_request');
  run.runId = '<img src=x onerror=alert(1)> & <script>alert(1)</script>';
  const report = core.reportMarkdown(core.replayRun(run));
  assert.doesNotMatch(report, /<img|<script/i);
  assert.match(report, /&lt;img/);
  assert.match(report, /&amp;/);
});


test('the report escapes untrusted status HTML and multiline Markdown', () => {
  const run = scenario('matched_request');
  run.firstAttempt.status = '<img src=x onerror=alert(1)>\n# Injected heading';
  const result = core.replayRun(run);
  assert.equal(result.review.outcome, 'ABSTAIN');
  const report = core.reportMarkdown(result);
  assert.doesNotMatch(report, /<img|^# Injected heading/m);
  assert.match(report, /&lt;img/);
  assert.match(report, /\\# Injected heading/);
});

test('malformed JSON object status can be reported after abstention', () => {
  const run = scenario('matched_request');
  run.firstAttempt.status = JSON.parse('{"toString":null,"valueOf":null}');
  const result = core.replayRun(run);
  assert.equal(result.review.outcome, 'ABSTAIN');
  assert.ok(core.reportMarkdown(result).includes(String.raw`First attempt: \[unsupported value\]`));
});

test('malformed JSON object candidate field can be reported after abstention', () => {
  const candidate = { ...validCandidate(), claimType: JSON.parse('{"toString":null,"valueOf":null}') };
  const result = core.evaluateRun(scenario('matched_request'), candidate);
  assert.equal(result.review.outcome, 'ABSTAIN');
  assert.ok(core.reportMarkdown(result).includes(String.raw`Proposed claim type: \[unsupported value\]`));
});


test('report removes terminal control characters from synthetic metadata', () => {
  const run = scenario('matched_request');
  run.runId = 'CI-1042\x1bcRESET\x07';
  run.traceArtifact = 'artifact\x1b[31m-red\x9b31m';
  const report = core.reportMarkdown(core.replayRun(run));
  assert.doesNotMatch(report, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
  assert.ok(report.includes(String.raw`CI\-1042 cRESET`));
  assert.ok(report.includes(String.raw`artifact \[31m\-red 31m`));
});
