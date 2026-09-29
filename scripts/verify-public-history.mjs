import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const maintainerLogin = 'totec448-spec';
const safeMaintainerEmail = /^(?:\d+\+)?totec448-spec@users\.noreply\.github\.com$/i;

// Keep the blocked values split so this guard does not contain the data it rejects.
const blockedText = [
  { label: 'private maintainer email', value: ['totec448', 'gmail.com'].join('@') },
  { label: 'Claude session trailer', value: ['Claude', 'Session:'].join('-') },
  { label: 'Claude session URL', value: ['https://claude.ai/code/', 'session_'].join('') },
  { label: 'private Windows user path', value: ['C:', 'Users', 'totec'].join('\\') },
];

/**
 * Maintainer-identity findings that already exist in published history.
 *
 * Both are GitHub web-UI merge commits: GitHub stamped the author identity, they live on
 * `origin/main` and are not ancestors of local `HEAD`, and this checkout never pushes — so
 * nothing done here can change them. Without this list every run exited 1, which meant the
 * check could no longer say anything: an operator had to diff two failure lines by eye to
 * see whether a change had added a third, and a permanently red gate is not a gate.
 *
 * The list can only ever excuse the *maintainer-identity* finding on these exact commits.
 * Blocked text in a message or a tree still fails on them like anywhere else, and an entry
 * that stops matching is itself a failure (see `staleAcceptances`) so this cannot rot into
 * a place where findings go to be forgotten. Only a SHA and a reason are stored: writing
 * the address here is the thing the check exists to prevent.
 */
const acceptedIdentityFindings = new Map([
  [
    '9e27c0fafc20bf2c81509844d5f92868678b4168',
    'GitHub web-UI merge of PR #20, authored by GitHub on origin/main; unreachable from HEAD',
  ],
  [
    '03acfbaad9d753d09487761e97cc1eade8eb8b22',
    'GitHub web-UI merge of PR #19, authored by GitHub on origin/main; unreachable from HEAD',
  ],
]);

function runGit(args, { allowFailure = false, encoding = 'utf8' } = {}) {
  const result = spawnSync('git', args, {
    cwd: process.cwd(),
    encoding,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (!allowFailure && result.status !== 0) {
    const detail = String(result.stderr ?? '').trim();
    throw new Error(`git ${args[0] ?? ''} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function findBlockedText(text, location) {
  const normalized = text.toLowerCase();
  return blockedText
    .filter(({ value }) => normalized.includes(value.toLowerCase()))
    .map(({ label }) => `${location} contains ${label}`);
}

function checkMaintainerIdentity(name, email, location) {
  const normalizedName = name.trim().toLowerCase();
  const normalizedEmail = email.trim().replace(/^<|>$/g, '').toLowerCase();
  const belongsToMaintainer =
    normalizedName === maintainerLogin || normalizedEmail.includes(maintainerLogin);
  if (belongsToMaintainer && !safeMaintainerEmail.test(normalizedEmail)) {
    return [`${location} uses a non-noreply maintainer email`];
  }
  return [];
}

function parseGitIdent(ident) {
  const match = ident.match(/^(.*) <([^>]+)> \d+ [+-]\d{4}$/);
  if (!match) throw new Error('Could not parse the Git author identity.');
  return { name: match[1] ?? '', email: match[2] ?? '' };
}

function checkIndexedOrCommittedFiles(treeish) {
  const failures = [];
  for (const { label, value } of blockedText) {
    const args = ['grep', '-q', '-I', '-i', '-F', '-e', value];
    if (treeish === '--cached') args.push('--cached');
    else args.push(treeish);
    args.push('--', '.');
    const result = runGit(args, { allowFailure: true });
    if (result.status === 0) failures.push(`${treeish} contains ${label}`);
    else if (result.status !== 1) throw new Error(`git grep failed while checking ${label}`);
  }
  return failures;
}

function checkCurrentAuthor() {
  const ident = String(runGit(['var', 'GIT_AUTHOR_IDENT']).stdout).trim();
  const { name, email } = parseGitIdent(ident);
  return checkMaintainerIdentity(name, email, 'current Git author');
}

function checkMessageFile(messagePath) {
  return [
    ...checkCurrentAuthor(),
    ...findBlockedText(readFileSync(messagePath, 'utf8'), 'commit message'),
  ];
}

function checkHistory() {
  const failures = [];
  /** Allowlist entries this run actually used, so an entry that no longer applies is caught. */
  const usedAcceptances = new Set();
  const commits = String(runGit(['rev-list', '--all']).stdout)
    .split(/\r?\n/)
    .filter(Boolean);
  // pull_request jobs default to a GitHub-generated merge object that can never enter
  // public history. Its identity belongs to GitHub's test ref, not to the proposed tree.
  const syntheticPullRequestCommit =
    process.env.GITHUB_EVENT_NAME === 'pull_request' ? process.env.GITHUB_SHA?.trim() : '';

  for (const commit of commits) {
    if (syntheticPullRequestCommit && commit === syntheticPullRequestCommit) continue;
    const record = String(
      runGit(['show', '-s', '--format=%an%x00%ae%x00%cn%x00%ce%x00%B', commit]).stdout,
    );
    const [authorName = '', authorEmail = '', committerName = '', committerEmail = '', ...body] =
      record.split('\0');
    const location = `commit ${commit}`;
    const identity = [
      ...checkMaintainerIdentity(authorName, authorEmail, `${location} author`),
      ...checkMaintainerIdentity(committerName, committerEmail, `${location} committer`),
    ];
    // Only the identity findings are excusable, and only on a listed commit. Blocked text in
    // the message is a different fact and is never waived.
    if (identity.length > 0 && acceptedIdentityFindings.has(commit)) usedAcceptances.add(commit);
    else failures.push(...identity);
    failures.push(...findBlockedText(body.join('\0'), `${location} message`));
  }

  const tags = String(runGit(['tag', '--list']).stdout)
    .split(/\r?\n/)
    .filter(Boolean);
  for (const tag of tags) {
    const type = String(runGit(['cat-file', '-t', tag]).stdout).trim();
    if (type !== 'tag') continue;
    const record = String(
      runGit([
        'for-each-ref',
        `refs/tags/${tag}`,
        '--format=%(taggername)%00%(taggeremail)%00%(contents)',
      ]).stdout,
    );
    const [taggerName = '', taggerEmail = '', ...body] = record.split('\0');
    failures.push(
      ...checkMaintainerIdentity(taggerName, taggerEmail, `tag ${tag} tagger`),
      ...findBlockedText(body.join('\0'), `tag ${tag} message`),
    );
  }

  const head = runGit(['rev-parse', '--verify', 'HEAD'], { allowFailure: true });
  if (head.status === 0) failures.push(...checkIndexedOrCommittedFiles('HEAD'));

  // An acceptance for a commit that is present and *clean* is excusing nothing, and leaving
  // it would let the list grow into cover for findings nobody has checked. A commit this
  // repository does not contain is a different case — a fresh clone without the origin refs,
  // or the scratch repositories the gate's own tests run it in — and the entry simply does
  // not apply there.
  const present = new Set(commits);
  for (const commit of acceptedIdentityFindings.keys()) {
    if (present.has(commit) && !usedAcceptances.has(commit)) {
      failures.push(
        `accepted-finding list names ${commit}, which produced no maintainer-identity finding this run — remove the entry`,
      );
    }
  }
  return { failures, commits: commits.length, tags: tags.length, accepted: usedAcceptances.size };
}

function fail(failures) {
  console.error('Public-history privacy check failed:');
  for (const failure of [...new Set(failures)]) console.error(`- ${failure}`);
  process.exitCode = 1;
}

const [mode, argument] = process.argv.slice(2);
if (mode === '--message') {
  if (!argument) throw new Error('--message requires the commit-message file path.');
  const failures = checkMessageFile(argument);
  if (failures.length > 0) fail(failures);
} else if (mode === '--staged') {
  const failures = [...checkCurrentAuthor(), ...checkIndexedOrCommittedFiles('--cached')];
  if (failures.length > 0) fail(failures);
} else if (mode) {
  throw new Error(`Unknown argument: ${mode}`);
} else {
  const { failures, commits, tags, accepted } = checkHistory();
  if (failures.length > 0) fail(failures);
  else {
    const waived = accepted > 0 ? `, ${accepted} accepted historical finding(s)` : '';
    console.log(`Public-history privacy check passed (${commits} commits, ${tags} tags${waived}).`);
  }
}
