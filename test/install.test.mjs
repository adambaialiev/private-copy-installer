/**
 * The installer's tests: install, upgrade (with its rollback and drill), and
 * the parts they are made of. flyctl, Fly's API, the update service and the
 * domain's name servers are fakes here, so nothing is created anywhere.
 *
 *   node --test test/
 */
import { before, describe, it } from 'node:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { expect } from './expect.mjs';

const INSTALLER = path.resolve(import.meta.dirname, '../install.mjs');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let installer;

before(async () => {
  installer = await import(/* @vite-ignore */ pathToFileURL(INSTALLER).href);
});

const DOMAIN = 'agents.theirco.test';
const keyText = (payload) => `acc1.${Buffer.from(JSON.stringify({
  kind: 'update', id: 'k1', customer: 'theirco', domain: DOMAIN, updatesUntil: '2027-10-27', ...payload,
})).toString('base64url')}.c2lnbmF0dXJl`;
// The installer reads only who a licence is for; the copy checks the signature.
const LICENCE = `acc1.${Buffer.from(JSON.stringify({
  kind: 'licence', id: 'l1', customer: 'theirco', domain: DOMAIN, people: 50, starts: '2026-10-27', ends: '2027-10-26', updatesUntil: '2027-10-26', issuedAt: '2026-10-27T12:00:00Z',
})).toString('base64url')}.c2lnbmF0dXJl`;
const TAGS = Object.fromEntries(['backend', 'git-host', 'msg-host', 'router', 'mx', 'machine', 'app-runtime'].map((name) => [name, `${name}-2026.10.27.1`]));

/** A resolver as node:dns hands one out, answering from a zone of records. */
function fakeResolver(zone) {
  const find = (name, type) => zone().filter((record) => record.type === type && (
    record.name === name || (record.name.startsWith('*.') && name.endsWith(record.name.slice(1)))));
  const answer = (type, map) => (name, done) => {
    const found = find(name, type);
    if (found.length) done(null, found.map(map));
    else done(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
  };
  return {
    resolve4: answer('A', (r) => r.value),
    resolve6: answer('AAAA', (r) => r.value),
    resolveCname: answer('CNAME', (r) => r.value),
    resolveMx: answer('MX', (r) => ({ priority: r.priority, exchange: r.value })),
    resolveTxt: answer('TXT', (r) => [r.value.slice(0, 10), r.value.slice(10)]),
  };
}

/** flyctl and Fly as the installer sees them: apps, buckets, secrets,
 *  addresses, deploys and certificates, each remembered. */
function fakeFly({ failOnce, stuckCert } = {}) {
  const calls = [];
  const apps = new Set();
  const ips = new Map();
  const certs = new Map();
  const ready = new Set();
  const secrets = {};
  const deploys = [];
  let mxRestarts = 0;
  let failed = false;
  // The backend's database, as far as sqlite3 over `fly ssh` touches it.
  let db = {};
  let snapshot = {};
  const sql = [];
  const volumeSnapshots = [];
  let next = 1;
  // The backend machine's private address; a test moves it.
  let backendIp = 'fdaa:0:1::2';
  const fly = async (args, opts = {}) => {
    calls.push(args);
    const [a, b] = args;
    const flag = (name) => args[args.indexOf(name) + 1];
    if (failOnce && !failed && args.join(' ').includes(failOnce)) { failed = true; throw new Error(`fly ${a} ${b}: the network went away`); }
    if (a === 'apps' && b === 'list') return JSON.stringify([...apps].map((name) => ({ Name: name })));
    if (a === 'orgs' && b === 'list') return JSON.stringify({ 'theirco-org': 'TheirCo', personal: 'Someone' });
    if (a === 'apps' && b === 'create') { apps.add(args[2]); return ''; }
    if (a === 'apps' && b === 'restart') { mxRestarts += 1; ready.add('mx'); return ''; }
    if (a === 'storage') {
      const name = flag('-n');
      return `Your Tigris project (${name}) is ready.\n\nSet one or more of the following secrets on your target app.\nAWS_ENDPOINT_URL_S3: https://fly.storage.tigris.dev\nAWS_REGION: auto\nBUCKET_NAME: ${name}\nAWS_ACCESS_KEY_ID: tid_${name}\nAWS_SECRET_ACCESS_KEY: tsec_${name}\n`;
    }
    if (a === 'tokens') throw new Error('fly tokens create: Not authorized to access this createlimitedaccesstoken');
    if (a === 'secrets') {
      const values = Object.fromEntries(String(opts.input).trim().split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
      (secrets[flag('-a')] ??= []).push({ staged: args.includes('--stage'), values });
      return '';
    }
    if (a === 'ips' && b === 'list') return JSON.stringify(ips.get(flag('-a')) ?? []);
    if (a === 'ips' && b === 'allocate-v4') {
      const app = flag('-a');
      ips.set(app, [...(ips.get(app) ?? []), { Type: args.includes('--shared') ? 'shared_v4' : 'v4', Address: `203.0.113.${next++}` }]);
      return '';
    }
    if (a === 'ips' && b === 'allocate-v6') {
      const app = flag('-a');
      ips.set(app, [...(ips.get(app) ?? []), { Type: 'v6', Address: `2001:db8::${next++}` }]);
      return '';
    }
    if (a === 'deploy') { deploys.push({ app: flag('--app'), image: flag('--image'), toml: readFileSync(flag('--config'), 'utf8') }); return ''; }
    if (a === 'machine') return JSON.stringify([{ id: 'm1', private_ip: backendIp }]);
    if (a === 'ssh') {
      const command = flag('-C');
      sql.push(command);
      if (command.includes('.backup')) snapshot = { ...db };
      if (command.includes('.restore')) db = { ...snapshot };
      if (command.includes('CREATE TABLE IF NOT EXISTS upgrade_drill')) db.drill = true;
      if (command.includes('sqlite_master')) return `${db.drill ? 1 : 0}\n`;
      if (command.includes('integrity_check')) return 'ok\n';
      return '';
    }
    if (a === 'volumes' && b === 'list') return JSON.stringify([{ id: `vol_${flag('-a')}` }]);
    if (a === 'volumes' && b === 'snapshots') { volumeSnapshots.push(args[3]); return ''; }
    if (a === 'certs' && b === 'list') return JSON.stringify([...(certs.get(flag('-a')) ?? [])].map((hostname) => ({ hostname })));
    if (a === 'certs' && b === 'add') { const app = flag('-a'); certs.set(app, new Set([...(certs.get(app) ?? []), args[2]])); return ''; }
    if (a === 'certs' && b === 'check') { if (args[2] !== stuckCert) ready.add(args[2]); return ''; }
    if (a === 'certs' && b === 'show') {
      return JSON.stringify({
        hostname: args[2], status: ready.has(args[2]) ? 'Ready' : 'Awaiting configuration',
        // Fly names a DNS-validation target for every certificate, the wildcard's and the others'.
        dns_requirements: { acme_challenge: { name: `_acme-challenge.${args[2].replace(/^\*\./, '')}`, target: `${args[2].replace(/^\*\./, '')}.x1y2z3.flydns.net.` } },
      });
    }
    throw new Error(`unexpected fly ${args.join(' ')}`);
  };
  return { fly, calls, apps, ips, secrets, deploys, ready, sql, volumeSnapshots, db: () => db, mxRestarts: () => mxRestarts, moveBackend: (ip) => { backendIp = ip; } };
}

function harness({ billing = 'CURRENT', failOnce, stuckCert, dnsNever = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'copy-install-'));
  const keyFile = path.join(dir, 'update.key');
  writeFileSync(keyFile, `${keyText({})}\n`);
  const licenceFile = path.join(dir, 'licence.txt');
  writeFileSync(licenceFile, `${LICENCE}\n`);
  const flyFake = fakeFly({ failOnce, stuckCert });
  const lines = [];
  let dnsAdded = false;
  const zone = () => {
    if (!dnsAdded) return [];
    const ipsOf = (app) => flyFake.ips.get(app) ?? [];
    return installer.dnsRecords({
      domain: DOMAIN,
      names: installer.namesFor('theirco'),
      backendV4: ipsOf('theirco-backend').find((ip) => ip.Type === 'shared_v4').Address,
      backendV6: ipsOf('theirco-backend').find((ip) => ip.Type === 'v6').Address,
      mxV4: ipsOf('theirco-mx').find((ip) => ip.Type === 'v4').Address,
      acmeTarget: `${DOMAIN}.x1y2z3.flydns.net`,
      gitAcmeTarget: `git.${DOMAIN}.x1y2z3.flydns.net`,
    });
  };
  const fetchImpl = async (url) => {
    if (url === 'https://api.fly.io/graphql') {
      return new Response(JSON.stringify({ data: { organization: { slug: 'theirco-org', name: 'TheirCo', billable: true, billingStatus: billing }, nearestRegion: { code: 'fra' } } }));
    }
    if (url.endsWith('/api/health')) return new Response(JSON.stringify({ status: 'ok' }));
    if (url.endsWith('/health')) return new Response(JSON.stringify({ ok: true, starttls: flyFake.ready.has('mx') }));
    throw new Error(`unexpected fetch ${url}`);
  };
  const copied = [];
  const deps = {
    token: 'FlyV1 their-org-token',
    flyctl: '/usr/bin/fly',
    fly: flyFake.fly,
    fetchImpl,
    pollMs: 1,
    settleMs: 0,
    say: (line) => {
      lines.push(line);
      if (line.includes('Add these') && !dnsNever) dnsAdded = true;
    },
    updatesSource: () => ({ release: async () => ({ version: '2026.10.27.1', commit: 'abc123', images: {} }) }),
    flyRegistry: ({ app }) => ({ app }),
    copyRelease: async ({ dest, version }) => {
      copied.push(`${dest.app} ${version}`);
      return { release: { version, commit: `c-${version}` }, copied: Object.fromEntries(Object.keys(TAGS).map((name) => [name, { tag: `${name}-${version}`, digest: 'sha256:x' }])) };
    },
    authoritativeResolver: async () => ({ zone: 'theirco.test', resolver: fakeResolver(zone) }),
    smokeTest: async () => [{ what: 'everything', ok: true, detail: 'fine' }],
  };
  const options = { org: 'theirco-org', domain: DOMAIN, 'key-file': keyFile, 'licence-file': licenceFile, state: path.join(dir, 'theirco-copy.json') };
  return {
    dir, options, deps, fly: flyFake, lines, copied, stateText: () => readFileSync(options.state, 'utf8'), addDns: () => { dnsAdded = true; },
  };
}

describe('the installer: one command, an organization and a domain', () => {
  it('builds the whole of it in order, from its own registry', async () => {
    const h = harness();
    const state = await installer.install(h.options, h.deps);
    const verbs = h.fly.calls.map((args) => args.slice(0, 2).join(' '));
    // Everything named before anything is stored, stored before it starts.
    expect(verbs.indexOf('apps create')).toBeLessThan(verbs.indexOf('storage create'));
    expect(verbs.lastIndexOf('secrets import')).toBeLessThan(verbs.indexOf('deploy --config'));
    expect([...h.fly.apps].sort()).toEqual(['theirco-backend', 'theirco-git', 'theirco-images', 'theirco-mx', 'theirco-router']);
    expect(h.copied).toEqual(['theirco-images 2026.10.27.1']);

    // Four apps, then the backend again with its own private address.
    expect(h.fly.deploys.map((d) => d.app)).toEqual(['theirco-backend', 'theirco-git', 'theirco-router', 'theirco-mx', 'theirco-backend']);
    expect(h.fly.deploys[0].image).toBe('registry.fly.io/theirco-images:backend-2026.10.27.1');
    expect(h.fly.deploys[0].toml).not.toContain('FLY_BACKEND_PEER_IP');
    expect(h.fly.deploys[4].toml).toContain('FLY_BACKEND_PEER_IP = "fdaa:0:1::2"');
    const backendToml = h.fly.deploys[4].toml;
    for (const line of [
      'FLY_MACHINE_IMAGE = "registry.fly.io/theirco-images:machine-2026.10.27.1"',
      'FLY_IMAGE_APP = "theirco-images"',
      `WORKSPACE_URL = "https://${DOMAIN}"`,
      `GIT_HOST_BASE_URL = "https://git.${DOMAIN}"`,
      `MAIL_DOMAIN = "${DOMAIN}"`,
      'PRIVATE_COPY = "1"',
      'FLY_REGION = "fra"',
    ]) expect(backendToml).toContain(line);
    expect(h.fly.deploys[3].toml).toContain('handlers = ["proxy_proto"]');

    // The keys: staged before the first deploy, shared where they must match.
    const backend = h.fly.secrets['theirco-backend'][0];
    expect(backend.staged).toBe(true);
    expect(backend.values.FLY_API_TOKEN).toBe('FlyV1 their-org-token');
    expect(backend.values.FLY_SSH_PRIVATE_KEY).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----\\n.*\\n-----END OPENSSH PRIVATE KEY-----\\n$/);
    expect(backend.values.MEDIA_S3_BUCKET).toBe('theirco-media');
    expect(backend.values.BACKUP_S3_BUCKET).toBe('theirco-backups');
    expect(backend.values.FIRST_ACCOUNT_CODE.length).toBeGreaterThanOrEqual(16);
    expect(backend.values.LICENCE).toBe(LICENCE);
    expect(h.fly.deploys[0].toml).not.toContain('COPY_LICENCE');
    expect(h.fly.secrets['theirco-git'][0].values).toEqual({ GIT_HOST_SECRET: backend.values.GIT_HOST_SECRET, CI_WEBHOOK_SECRET: backend.values.GIT_HOST_SECRET });
    expect(h.fly.secrets['theirco-mx'][0].values.MAIL_INGEST_SECRET).toBe(backend.values.MAIL_INGEST_SECRET);

    // Mail gets its own IPv4; the mail receiver is restarted once its name points at it.
    expect(h.fly.ips.get('theirco-mx').map((ip) => ip.Type)).toEqual(['v4']);
    expect(h.fly.mxRestarts()).toBe(1);

    // The records are printed, and the two things the admin needs come once.
    const out = h.lines.join('\n');
    expect(out).toContain(`*.${DOMAIN}`);
    expect(out).toContain(`_acme-challenge.${DOMAIN}`);
    expect(out).toContain(`https://${DOMAIN}/signup#first-account=${backend.values.FIRST_ACCOUNT_CODE}`);
    expect(out).toContain(`Master key:       ${backend.values.SECRETS_MASTER_KEY}`);
    expect(out).toContain('Mail out:         not set up');
    // What stays on the engineer's disk holds names and addresses, never a key.
    const kept = h.stateText();
    for (const value of Object.values(backend.values)) expect(kept).not.toContain(value);
    expect(Object.keys(state.steps)).toEqual(['apps', 'release', 'buckets', 'keys', 'secrets', 'addresses', 'deploy', 'certificates', 'dns', 'smoke']);
    expect(state.mxV4).toBe(h.fly.ips.get('theirco-mx')[0].Address);
  });

  it('run again, makes nothing twice and shows the master key never again', async () => {
    const h = harness();
    await installer.install(h.options, h.deps);
    const before = h.fly.calls.length;
    h.lines.length = 0;
    await installer.install(h.options, h.deps);
    const again = h.fly.calls.slice(before).map((args) => args.slice(0, 2).join(' '));
    expect(again).toEqual([]);
    expect(h.lines.filter((line) => line.includes('done before'))).toHaveLength(10);
    expect(h.lines.join('\n')).not.toContain('Master key');
  });

  it('carries on from where it stopped, with the same keys', async () => {
    const h = harness({ failOnce: '--app theirco-router' });
    await expect(installer.install(h.options, h.deps)).rejects.toThrow('the network went away');
    const firstSecrets = h.fly.secrets['theirco-backend'][0].values;
    const stopped = JSON.parse(h.stateText());
    expect(stopped.steps.deploy).toBeUndefined();
    expect(stopped.steps.secrets).toBeDefined();
    const before = h.fly.calls.length;
    await installer.install(h.options, h.deps);
    const again = h.fly.calls.slice(before).map((args) => args.slice(0, 2).join(' '));
    expect(again).not.toContain('apps create');
    expect(again).not.toContain('storage create');
    expect(again).not.toContain('secrets import');
    expect(h.fly.secrets['theirco-backend']).toHaveLength(1);
    expect(h.lines.join('\n')).toContain(`Master key:       ${firstSecrets.SECRETS_MASTER_KEY}`);
  });

  it('stops before making anything when the organization\'s bill is not paid', async () => {
    const h = harness({ billing: 'PAST_DUE' });
    await expect(installer.install(h.options, h.deps)).rejects.toThrow(/bill is not paid \(past due\).*fly\.io\/dashboard\/theirco-org\/billing/);
    expect(h.fly.calls).toEqual([]);
  });

  it('refuses an update key issued for another domain', async () => {
    const h = harness();
    writeFileSync(h.options['key-file'], keyText({ domain: 'agents.other.test' }));
    await expect(installer.install(h.options, h.deps)).rejects.toThrow('issued for agents.other.test, not agents.theirco.test');
    expect(h.fly.calls).toEqual([]);
  });
});

/** A finished install, then the upgrade's own fakes: a newer release and a
 *  smoke test that can be told to fail on it. */
async function installed({ failNew = false } = {}) {
  const h = harness();
  await installer.install(h.options, h.deps);
  h.lines.length = 0;
  const backendImage = () => h.fly.deploys.filter((d) => d.app === 'theirco-backend').at(-1).image;
  const deps = {
    ...h.deps,
    updatesSource: () => ({ release: async () => ({ version: '2026.10.28.1', commit: 'def456', images: {} }) }),
    smokeTest: async () => [{ what: 'everything', ok: !(failNew && backendImage().endsWith('2026.10.28.1')), detail: 'checked' }],
  };
  return { ...h, deps, before: h.fly.deploys.length, backendImage };
}

describe('upgrades with a way back', () => {
  it('snapshots the database, then rolls each app to the new release', async () => {
    const h = await installed();
    const state = await installer.upgrade(h.options, h.deps);
    const rolled = h.fly.deploys.slice(h.before);
    expect(rolled.map((d) => `${d.app} ${d.image.split(':')[1]}`)).toEqual([
      'theirco-backend backend-2026.10.28.1', 'theirco-git git-host-2026.10.28.1', 'theirco-router router-2026.10.28.1', 'theirco-mx mx-2026.10.28.1',
    ]);
    expect(rolled[0].toml).toContain('COPY_RELEASE = "2026.10.28.1"');
    expect(rolled[0].toml).toContain('FLY_BACKEND_PEER_IP = "fdaa:0:1::2"');
    // The snapshot comes before the first app moves, and is checked.
    const verbs = h.fly.calls.map((args) => args.slice(0, 2).join(' '));
    expect(verbs.lastIndexOf('ssh console')).toBeLessThan(verbs.lastIndexOf('deploy --config'));
    expect(h.fly.sql.some((c) => c.includes('.backup /data/pre-upgrade-2026.10.27.1.db'))).toBe(true);
    expect(h.fly.sql.some((c) => c.includes('integrity_check'))).toBe(true);
    expect(h.fly.volumeSnapshots).toEqual(['vol_theirco-backend', 'vol_theirco-git']);
    expect(state.release.version).toBe('2026.10.28.1');
    expect(state.previous.version).toBe('2026.10.27.1');
    expect(state.upgrade).toBeUndefined();
    expect(JSON.parse(h.stateText()).release.version).toBe('2026.10.28.1');
  });

  it('gives the backend its address as it is now, when Fly has moved it', async () => {
    const h = await installed();
    h.fly.moveBackend('fdaa:0:1::9');
    const state = await installer.upgrade(h.options, h.deps);
    expect(h.fly.deploys.slice(h.before)[0].toml).toContain('FLY_BACKEND_PEER_IP = "fdaa:0:1::9"');
    expect(state.peerIp).toBe('fdaa:0:1::9');
    expect(h.lines.join('\n')).toContain('The backend\'s private address is now fdaa:0:1::9 (was fdaa:0:1::2).');
  });

  it('rolls everything back to the snapshot when the new release fails its smoke test', async () => {
    const h = await installed({ failNew: true });
    await expect(installer.upgrade(h.options, h.deps)).rejects.toThrow('The upgrade to 2026.10.28.1 failed and agents.theirco.test is back on 2026.10.27.1');
    const rolled = h.fly.deploys.slice(h.before).map((d) => `${d.app} ${d.image.split('-').pop()}`);
    expect(rolled).toEqual([
      'theirco-backend 2026.10.28.1', 'theirco-git 2026.10.28.1', 'theirco-router 2026.10.28.1', 'theirco-mx 2026.10.28.1',
      'theirco-backend 2026.10.27.1', 'theirco-git 2026.10.27.1', 'theirco-router 2026.10.27.1', 'theirco-mx 2026.10.27.1',
    ]);
    expect(h.fly.sql.some((c) => c.includes('.restore /data/pre-upgrade-2026.10.27.1.db'))).toBe(true);
    expect(h.fly.calls.some((args) => args.join(' ') === 'apps restart theirco-backend')).toBe(true);
    const kept = JSON.parse(h.stateText());
    expect(kept.release.version).toBe('2026.10.27.1');
    expect(kept.upgrade).toBeUndefined();
  });

  it('rehearses a rollback with --drill and proves the database is the snapshot', async () => {
    const h = await installed();
    await installer.upgrade({ ...h.options, drill: true }, h.deps);
    expect(h.fly.sql.some((c) => c.includes('INSERT INTO upgrade_drill'))).toBe(true);
    expect(h.fly.db().drill).toBeUndefined();
    const out = h.lines.join('\n');
    expect(out).toContain('The drill\'s mark, written after the snapshot, is gone');
    expect(out).toContain('Drill done');
    expect(JSON.parse(h.stateText()).release.version).toBe('2026.10.27.1');
  });

  it('says so and does nothing when it already runs the release', async () => {
    const h = await installed();
    const before = h.fly.calls.length;
    await installer.upgrade(h.options, { ...h.deps, updatesSource: () => ({ release: async () => ({ version: '2026.10.27.1', images: {} }) }) });
    expect(h.fly.calls.length).toBe(before);
    expect(h.lines.join('\n')).toContain('already runs release 2026.10.27.1');
  });

  it('carries on after an interruption with the snapshot it already took', async () => {
    const h = await installed();
    const kept = JSON.parse(h.stateText());
    // Stopped after the snapshot, before any app moved.
    kept.upgrade = {
      from: kept.release, toVersion: '2026.10.28.1', startedAt: '2026-10-28T09:00:00Z',
      to: { version: '2026.10.28.1', commit: 'def456', tags: Object.fromEntries(Object.keys(TAGS).map((name) => [name, `${name}-2026.10.28.1`])) },
      snapshot: { file: '/data/pre-upgrade-2026.10.27.1.db', at: '2026-10-28T09:01:00Z' },
    };
    writeFileSync(h.options.state, JSON.stringify(kept));
    await installer.upgrade(h.options, h.deps);
    expect(h.fly.sql.some((c) => c.includes('.backup'))).toBe(false);
    expect(h.backendImage()).toBe('registry.fly.io/theirco-images:backend-2026.10.28.1');
    expect(h.lines.join('\n')).toContain('Carrying on with the upgrade from 2026.10.27.1 to 2026.10.28.1');
  });
});

describe('the installer and the licence', () => {
  it('will not install without a licence, or with one for another domain', async () => {
    const h = harness();
    const { 'licence-file': _licence, ...without } = h.options;
    await expect(installer.install(without, h.deps)).rejects.toThrow('Your own Agentic Cloud needs its licence: --licence-file <file>');
    writeFileSync(h.options['licence-file'], LICENCE.replace(/^acc1\.[^.]+/, `acc1.${Buffer.from(JSON.stringify({ kind: 'licence', domain: 'agents.other.test' })).toString('base64url')}`));
    await expect(installer.install(h.options, h.deps)).rejects.toThrow('This licence was issued for agents.other.test');
    expect(h.fly.calls).toEqual([]);
  });

  it('leaves the check off with --no-licence, for a design partner', async () => {
    const h = harness();
    const { 'licence-file': _licence, ...without } = h.options;
    await installer.install({ ...without, 'no-licence': true }, h.deps);
    expect(h.fly.secrets['theirco-backend'][0].values.LICENCE).toBeUndefined();
    expect(h.fly.deploys.at(-1).toml).toContain('COPY_LICENCE = "off"');
  });

  it('sends mail out through any provider over SMTP, and names that provider\'s records', async () => {
    const h = harness();
    const passwordFile = path.join(h.dir, 'smtp.password');
    writeFileSync(passwordFile, 'smtp-secret\n');
    await installer.install({ ...h.options, 'smtp-host': 'smtp.postmarkapp.com', 'smtp-user': 'token-user', 'smtp-password-file': passwordFile }, h.deps);
    const stored = h.fly.secrets['theirco-backend'].map((write) => write.values).find((values) => values.SMTP_HOST);
    expect(stored).toEqual({ SMTP_HOST: 'smtp.postmarkapp.com', SMTP_PORT: '587', SMTP_USER: 'token-user', SMTP_PASSWORD: 'smtp-secret' });
    const out = h.lines.join('\n');
    expect(out).toContain('Also add the SPF and DKIM records smtp.postmarkapp.com gives you for');
    expect(out).not.toContain('Mail out:         not set up');
    expect(h.stateText()).not.toContain('smtp-secret');

    const both = harness();
    await expect(installer.install({ ...both.options, 'smtp-host': 'smtp.example.com', 'resend-key-file': passwordFile }, both.deps))
      .rejects.toThrow('Mail out goes one way');
    expect(both.fly.calls).toEqual([]);
  });
});

describe('the installer\'s parts', () => {
  it('makes an Ed25519 SSH key pair in OpenSSH form', () => {
    const pair = installer.sshKeyPair('theirco-backend@agents.theirco.test');
    expect(pair.privateKey).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+-----END OPENSSH PRIVATE KEY-----\n$/);
    const [type, body, comment] = pair.publicKey.split(' ');
    expect(type).toBe('ssh-ed25519');
    expect(comment).toBe('theirco-backend@agents.theirco.test');
    // The wire form: a length-prefixed type name, then the 32-byte key.
    const wire = Buffer.from(body, 'base64');
    expect(wire.readUInt32BE(0)).toBe(11);
    expect(wire.subarray(4, 15).toString()).toBe('ssh-ed25519');
    expect(wire.readUInt32BE(15)).toBe(32);
    expect(wire.length).toBe(51);
  });

  it('checks each record against what the name servers answer', async () => {
    const zone = [
      { name: DOMAIN, type: 'A', value: '203.0.113.1' },
      { name: DOMAIN, type: 'AAAA', value: '2001:db8:0:0::1' },
      { name: DOMAIN, type: 'MX', value: `mx.${DOMAIN}.`, priority: 10 },
      { name: `*.${DOMAIN}`, type: 'CNAME', value: 'theirco-router.fly.dev.' },
      { name: `_dmarc.${DOMAIN}`, type: 'TXT', value: 'v=DMARC1; p=reject; rua=mailto:dmarc@theirco.test' },
    ];
    const resolver = fakeResolver(() => zone);
    const check = (record) => installer.checkRecord(resolver, record).then((result) => result.ok);
    expect(await check({ name: DOMAIN, type: 'A', value: '203.0.113.1' })).toBe(true);
    expect(await check({ name: DOMAIN, type: 'A', value: '203.0.113.9' })).toBe(false);
    expect(await check({ name: DOMAIN, type: 'AAAA', value: '2001:db8::1' })).toBe(true);
    expect(await check({ name: DOMAIN, type: 'MX', value: `mx.${DOMAIN}`, priority: 10 })).toBe(true);
    expect(await check({ name: `*.${DOMAIN}`, type: 'CNAME', value: 'theirco-router.fly.dev' })).toBe(true);
    expect(await check({ name: `git.${DOMAIN}`, type: 'CNAME', value: 'theirco-git.fly.dev' })).toBe(false);
    // Any DMARC policy the owner prefers will do.
    expect(await check({ name: `_dmarc.${DOMAIN}`, type: 'TXT', value: 'v=DMARC1; p=quarantine' })).toBe(true);
  });

  it('registers the domain with Resend and reads its records whole', async () => {
    const seen = [];
    const fetchImpl = async (url, init = {}) => {
      seen.push(`${init.method} ${new URL(url).pathname}`);
      if (init.method === 'GET' && url.endsWith('/domains')) return new Response(JSON.stringify({ data: [] }));
      if (init.method === 'POST' && url.endsWith('/domains')) {
        return new Response(JSON.stringify({
          id: 'd1',
          records: [
            { record: 'SPF', name: 'send', type: 'MX', value: 'feedback-smtp.eu-west-1.amazonses.com', priority: 10 },
            { record: 'SPF', name: 'send', type: 'TXT', value: 'v=spf1 include:amazonses.com ~all' },
            { record: 'DKIM', name: 'resend._domainkey', type: 'TXT', value: 'p=MIGf' },
          ],
        }));
      }
      if (url.endsWith('/domains/d1')) return new Response(JSON.stringify({ id: 'd1', status: seen.length > 4 ? 'verified' : 'pending' }));
      return new Response('{}');
    };
    const resend = installer.resendProvider({ key: 're_x', fetchImpl });
    const { id, records } = await resend.register(DOMAIN);
    expect(id).toBe('d1');
    expect(records.map((r) => `${r.name} ${r.type}`)).toEqual([`send.${DOMAIN} MX`, `send.${DOMAIN} TXT`, `resend._domainkey.${DOMAIN} TXT`]);
    expect(await resend.verified('d1')).toBe(false);
    expect(await resend.verified('d1')).toBe(true);
  });

  it('reads a bucket\'s keys from flyctl\'s words', () => {
    expect(installer.bucketKeys('ready\nAWS_ENDPOINT_URL_S3: https://fly.storage.tigris.dev\nAWS_REGION: auto\nBUCKET_NAME: b\nAWS_ACCESS_KEY_ID: tid_1\nAWS_SECRET_ACCESS_KEY: tsec_2\n'))
      .toEqual({ bucket: 'b', endpoint: 'https://fly.storage.tigris.dev', region: 'auto', accessKeyId: 'tid_1', secretAccessKey: 'tsec_2' });
    expect(() => installer.bucketKeys('Error: something')).toThrow('did not print');
  });
});

/** flyctl's verbs that only read. Everything else changes something. */
const READS = new Set(['apps list', 'orgs list', 'auth token', 'certs show']);
const writes = (calls) => calls.map((args) => args.slice(0, 2).join(' ')).filter((verb) => !READS.has(verb));
const stopped = (promise) => promise.then(() => { throw new Error('expected it to stop'); }, (error) => error);

describe('driven by an agent: a plan, JSON, and when a person is needed', () => {
  it('plans without changing anything, and says what it would create and what it costs', async () => {
    const h = harness();
    const events = [];
    const result = await installer.plan({ ...h.options, json: true }, { ...h.deps, emit: (event) => events.push(event) });
    expect(result.outcome).toBe('ready');
    expect(result.exitCode).toBe(0);
    expect(result.checks.filter((check) => !check.ok)).toEqual([]);
    // Nothing made, nothing written: no state, no log, no Fly call that changes anything.
    expect(writes(h.fly.calls)).toEqual([]);
    expect(readdirSync(h.dir).sort()).toEqual(['licence.txt', 'update.key']);
    expect(h.copied).toEqual([]);

    expect(result.creates.filter((item) => item.kind === 'app').map((item) => item.name))
      .toEqual(['theirco-images', 'theirco-backend', 'theirco-git', 'theirco-router', 'theirco-mx']);
    expect(result.creates.find((item) => item.name === 'a dedicated IPv4 on theirco-mx').monthlyUsd).toBe(2);
    expect(result.creates.find((item) => item.name === 'theirco-backend').monthlyUsd).toBe(11.38);
    expect(result.monthlyUsd).toBe(21.5);
    expect(result.records.find((record) => record.name === `*.${DOMAIN}`).value).toBe('theirco-router.fly.dev');
    expect(result.records).toHaveLength(9);
    expect(result.release).toBe('2026.10.27.1');
    // The result is the last event, and no key rides in it.
    expect(events.at(-1)).toEqual(result);
    const said = JSON.stringify(events);
    expect(said).not.toContain(readFileSync(h.options['key-file'], 'utf8').trim());
    expect(said).not.toContain(LICENCE);
    expect(h.lines.join('\n')).toContain('Nothing has been created or changed');
  });

  it('plans with the same machine shapes the install deploys', async () => {
    const h = harness();
    await installer.install(h.options, h.deps);
    const backend = h.fly.deploys.find((deploy) => deploy.app === 'theirco-backend').toml;
    expect(backend).toContain(`size = "${installer.SHAPES.backend.size}"`);
    expect(backend).toContain(`memory = "${installer.SHAPES.backend.memory}"`);
    expect(backend).toContain(`initial_size = "${installer.SHAPES.backend.diskGb}gb"`);
  });

  it('names what only a person can do, and still changes nothing', async () => {
    const h = harness({ billing: 'PAST_DUE' });
    const { 'licence-file': _licence, ...without } = h.options;
    const result = await installer.plan(without, h.deps);
    expect(result.outcome).toBe('needs-person');
    expect(result.exitCode).toBe(3);
    expect(result.reason).toBe('licence');
    expect(result.checks.filter((check) => !check.ok).map((check) => `${check.who} ${check.reason}`)).toEqual(['person licence', 'person billing']);
    expect(result.checks.find((check) => check.reason === 'billing').billingUrl).toBe('https://fly.io/dashboard/theirco-org/billing');
    expect(result.person[0]).toContain('needs its licence');
    expect(writes(h.fly.calls)).toEqual([]);
  });

  it('without --org, lists the organizations the sign-in reaches for the person to choose', async () => {
    const h = harness();
    const { org: _org, ...noOrg } = h.options;
    const result = await installer.plan(noOrg, h.deps);
    const org = result.checks.find((check) => check.key === 'fly-organization');
    expect(org.reason).toBe('fly-organization');
    expect(org.organizations).toEqual(['theirco-org', 'personal']);
    expect(result.exitCode).toBe(3);
  });

  it('with --json, reports each step and the result, keeps every key off the screen, and leaves the two secrets in a handover file', async () => {
    const h = harness();
    const events = [];
    await installer.install({ ...h.options, json: true }, { ...h.deps, emit: (event) => events.push(event) });
    expect(events.filter((event) => event.event === 'step' && event.status === 'done').map((event) => event.key)).toEqual(['checks', ...installer.INSTALL_STEPS]);
    expect(events.find((event) => event.event === 'dns-records').records).toHaveLength(9);
    const result = events.at(-1);
    expect(result.outcome).toBe('done');
    expect(result.exitCode).toBe(0);
    expect(result.signInUrl).toBe(`https://${DOMAIN}`);
    expect(result.handoverFile).toBe(path.join(h.dir, 'theirco-handover.txt'));

    const stored = h.fly.secrets['theirco-backend'][0].values;
    const keys = ['FLY_API_TOKEN', 'FLY_SSH_PRIVATE_KEY', 'SECRETS_MASTER_KEY', 'GIT_HOST_SECRET', 'CI_STATUS_SECRET', 'MAIL_INGEST_SECRET', 'FIRST_ACCOUNT_CODE', 'MEDIA_S3_SECRET_ACCESS_KEY', 'BACKUP_S3_SECRET_ACCESS_KEY', 'LICENCE'];
    const said = `${JSON.stringify(events)}\n${h.lines.join('\n')}\n${h.stateText()}`;
    for (const name of keys) expect(said, `${name} was shown`).not.toContain(stored[name]);

    const handover = readFileSync(result.handoverFile, 'utf8');
    expect(handover).toContain(`https://${DOMAIN}/signup#first-account=${stored.FIRST_ACCOUNT_CODE}`);
    expect(handover).toContain(stored.SECRETS_MASTER_KEY);
    expect(statSync(result.handoverFile).mode & 0o777).toBe(0o600);
  });

  it('stops for a person when the DNS records are not in, with exactly the records to add (exit 3), and carries on once they are', async () => {
    const h = harness({ dnsNever: true });
    const error = await stopped(installer.install({ ...h.options, wait: '0' }, h.deps));
    expect(error instanceof installer.PersonNeeded).toBe(true);
    expect(installer.exitCodeOf(error)).toBe(3);
    const result = installer.resultOf(error);
    expect(result.outcome).toBe('needs-person');
    expect(result.reason).toBe('dns');
    expect(result.records).toHaveLength(9);
    expect(result.records.find((record) => record.name === `git.${DOMAIN}`)).toEqual({ name: `git.${DOMAIN}`, type: 'CNAME', value: 'theirco-git.fly.dev', why: 'the code host' });
    expect(result.records.find((record) => record.type === 'MX')).toEqual({ name: DOMAIN, type: 'MX', value: `mx.${DOMAIN}`, priority: 10, why: 'mail in' });
    expect(JSON.parse(h.stateText()).steps.dns).toBeUndefined();

    h.addDns();
    const state = await installer.install(h.options, h.deps);
    expect(state.steps.smoke).toBeDefined();
  });

  it('asks up front for the code host certificate\'s DNS-validation record, as Fly names it, and checks it like the rest', async () => {
    const want = { name: `_acme-challenge.git.${DOMAIN}`, type: 'CNAME', value: `git.${DOMAIN}.x1y2z3.flydns.net`, why: 'the certificate for the code host, proved by DNS' };
    const planned = await installer.plan(harness().options, harness().deps);
    expect(planned.records.find((record) => record.name === want.name).value).toBe('(given by Fly with the certificate)');

    const h = harness({ dnsNever: true });
    const error = await stopped(installer.install({ ...h.options, wait: '0' }, h.deps));
    expect(error.details.records.find((record) => record.name === want.name)).toEqual(want);
    expect(h.lines.join('\n')).toContain(`_acme-challenge.git.${DOMAIN}`);
    expect(JSON.parse(h.stateText()).gitAcmeTarget).toBe(want.value);

    // An install begun before the installer asked for it reads it from Fly when it carries on.
    const older = JSON.parse(h.stateText());
    delete older.gitAcmeTarget;
    writeFileSync(h.options.state, JSON.stringify(older));
    const resumed = await stopped(installer.install({ ...h.options, wait: '0' }, h.deps));
    expect(resumed.details.records.map((record) => record.name)).toContain(want.name);
    expect(h.fly.calls.filter((args) => args.join(' ') === `certs show git.${DOMAIN} -a theirco-git --json`).length).toBeGreaterThanOrEqual(2);
  });

  it('says it is still waiting, not failing, when only a certificate is slow (exit 4)', async () => {
    const h = harness({ stuckCert: `git.${DOMAIN}` });
    const error = await stopped(installer.install({ ...h.options, wait: '0' }, h.deps));
    expect(error instanceof installer.StillWaiting).toBe(true);
    expect(installer.exitCodeOf(error)).toBe(4);
    const result = installer.resultOf(error);
    expect(result.outcome).toBe('waiting');
    expect(result.reason).toBe('certificates');
    expect(result.certificatesWaiting).toContain(`git.${DOMAIN}`);
    expect(result.missing).toEqual([]);
  });

  it('asks a person for the update key it cannot find, before anything is made', async () => {
    const h = harness();
    const error = await stopped(installer.install({ ...h.options, 'key-file': path.join(h.dir, 'missing.key') }, h.deps));
    expect(installer.resultOf(error)).toEqual({
      event: 'result', outcome: 'needs-person', exitCode: 3, reason: 'update-key',
      message: `There is no update key at ${path.join(h.dir, 'missing.key')}. It comes from us with the agreement, one line in a file.`,
    });
    expect(h.fly.calls).toEqual([]);
  });

  it('ends an upgrade with a JSON result too', async () => {
    const h = await installed();
    const events = [];
    await installer.upgrade({ ...h.options, json: true }, { ...h.deps, emit: (event) => events.push(event) });
    expect(events.at(-1)).toEqual({ event: 'result', outcome: 'done', exitCode: 0, command: 'upgrade', domain: DOMAIN, release: '2026.10.28.1', previous: '2026.10.27.1' });
  });
});

describe('status: it only looks', () => {
  it('says a person is needed while records are missing, waiting while certificates are, and installed at the end', async () => {
    const h = harness({ dnsNever: true });
    await stopped(installer.install({ ...h.options, wait: '0' }, h.deps));
    const look = async () => {
      const before = h.fly.calls.length;
      const kept = h.stateText();
      const result = await installer.status({ state: h.options.state, json: true }, h.deps);
      // Read only: no flyctl verb that changes anything, no nudge, and the record untouched.
      expect(writes(h.fly.calls.slice(before))).toEqual([]);
      expect(h.stateText()).toBe(kept);
      return result;
    };

    const missing = await look();
    expect(missing.outcome).toBe('needs-person');
    expect(missing.exitCode).toBe(3);
    expect(missing.reason).toBe('dns');
    expect(missing.records).toHaveLength(9);

    h.addDns();
    const waiting = await look();
    expect(waiting.outcome).toBe('waiting');
    expect(waiting.exitCode).toBe(4);
    expect(waiting.reason).toBe('certificates');
    expect(waiting.next).toBe('install');

    await installer.install(h.options, h.deps);
    const done = await look();
    expect(done.outcome).toBe('installed');
    expect(done.exitCode).toBe(0);
    expect(done.release).toBe('2026.10.27.1');
  });
});

describe('the command line', () => {
  /** The real command, as an agent runs it, with only a local stand-in for the update service. */
  const run = (args, env = {}) => new Promise((resolve) => {
    const child = spawn(process.execPath, [INSTALLER, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (code) => resolve({ code, out, err }));
  });

  it('--plan --json prints JSON lines only, ends on the result, and exits 3 when a person must sign in to Fly', async () => {
    const h = harness();
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ version: '2026.10.27.1', commit: 'abc123', images: {} }));
    });
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    // A flyctl that is installed and signed in to nothing.
    const flyctl = path.join(h.dir, 'fly');
    writeFileSync(flyctl, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    try {
      const { code, out } = await run([
        'install', '--org', 'theirco-org', '--domain', DOMAIN, '--key-file', h.options['key-file'], '--licence-file', h.options['licence-file'],
        '--state', h.options.state, '--updates', `http://127.0.0.1:${server.address().port}`, '--plan', '--json',
      ], { FLYCTL: flyctl, FLY_API_TOKEN: '' });
      const lines = out.trim().split('\n').map((line) => JSON.parse(line));
      expect(code).toBe(3);
      expect(lines.at(-1).event).toBe('result');
      expect(lines.at(-1).outcome).toBe('needs-person');
      expect(lines.at(-1).reason).toBe('fly-sign-in');
      expect(lines.at(-1).release).toBe('2026.10.27.1');
      expect(out).not.toContain(readFileSync(h.options['key-file'], 'utf8').trim());
      expect(existsSync(h.options.state)).toBe(false);
    } finally {
      server.close();
    }
  });

  it('ends on a JSON result when it fails, too', async () => {
    const { code, out } = await run(['status', '--state', path.join(tmpdir(), 'nothing-here-copy.json'), '--json']);
    expect(code).toBe(1);
    expect(JSON.parse(out.trim().split('\n').at(-1)).outcome).toBe('failed');
  });
});
