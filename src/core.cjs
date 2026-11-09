/*
 * Evidence-gating core for incident-triage-evidence-gate.
 *
 * Synthetic and educational: no model inference, no network access, no dependencies.
 * Everything here is deterministic, so the same input always gives the same decision.
 */
'use strict';

const POLICY = Object.freeze({
  path: '/api/internal/login',
  service: 'auth-api',
  windowMs: 2000,
  acceptedClaim: 'possible_service_side_login_failure',
  acceptedScope: 'investigation_only',
  acceptedAction: 'inspect_auth_service'
});

// Timestamps must be ISO 8601 with an explicit offset. Date.parse alone also
// accepts engine-specific formats (for example "2026"), which are not telemetry.
const ISO_8601 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validId(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
}

function toMillis(value) {
  if (typeof value !== 'string') return NaN;
  const parts = ISO_8601.exec(value);
  if (!parts) return NaN;

  // Date.parse normalizes impossible dates such as February 30 into March.
  // Validate calendar and clock components before trusting its result.
  const [, yy, mm, dd, hh, min, ss, , , offsetH, offsetM] = parts;
  const year = Number(yy);
  const month = Number(mm);
  const day = Number(dd);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]) return NaN;
  if (Number(hh) > 23 || Number(min) > 59 || Number(ss) > 59) return NaN;
  if (offsetH !== undefined && (Number(offsetH) > 23 || Number(offsetM) > 59)) return NaN;

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function eventsOf(firstAttempt, key) {
  return Array.isArray(firstAttempt[key]) ? firstAttempt[key] : [];
}

function isLoginServerError(response) {
  return (
    isRecord(response) &&
    response.method === 'POST' &&
    response.path === POLICY.path &&
    Number.isInteger(response.status) &&
    response.status >= 500 &&
    response.status <= 599
  );
}

function isAuthServiceError(log) {
  return isRecord(log) && log.service === POLICY.service && log.level === 'ERROR';
}

// An event can only take part in correlation if it has a usable identity and time.
function isCorrelatable(event) {
  return (
    validId(event.id) &&
    validId(event.requestId) &&
    validId(event.traceId) &&
    Number.isFinite(toMillis(event.at))
  );
}

/**
 * A pair is a login HTTP 5xx response and an auth-api ERROR log that share the
 * same request ID and trace ID and occur within POLICY.windowMs of each other.
 */
function matchingPairs(run) {
  if (run?.firstAttempt?.status !== 'failed') return [];
  const responses = eventsOf(run.firstAttempt, 'responses')
    .filter((r) => isLoginServerError(r) && isCorrelatable(r));
  const logs = eventsOf(run.firstAttempt, 'serviceLogs')
    .filter((l) => isAuthServiceError(l) && isCorrelatable(l));

  const pairs = [];
  for (const response of responses) {
    for (const log of logs) {
      const sameIdentity = log.requestId === response.requestId && log.traceId === response.traceId;
      const deltaMs = toMillis(log.at) - toMillis(response.at);
      if (sameIdentity && Math.abs(deltaMs) <= POLICY.windowMs) {
        pairs.push({
          responseId: response.id,
          logId: log.id,
          requestId: response.requestId,
          traceId: response.traceId,
          deltaMs
        });
      }
    }
  }
  return pairs;
}

// IDs that appear on more than one raw event cannot be attributed to a single event.
function findAmbiguousIds(events) {
  const counts = new Map();
  for (const event of events) {
    if (isRecord(event) && validId(event.id)) {
      counts.set(event.id, (counts.get(event.id) || 0) + 1);
    }
  }
  return [...counts].filter(([, count]) => count > 1).map(([id]) => id);
}

function collectEvidence(run) {
  const first = run?.firstAttempt || {};
  const responses = eventsOf(first, 'responses');
  const logs = eventsOf(first, 'serviceLogs');
  return {
    runId: run?.runId || 'unknown',
    testStatus: first.status || 'unknown',
    retryPassed: run?.retry?.status === 'passed',
    failureMessage: first.message || 'not reported',
    login5xx: responses.filter(isLoginServerError),
    authErrors: logs.filter(isAuthServiceError),
    pairs: matchingPairs(run),
    ambiguousRawIds: findAmbiguousIds([...responses, ...logs]),
    tracePathReported: run?.traceArtifact || null,
    traceContentsInspected: false,
    contextNote:
      'A matching request/trace identity plus nearby timestamps supports investigation, not proof of root cause.'
  };
}

/**
 * Stand-in for a model proposal. In a full system this is the part a model
 * could produce; here it is fixed so that every run is repeatable.
 */
function defaultCandidate(evidence) {
  const pair = evidence.pairs[0];
  return {
    claimType: POLICY.acceptedClaim,
    claimScope: POLICY.acceptedScope,
    evidenceIds: pair ? [pair.responseId, pair.logId] : [],
    nextAction: POLICY.acceptedAction,
    draftText: 'A service-side issue may have contributed to this login failure.',
    source: 'Prewritten offline candidate; not produced by a live model'
  };
}

function abstain(reason, safeAction = 'Collect or inspect missing evidence') {
  return { outcome: 'ABSTAIN', reason, evidenceIds: [], safeAction, humanReviewRequired: true };
}

function reviewHypothesis(candidate, evidence) {
  if (evidence.testStatus !== 'failed') return abstain('Not a failing-test triage input');

  const manualReview = 'Review the collected evidence manually.';
  if (candidate == null) {
    return abstain('No model proposal was supplied; human investigation required', manualReview);
  }
  if (!isRecord(candidate)) {
    return abstain('Model proposal is malformed; human investigation required', manualReview);
  }

  // Check the claim and the action independently, so both failures are reported.
  const violations = [];
  if (candidate.claimType !== POLICY.acceptedClaim || candidate.claimScope !== POLICY.acceptedScope) {
    violations.push('Claim type or scope exceeds the supported investigation');
  }
  if (candidate.nextAction !== POLICY.acceptedAction) {
    violations.push('Proposed action is outside the investigation-only allowlist');
  }
  if (violations.length) {
    return abstain(violations.join('; '), 'Do not execute this proposal. Request human review.');
  }

  if (evidence.pairs.length === 0) {
    if (evidence.login5xx.length === 0 && evidence.authErrors.length === 0) {
      return abstain('No qualifying login HTTP 5xx or auth-service ERROR evidence was observed');
    }
    if (evidence.login5xx.length === 0) return abstain('No qualifying login HTTP 5xx was observed');
    if (evidence.authErrors.length === 0) {
      return abstain('No auth-service ERROR was observed to corroborate the login HTTP 5xx');
    }
    return abstain('Login HTTP 5xx and auth errors have no matching request/trace identity within the time window');
  }

  const ids = candidate.evidenceIds;
  const boundedStrings =
    Array.isArray(ids) && ids.length >= 2 && ids.length <= 16 &&
    ids.every((id) => typeof id === 'string' && id.trim() && id.length <= 128);
  if (!boundedStrings) return abstain('Hypothesis must cite a bounded list of supporting signal IDs');
  if (new Set(ids).size !== ids.length) return abstain('Duplicate evidence citations are not accepted');
  if (ids.some((id) => evidence.ambiguousRawIds?.includes(id))) {
    return abstain('A cited evidence ID is duplicated in raw telemetry and cannot be attributed reliably');
  }

  // Unrelated malformed telemetry is quarantined rather than invalidating otherwise
  // sound evidence: only the cited IDs must be present exactly once.
  const observedIds = [...evidence.login5xx, ...evidence.authErrors].map((event) => event.id);
  if (ids.some((id) => observedIds.filter((observed) => observed === id).length !== 1)) {
    return abstain('One or more cited evidence IDs are missing, duplicated or ambiguous');
  }

  // Every cited ID must belong to a COMPLETE matched response/log pair, so a valid
  // pair cannot launder an extra invented, unrelated or half-matched citation.
  const cited = new Set(ids);
  const completePairs = evidence.pairs.filter((p) => cited.has(p.responseId) && cited.has(p.logId));
  if (completePairs.length === 0) return abstain('Cited evidence does not identify a matching request-level pair');
  const verified = new Set(completePairs.flatMap((p) => [p.responseId, p.logId]));
  if (ids.some((id) => !verified.has(id))) {
    return abstain('Cited IDs include an unknown or unmatched signal outside the verified pairs');
  }

  return {
    outcome: 'REVIEW',
    reason: 'Request-matched login HTTP 5xx and auth ERROR justify service investigation, not root-cause confirmation',
    evidenceIds: [...verified],
    safeClaim: 'A service-side issue may have contributed to the failed login',
    safeAction: 'Inspect auth-service health, trace context and deployment history',
    humanReviewRequired: true
  };
}

/** Validates exactly the supplied proposal. A missing proposal never becomes a recommendation. */
function evaluateRun(run, candidate) {
  const evidence = collectEvidence(run);
  const review = reviewHypothesis(candidate, evidence);
  return { evidence, candidate: candidate ?? null, review };
}

/** Offline demonstration: builds the prewritten proposal, then runs the same validation. */
function replayRun(run) {
  return evaluateRun(run, defaultCandidate(collectEvidence(run)));
}

// Never invoke arbitrary object coercion in reports. JSON objects can shadow
// toString/valueOf and cause String(value) to throw.
function displayValue(value) {
  if (value == null) return '';
  if (['string', 'number', 'boolean', 'bigint'].includes(typeof value)) return String(value);
  return '[unsupported value]';
}

// Untrusted text (telemetry fields, proposal fields) is escaped before it is placed in Markdown.
function safeMdText(value) {
  return displayValue(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .slice(0, 300)
    // Encode raw HTML delimiters before escaping Markdown syntax.
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*_{}[\]()#+.!|~-]/g, '\\$&');
}

function reportMarkdown({ evidence, candidate, review }) {
  const matched = evidence.pairs
    .map((p) => `${safeMdText(p.responseId)} + ${safeMdText(p.logId)} [${safeMdText(p.requestId)}]`)
    .join(', ');
  const cited = (Array.isArray(candidate?.evidenceIds) ? candidate.evidenceIds : [])
    .map(safeMdText)
    .join(', ');
  return [
    `# Synthetic triage review: ${safeMdText(evidence.runId)}`,
    '',
    '> Educational offline replay: the candidate is prewritten. A live LLM does not run. No real telemetry is included.',
    '',
    '## Observations',
    `- First attempt: ${safeMdText(evidence.testStatus)}; retry passed: ${evidence.retryPassed}`,
    `- POST /api/internal/login 5xx: ${evidence.login5xx.length}`,
    `- auth-api ERROR entries: ${evidence.authErrors.length}`,
    `- Same-request, same-trace matched pairs: ${evidence.pairs.length}`,
    `- Matched signals: ${matched || 'none'}`,
    `- Trace path reported: ${safeMdText(evidence.tracePathReported || 'none')}; trace content inspected: no`,
    '',
    '## Candidate and validation',
    `- Proposed claim type: ${safeMdText(candidate?.claimType ?? 'none')}`,
    `- Next action type: ${safeMdText(candidate?.nextAction ?? 'none')}`,
    `- Candidate-cited IDs: ${cited || 'none'}`,
    `- Decision: **${safeMdText(review.outcome)}**`,
    `- Reason: ${safeMdText(review.reason)}`,
    `- Safe next step: ${safeMdText(review.safeAction)}`,
    '',
    '**REVIEW means a human should investigate; it does not confirm a cause. ' +
      'ABSTAIN means insufficient support for this claim; it does not mean the service is healthy. ' +
      'Human investigation remains required either way.**',
    ''
  ].join('\n');
}

module.exports = {
  POLICY,
  matchingPairs,
  collectEvidence,
  defaultCandidate,
  reviewHypothesis,
  evaluateRun,
  replayRun,
  reportMarkdown
};
