#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import core from './core.cjs';

export const {
  POLICY, matchingPairs, collectEvidence, defaultCandidate,
  reviewHypothesis, evaluateRun, replayRun, reportMarkdown
} = core;

const FIXTURE_DIRS = {
  scenario: join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'scenarios'),
  proposal: join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'proposals')
};
const DEFAULT_SCENARIO = 'matched_request';

const USAGE = `Usage: node src/triage.mjs [scenario] [--proposal <name>] [--report]
       node src/triage.mjs --all

  scenario           Name of a file in fixtures/scenarios (default: ${DEFAULT_SCENARIO})
  --proposal <name>  Validate a hand-written proposal from fixtures/proposals
                     instead of the built-in prewritten one
  --report           Print the Markdown report instead of the plain-text summary
  --all              Run every scenario, then every proposal against ${DEFAULT_SCENARIO}
  -h, --help         Show this help

No live model is called. All proposals are offline and synthetic.`;

class UsageError extends Error {}

// Fixture content is local and trusted, but keep control characters out of the terminal anyway.
function plain(value) {
  const printable = value == null ? '' :
    ['string', 'number', 'boolean', 'bigint'].includes(typeof value) ? String(value) : '[unsupported value]';
  return printable.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 300);
}

function listFixtures(kind) {
  return readdirSync(FIXTURE_DIRS[kind])
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.slice(0, -'.json'.length))
    .sort();
}

function loadFixture(kind, name) {
  const base = name.replace(/\.json$/, '');
  if (!/^[a-z_]+$/.test(base) || !listFixtures(kind).includes(base)) {
    throw new UsageError(`Unknown ${kind}: ${plain(name)}. Available: ${listFixtures(kind).join(', ')}`);
  }
  return JSON.parse(readFileSync(join(FIXTURE_DIRS[kind], `${base}.json`), 'utf8'));
}

function parseArgs(argv) {
  const options = { scenario: null, proposal: null, report: false, all: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '--all') options.all = true;
    else if (arg === '--report') options.report = true;
    else if (arg === '--proposal') {
      options.proposal = argv[++i];
      if (!options.proposal) throw new UsageError('--proposal needs a proposal name');
    } else if (arg.startsWith('-')) throw new UsageError(`Unknown option: ${plain(arg)}`);
    else if (options.scenario === null) options.scenario = arg;
    else throw new UsageError('Only one scenario can be given');
  }
  return options;
}

function run(scenario, proposalName) {
  const input = loadFixture('scenario', scenario);
  const result = proposalName
    ? evaluateRun(input, loadFixture('proposal', proposalName))
    : replayRun(input);
  return { input, result };
}

export function formatSummary({ input, result }) {
  const { evidence, candidate, review } = result;
  const rows = [
    ['Scenario', input?.scenario ?? 'not described'],
    ['Run', `${plain(evidence.runId)}: first attempt ${plain(evidence.testStatus)}, retry ${evidence.retryPassed ? 'passed' : 'did not pass'}`],
    ['Evidence', `${evidence.login5xx.length} login 5xx, ${evidence.authErrors.length} auth-api ERROR, ` +
      `${evidence.pairs.length} request-and-trace matched pair(s)`],
    ['Proposal', candidate ? `${plain(candidate.claimType)} (scope ${plain(candidate.claimScope)}) -> ${plain(candidate.nextAction)}` : 'none'],
    ['Cited IDs', Array.isArray(candidate?.evidenceIds) ? candidate.evidenceIds.map(plain).join(', ') || 'none' : 'none'],
    ['Outcome', review.outcome],
    ['Reason', review.reason],
    ['Verified IDs', review.evidenceIds.join(', ') || 'none'],
    ['Next step', review.safeAction],
    ['Human review', review.humanReviewRequired ? 'required' : 'not required']
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `${label.padEnd(width)} : ${plain(value)}`).join('\n');
}

function runAll() {
  const scenarios = listFixtures('scenario');
  const proposals = listFixtures('proposal');
  const width = Math.max(...scenarios.map((name) => name.length), ...proposals.map((name) => name.length));
  const line = (name, { result }) => `${name.padEnd(width)}  ${result.review.outcome.padEnd(7)}  ${result.review.reason}`;
  const out = ['Scenarios, each with the prewritten offline proposal:'];
  for (const name of scenarios) out.push(line(name, run(name)));
  out.push('', `Hand-written proposals, each against ${DEFAULT_SCENARIO}:`);
  for (const name of proposals) out.push(line(name, run(DEFAULT_SCENARIO, name)));
  return out.join('\n');
}

export function main(argv) {
  const options = parseArgs(argv);
  if (options.help) return USAGE;
  if (options.all) return runAll();
  const outcome = run(options.scenario ?? DEFAULT_SCENARIO, options.proposal);
  if (options.report) return reportMarkdown(outcome.result);
  return `${formatSummary(outcome)}\n\nNo live model call. The proposal is an offline synthetic candidate.`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    console.log(main(process.argv.slice(2)));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`${error.message}\n\n${USAGE}`);
    process.exitCode = 2;
  }
}
