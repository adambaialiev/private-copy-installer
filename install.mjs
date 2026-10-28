#!/usr/bin/env node
/**
 * The private copy's own command, run by the customer's engineer
 * with Node 20 or newer and flyctl. Nothing else to install: one file, no
 * packages. The Fly token is FLY_API_TOKEN (or flyctl's own sign-in).
 *
 *   node install.mjs install --org <fly organization> --domain <copy's domain> \
 *        --key-file <update key file> --licence-file <licence file> \
 *        [--name <prefix>] [--region <code>] [--release <version|latest>]
 *        [--resend-key-file <file> | --smtp-host <host> [--smtp-port <587|465>]
 *         [--smtp-user <user> --smtp-password-file <file>]]
 *
 * Mail out goes through Resend (its key; the installer registers the domain
 * and waits for it) or through any provider over standard SMTP (the
 * installer stores the settings and names the provider's own records, which
 * only that provider knows).
 *
 * The licence is stored with the backend's keys; a design
 * partner whose contract has no licence runs with --no-licence instead.
 *
 * `install` builds a whole copy in the organization, start to finish, and can
 * be run again at any point: it carries on from what is already there. It
 * checks the organization's billing, creates the five apps (images, backend,
 * code host, router, mail receiver), the two buckets and the mail address,
 * copies one release into the copy's own registry, makes and stores the keys,
 * deploys, asks for the certificates, prints the DNS records and waits until
 * they, the certificates and (with a sending key) the mail domain check out,
 * runs a smoke test, and prints the first admin's one-time sign-up link and
 * the master key (once). What it made is recorded in ./<prefix>-copy.json,
 * names and addresses only, which the upgrade command reads.
 *
 *   node install.mjs copy --customer <id> --key-file <update key file> \
 *        --to-app <the copy's images app> [--release <version|latest>]
 *
 * `copy` takes one release from our update service and copies every image it
 * names into the copy's own Fly registry (registry.fly.io/<to-app>). From then
 * on the copy runs only from there: nothing it runs is pulled from us. The
 * update key is the one we issued with the contract; it covers the releases
 * dated on or before its end date.
 */
import {
  appendFileSync, createReadStream, createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Resolver, promises as dnsPromises } from 'node:dns';
import { connect } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';

export const UPDATES_URL = process.env.ACC_UPDATES_URL || 'https://acc-updates.fly.dev';
export const SOURCE_REPO = 'acc-copy';
const FLY_REGISTRY = 'https://registry.fly.io';
const MANIFEST_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

const say = (line) => process.stderr.write(`${line}\n`);
const basic = (user, password) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

/** Where releases come from: our update service, signed in as the customer. */
export function updatesSource({ url = UPDATES_URL, customer, key, fetchImpl = fetch }) {
  const auth = basic(customer, key);
  const get = async (pathname, init = {}) => {
    const answer = await fetchImpl(`${url}${pathname}`, { ...init, headers: { authorization: auth, ...(init.headers ?? {}) } });
    if (answer.status === 401) throw new Error('The update service did not accept this customer id and update key.');
    return answer;
  };
  return {
    async release(version = 'latest') {
      const answer = await get(`/releases/${version}/copy-release.json`);
      if (!answer.ok) throw new Error(`Release ${version}: ${answer.status} ${(await answer.text()).trim()}`);
      return answer.json();
    },
    async manifest(ref) {
      const answer = await get(`/v2/${SOURCE_REPO}/manifests/${ref}`, { headers: { accept: MANIFEST_TYPES } });
      if (!answer.ok) throw new Error(`Image ${ref}: ${answer.status} ${(await answer.text()).trim()}`);
      return { bytes: Buffer.from(await answer.arrayBuffer()), type: answer.headers.get('content-type') };
    },
    async blobTo(digest, file) {
      const answer = await get(`/v2/${SOURCE_REPO}/blobs/${digest}`);
      if (!answer.ok || !answer.body) throw new Error(`Layer ${digest}: ${answer.status}`);
      await pipeline(Readable.fromWeb(answer.body), createWriteStream(file));
    },
  };
}

/** Where the copy runs from: its own Fly registry, one app's repository. */
export function flyRegistry({ app, token, base = FLY_REGISTRY, fetchImpl = fetch }) {
  const auth = basic('x', token);
  const url = (pathname) => `${base}/v2/${app}/${pathname}`;
  return {
    async hasBlob(digest) {
      const answer = await fetchImpl(url(`blobs/${digest}`), { method: 'HEAD', headers: { authorization: auth } });
      return answer.ok;
    },
    async putBlob(digest, file) {
      const start = await fetchImpl(url('blobs/uploads/'), { method: 'POST', headers: { authorization: auth, 'content-length': '0' } });
      if (start.status !== 202) throw new Error(`Upload of ${digest} refused: ${start.status} ${(await start.text()).trim()}`);
      const location = new URL(start.headers.get('location'), base);
      location.searchParams.set('digest', digest);
      const size = statSync(file).size;
      // node:https rather than fetch: a layer can be a gigabyte, and this
      // streams it from disk with the length a registry wants up front.
      await new Promise((resolve, reject) => {
        const put = (location.protocol === 'http:' ? httpRequest : httpsRequest)(location, {
          method: 'PUT',
          headers: { authorization: auth, 'content-type': 'application/octet-stream', 'content-length': size },
        }, (res) => {
          res.resume();
          res.on('end', () => (res.statusCode === 201 ? resolve() : reject(new Error(`Upload of ${digest}: ${res.statusCode}`))));
        });
        put.on('error', reject);
        createReadStream(file).pipe(put);
      });
    },
    async putManifest(tag, bytes, type) {
      const answer = await fetchImpl(url(`manifests/${tag}`), {
        method: 'PUT', headers: { authorization: auth, 'content-type': type }, body: bytes,
      });
      if (answer.status !== 201) throw new Error(`Image ${tag} refused: ${answer.status} ${(await answer.text()).trim()}`);
      return answer.headers.get('docker-content-digest');
    },
  };
}

const sha256 = (file) => new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(`sha256:${hash.digest('hex')}`)).on('error', reject);
});

/** One image, source tag to destination tag, layer by layer. An index is
 *  narrowed to its linux/amd64 image: that is what Fly machines run. */
export async function copyImage(source, dest, tag, workdir) {
  let { bytes, type } = await source.manifest(tag);
  let doc = JSON.parse(bytes.toString('utf8'));
  if (Array.isArray(doc.manifests)) {
    const pick = doc.manifests.find((entry) => entry.platform?.os === 'linux' && entry.platform?.architecture === 'amd64');
    if (!pick) throw new Error(`${tag} has no linux/amd64 image`);
    ({ bytes, type } = await source.manifest(pick.digest));
    doc = JSON.parse(bytes.toString('utf8'));
  }
  let moved = 0;
  for (const blob of [doc.config, ...(doc.layers ?? [])]) {
    if (await dest.hasBlob(blob.digest)) continue;
    const file = path.join(workdir, blob.digest.replace(':', '-'));
    await source.blobTo(blob.digest, file);
    // Checked before it goes anywhere: a layer is only ever the bytes its
    // digest names.
    if ((await sha256(file)) !== blob.digest) throw new Error(`Layer ${blob.digest} arrived damaged`);
    await dest.putBlob(blob.digest, file);
    moved += blob.size ?? 0;
    rmSync(file, { force: true });
  }
  const digest = await dest.putManifest(tag, bytes, type);
  return { digest, moved };
}

/** Every image of one release into the copy's registry. */
export async function copyRelease({ source, dest, version = 'latest', log = say }) {
  const release = await source.release(version);
  const workdir = mkdtempSync(path.join(tmpdir(), 'acc-copy-'));
  const copied = {};
  try {
    for (const [name, image] of Object.entries(release.images)) {
      const started = Date.now();
      const { digest, moved } = await copyImage(source, dest, image.tag, workdir);
      copied[name] = { tag: image.tag, digest };
      log(`  ${name.padEnd(12)} ${image.tag}  ${(moved / 1e6).toFixed(0)} MB moved in ${((Date.now() - started) / 1000).toFixed(0)} s`);
    }
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
  return { release, copied };
}

// ── The installer: one command, an organization and a domain ──

const DOMAIN_SHAPE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const PREFIX_SHAPE = /^[a-z][a-z0-9-]{0,40}[a-z0-9]$/;
const FLY_GRAPHQL = 'https://api.fly.io/graphql';
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const lastLines = (text, n = 6) => String(text ?? '').trim().split('\n').slice(-n).join('\n');

/** What an update key says about itself: who it was issued to and for which
 *  domain. The update service checks the signature; this only reads. */
export function readUpdateKey(text) {
  const key = String(text ?? '').trim();
  const parts = key.split('.');
  if (parts.length !== 3 || parts[0] !== 'acc1') throw new Error('That file does not hold an update key (one line starting acc1.).');
  let payload = null;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { /* damaged, below */ }
  if (payload?.kind !== 'update' || !payload.customer || !payload.domain) throw new Error('That update key is damaged. Ask us for the file again.');
  return { key, customer: payload.customer, domain: payload.domain, until: payload.updatesUntil };
}

/** Everything a copy is made of, named from one prefix. Fly app names are
 *  shared by every Fly customer, so the prefix must be one nobody else took. */
export function namesFor(prefix) {
  return {
    images: `${prefix}-images`,
    backend: `${prefix}-backend`,
    git: `${prefix}-git`,
    router: `${prefix}-router`,
    mx: `${prefix}-mx`,
    media: `${prefix}-media`,
    backups: `${prefix}-backups`,
  };
}

const q = (value) => JSON.stringify(String(value));
const envBlock = (env) => Object.entries(env).map(([name, value]) => `  ${name} = ${q(value)}`).join('\n');

/** The backend's settings. Every name a copy hands out is its own domain;
 *  every image is in its own registry; PRIVATE_COPY turns on what a copy does
 *  differently (invite-only, its own code host and spend). */
export function backendEnv({ names, org, region, domain, tags, peerIp, version, extra = {} }) {
  const image = (name) => `registry.fly.io/${names.images}:${tags[name]}`;
  return {
    NODE_ENV: 'production',
    PORT: '8080',
    SQLITE_DB_PATH: '/data/backend.db',
    DEPLOY_STAGING_DIR: '/data/deploy-staging',
    FLY_ORG: org,
    FLY_REGION: region,
    FLY_IDLE_STOP_MINUTES: '3',
    FLY_VOLUME_SIZE_GB: '5',
    HARNESS_STREAM_INPUT: '1',
    FLY_MACHINE_IMAGE: image('machine'),
    FLY_APP_RUNTIME_IMAGE: image('app-runtime'),
    FLY_GIT_HOST_IMAGE: image('git-host'),
    FLY_MSG_HOST_IMAGE: image('msg-host'),
    FLY_IMAGE_APP: names.images,
    WORKSPACE_URL: `https://${domain}`,
    WORKSPACE_COMPATIBLE_ORIGINS: `https://${names.backend}.fly.dev`,
    AGENTBUILT_API_URL: `https://${domain}`,
    CORS_ORIGIN: `https://${domain}`,
    GIT_HOST_BASE_URL: `https://git.${domain}`,
    GIT_HOST_CONTROL_URL: `https://${names.git}.fly.dev`,
    APPS_DOMAIN: domain,
    MAIL_DOMAIN: domain,
    PRIVATE_COPY: '1',
    // What the health page says the copy runs.
    ...(version ? { COPY_RELEASE: version } : {}),
    ...(peerIp ? { FLY_BACKEND_PEER_IP: peerIp } : {}),
    // The admin's own additions, kept in the state file's extraEnv.backend.
    ...extra,
  };
}

/** The four apps' Fly configurations for one copy and one release. */
export function appConfigs({ names, org, region, domain, tags, peerIp, version, extraEnv = {} }) {
  const head = (app, what) => [
    `# ${what}: your own Agentic Cloud at ${domain}, release ${version}. Written by install.mjs;`,
    '# the installer and the upgrade command write it again, so change it there.',
    `app = ${q(app)}`,
    `primary_region = ${q(region)}`,
  ].join('\n');
  const vm = (size, memory) => `[[vm]]\n  size = ${q(size)}\n  memory = ${q(memory)}`;
  const check = (path, grace) => [
    '[[http_service.checks]]',
    `  grace_period = ${q(grace)}`,
    '  interval = "30s"',
    '  method = "GET"',
    '  timeout = "5s"',
    `  path = ${q(path)}`,
  ].join('\n');
  const http = (alwaysOn) => [
    '[http_service]',
    '  internal_port = 8080',
    '  force_https = true',
    `  auto_stop_machines = ${alwaysOn ? '"off"' : '"stop"'}`,
    '  auto_start_machines = true',
    `  min_machines_running = ${alwaysOn ? 1 : 0}`,
  ].join('\n');
  const mount = (source, size, snapshots = true) => [
    '[[mounts]]',
    `  source = ${q(source)}`,
    '  destination = "/data"',
    `  initial_size = ${q(size)}`,
    ...(snapshots ? ['  snapshot_retention = 7'] : []),
  ].join('\n');
  const internal = `http://${names.backend}.internal:8080`;
  return {
    backend: [
      head(names.backend, 'The Workspace and everything behind it'),
      'kill_signal = "SIGTERM"\nkill_timeout = "30s"',
      `[env]\n${envBlock(backendEnv({ names, org, region, domain, tags, peerIp, version, extra: extraEnv.backend }))}`,
      mount('backend_data', '3gb'),
      `${http(true)}\n  [http_service.concurrency]\n    type = "requests"\n    soft_limit = 200\n    hard_limit = 250`,
      check('/api/health', '60s'),
      vm('shared-cpu-2x', '2gb'),
    ].join('\n\n'),
    git: [
      head(names.git, 'The code host'),
      `[env]\n${envBlock({
        HOST: '::',
        PORT: '8080',
        DATA_ROOT: '/data',
        BACKEND_URL: `https://${domain}`,
        CI_WEBHOOK_URL: `https://${domain}/api/agent-cli/git/ci-webhook`,
        COMMIT_EMAIL: `noreply@${domain}`,
      })}`,
      mount('git_data', '3gb'),
      http(false),
      vm('shared-cpu-1x', '512mb'),
    ].join('\n\n'),
    router: [
      head(names.router, 'Previews and sites on *.' + domain),
      `[env]\n${envBlock({ APPS_DOMAIN: domain, BACKEND_URL: internal, PORT: '8080' })}`,
      http(true),
      check('/__router/health', '10s'),
      vm('shared-cpu-1x', '256mb'),
    ].join('\n\n'),
    mx: [
      head(names.mx, 'The mail receiver'),
      `[env]\n${envBlock({
        MAIL_DOMAIN: domain,
        MX_HOSTNAME: `mx.${domain}`,
        BACKEND_URL: internal,
        PORT: '2525',
        CERT_DIR: '/data/tls',
        HTTP_PORT: '8080',
      })}`,
      [
        '[[services]]',
        '  internal_port = 2525',
        '  protocol = "tcp"',
        '  auto_stop_machines = "off"',
        '  auto_start_machines = true',
        '  min_machines_running = 1',
        '  [[services.ports]]',
        '    port = 25',
        '    handlers = ["proxy_proto"]',
        '    [services.ports.proxy_proto_options]',
        '      version = "v1"',
        '  [[services.tcp_checks]]',
        '    interval = "30s"',
        '    timeout = "5s"',
        '    grace_period = "10s"',
      ].join('\n'),
      '# Port 80 on the receiver\'s own address: Let\'s Encrypt\'s HTTP-01 check and /health.',
      [
        '[[services]]',
        '  internal_port = 8080',
        '  protocol = "tcp"',
        '  auto_stop_machines = "off"',
        '  auto_start_machines = true',
        '  [[services.ports]]',
        '    port = 80',
        '    handlers = ["http"]',
      ].join('\n'),
      mount('mx_data', '1gb', false),
      vm('shared-cpu-1x', '256mb'),
    ].join('\n\n'),
  };
}

/** The records the copy's domain needs, all DNS only (never proxied). */
export function dnsRecords({ domain, names, backendV4, backendV6, mxV4, acmeTarget, provider = [] }) {
  return [
    { name: domain, type: 'A', value: backendV4, why: 'the Workspace' },
    { name: domain, type: 'AAAA', value: backendV6, why: 'the Workspace' },
    { name: domain, type: 'MX', value: `mx.${domain}`, priority: 10, why: 'mail in' },
    { name: `mx.${domain}`, type: 'A', value: mxV4, why: 'the mail receiver' },
    { name: `git.${domain}`, type: 'CNAME', value: `${names.git}.fly.dev`, why: 'the code host' },
    { name: `*.${domain}`, type: 'CNAME', value: `${names.router}.fly.dev`, why: 'previews and sites' },
    { name: `_acme-challenge.${domain}`, type: 'CNAME', value: acmeTarget, why: 'the certificate for previews and sites' },
    { name: `_dmarc.${domain}`, type: 'TXT', value: 'v=DMARC1; p=quarantine', why: 'mail that is not ours goes to spam' },
    ...provider,
  ];
}

export function formatRecords(records) {
  const width = Math.max(...records.map((record) => record.name.length));
  return records.map((record) => {
    const value = record.type === 'MX' ? `${record.priority} ${record.value}` : record.type === 'TXT' ? q(record.value) : record.value;
    return `  ${record.name.padEnd(width)}  ${record.type.padEnd(5)}  ${value}`;
  }).join('\n');
}

const bareHost = (value) => String(value ?? '').trim().replace(/\.$/, '').toLowerCase();
const sameAddress = (a, b) => {
  const norm = (ip) => (String(ip).includes(':') ? new URL(`http://[${ip}]`).hostname.slice(1, -1) : String(ip));
  try { return norm(a) === norm(b); } catch { return false; }
};

/** Asks the domain's own name servers, never a public resolver: a name asked
 *  before it exists is remembered as missing by resolvers for up to an hour,
 *  and the installer asks early and often. */
export async function authoritativeResolver(domain, { resolveNs = dnsPromises.resolveNs, resolve4 = dnsPromises.resolve4 } = {}) {
  const labels = domain.split('.');
  for (let i = 0; i < labels.length - 1; i += 1) {
    const zone = labels.slice(i).join('.');
    let servers = [];
    try { servers = await resolveNs(zone); } catch { continue; }
    const addresses = [];
    for (const server of servers) {
      try { addresses.push(...await resolve4(server)); } catch { /* the next one */ }
    }
    if (!addresses.length) continue;
    const resolver = new Resolver({ timeout: 4000, tries: 2 });
    resolver.setServers(addresses);
    return { zone, resolver };
  }
  throw new Error(`Could not find the name servers for ${domain}.`);
}

/** Whether one record answers as it should, and what it answers instead. */
export async function checkRecord(resolver, record) {
  const ask = (fn, name) => new Promise((resolve) => {
    resolver[fn](name, (error, answer) => resolve(error ? [] : answer));
  });
  // A wildcard is asked through a name under it.
  const name = record.name.startsWith('*.') ? `install-check.${record.name.slice(2)}` : record.name;
  let seen = [];
  if (record.type === 'A') seen = await ask('resolve4', name);
  else if (record.type === 'AAAA') seen = await ask('resolve6', name);
  else if (record.type === 'CNAME') seen = (await ask('resolveCname', name)).map(bareHost);
  else if (record.type === 'MX') seen = (await ask('resolveMx', name)).map((mx) => `${mx.priority} ${bareHost(mx.exchange)}`);
  else if (record.type === 'TXT') seen = (await ask('resolveTxt', name)).map((chunks) => chunks.join(''));
  const want = record.type === 'MX' ? `${record.priority} ${bareHost(record.value)}` : record.type === 'CNAME' ? bareHost(record.value) : record.value;
  // Any DMARC policy the domain's owner prefers will do; ours is a suggestion.
  const matches = record.name.startsWith('_dmarc.')
    ? (answer) => answer.startsWith('v=DMARC1')
    : (answer) => (record.type === 'A' || record.type === 'AAAA' ? sameAddress(answer, want) : answer === want);
  const ok = seen.some(matches);
  return { ok, seen };
}

/** flyctl, run with the copy's token. Output goes to the install log, except
 *  a command marked quiet, whose output holds keys. */
export function flyRunner({ bin, token, logFile }) {
  return (args, { input, quiet = false, cwd } = {}) => new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env: { ...process.env, FLY_API_TOKEN: token, FLY_NO_UPDATE_CHECK: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (logFile) appendFileSync(logFile, `\n$ fly ${args.join(' ')}\n${quiet ? '(output not kept: it holds keys)\n' : out}${err}`, { mode: 0o600 });
      if (code === 0) return resolve(out);
      reject(new Error(`fly ${args.slice(0, 2).join(' ')}: ${lastLines(err || (quiet ? '' : out)) || `exit ${code}`}`));
    });
    child.stdin.end(input ?? '');
  });
}

export function findFlyctl(env = process.env) {
  if (env.FLYCTL) return env.FLYCTL;
  for (const dir of String(env.PATH ?? '').split(path.delimiter)) {
    for (const name of ['fly', 'flyctl']) {
      const candidate = path.join(dir, name);
      if (dir && existsSync(candidate)) return candidate;
    }
  }
  const home = path.join(homedir(), '.fly', 'bin', 'flyctl');
  return existsSync(home) ? home : null;
}

export async function flyGraphql(token, query, variables = {}, fetchImpl = fetch) {
  const answer = await fetchImpl(FLY_GRAPHQL, {
    method: 'POST',
    headers: { authorization: token.startsWith('FlyV1 ') ? token : `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await answer.json().catch(() => ({}));
  if (body.errors?.length) throw new Error(body.errors.map((error) => error.message).join('; '));
  if (!answer.ok) throw new Error(`Fly answered ${answer.status}`);
  return body.data;
}

/** The organization can pay for what the copy needs, or the install stops
 *  before anything is made. */
export async function checkOrganization(token, org, fetchImpl = fetch) {
  let data;
  try {
    data = await flyGraphql(token, 'query($slug: String!) { organization(slug: $slug) { slug name billable billingStatus } nearestRegion { code } }', { slug: org }, fetchImpl);
  } catch (error) {
    throw new Error(`Fly did not show the organization ${org} to this token (${error.message}). Use a token of that organization.`);
  }
  const found = data?.organization;
  if (!found) throw new Error(`There is no Fly organization ${org} for this token.`);
  if (!found.billable) throw new Error(`The organization ${org} has no card on file. Your own Agentic Cloud needs one (its mail address is a dedicated IPv4). Add it at fly.io/dashboard/${org}/billing and run this again.`);
  if (found.billingStatus !== 'CURRENT') {
    throw new Error(`Fly says the organization ${org}'s bill is not paid (${String(found.billingStatus).toLowerCase().replace('_', ' ')}), and it refuses to create anything until it is. Settle it at fly.io/dashboard/${org}/billing and run this again.`);
  }
  return { name: found.name, nearestRegion: data.nearestRegion?.code ?? null };
}

/** An Ed25519 key pair in OpenSSH's own format, the one the backend uses to
 *  reach its agents' machines (no ssh-keygen needed on the engineer's side). */
export function sshKeyPair(comment) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url');
  const u32 = (n) => { const buf = Buffer.alloc(4); buf.writeUInt32BE(n); return buf; };
  const str = (value) => { const buf = Buffer.from(value); return Buffer.concat([u32(buf.length), buf]); };
  const wirePub = Buffer.concat([str('ssh-ed25519'), str(pub)]);
  const check = randomBytes(4);
  let secret = Buffer.concat([check, check, str('ssh-ed25519'), str(pub), str(Buffer.concat([seed, pub])), str(comment)]);
  for (let pad = 1; secret.length % 8 !== 0; pad += 1) secret = Buffer.concat([secret, Buffer.from([pad])]);
  const body = Buffer.concat([Buffer.from('openssh-key-v1\0'), str('none'), str('none'), str(''), u32(1), str(wirePub), str(secret)]);
  return {
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${body.toString('base64').match(/.{1,70}/g).join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`,
    publicKey: `ssh-ed25519 ${wirePub.toString('base64')} ${comment}`,
  };
}

/** `fly storage create` prints a bucket's keys once, as NAME: value lines. */
export function bucketKeys(output) {
  const found = {};
  for (const line of String(output).split('\n')) {
    const match = /^\s*(AWS_[A-Z_0-9]+|BUCKET_NAME):\s*(\S+)\s*$/.exec(line);
    if (match) found[match[1]] = match[2];
  }
  if (!found.AWS_ACCESS_KEY_ID || !found.AWS_SECRET_ACCESS_KEY || !found.BUCKET_NAME) throw new Error('fly storage create did not print the bucket\'s keys');
  return {
    bucket: found.BUCKET_NAME,
    endpoint: found.AWS_ENDPOINT_URL_S3 || 'https://fly.storage.tigris.dev',
    region: found.AWS_REGION || 'auto',
    accessKeyId: found.AWS_ACCESS_KEY_ID,
    secretAccessKey: found.AWS_SECRET_ACCESS_KEY,
  };
}

/** The sending provider (Resend): the domain registered, its records, and
 *  whether it has verified them. */
export function resendProvider({ key, fetchImpl = fetch, base = 'https://api.resend.com' }) {
  const call = async (method, pathname, body) => {
    const answer = await fetchImpl(`${base}${pathname}`, {
      method,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const parsed = await answer.json().catch(() => ({}));
    if (!answer.ok) throw new Error(`Resend ${method} ${pathname}: ${answer.status} ${parsed.message ?? ''}`.trim());
    return parsed;
  };
  const records = (domain, list) => (list ?? []).map((record) => ({
    name: record.name && !record.name.endsWith(domain) ? `${record.name}.${domain}` : (record.name || domain),
    type: record.type,
    value: record.value,
    ...(record.priority !== undefined ? { priority: record.priority } : {}),
    why: `mail out (${record.record ?? 'sending'})`,
  }));
  return {
    async register(domain) {
      const listed = await call('GET', '/domains');
      const existing = (listed.data ?? []).find((entry) => entry.name === domain);
      const made = existing ? await call('GET', `/domains/${existing.id}`) : await call('POST', '/domains', { name: domain });
      const id = made.id ?? existing?.id;
      return { id, records: records(domain, made.records ?? (await call('GET', `/domains/${id}`)).records) };
    },
    async verified(id) {
      const found = await call('GET', `/domains/${id}`);
      if (found.status === 'verified') return true;
      await call('POST', `/domains/${id}/verify`).catch(() => {});
      return false;
    },
  };
}

/** What the copy answers once it is up: every piece, over its own names. */
export async function smokeTest({ domain, mxV4, fetchImpl = fetch, smtpBanner = readSmtpBanner }) {
  const results = [];
  const probe = async (what, run) => {
    try {
      const detail = await run();
      results.push({ what, ok: true, detail });
    } catch (error) {
      results.push({ what, ok: false, detail: error.message });
    }
  };
  const json = async (url) => {
    const answer = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
    if (!answer.ok) throw new Error(`${url} answered ${answer.status}`);
    return answer.json();
  };
  await probe(`https://${domain} answers`, async () => {
    const health = await json(`https://${domain}/api/health`);
    if (health.status !== 'ok') throw new Error(`health says ${JSON.stringify(health)}`);
    return 'healthy';
  });
  await probe('the sign-up page is its own', async () => {
    const answer = await fetchImpl(`https://${domain}/signup`, { signal: AbortSignal.timeout(20_000) });
    const page = await answer.text();
    if (!page.includes('<meta name="acc-private-copy" content="1">')) throw new Error('the page does not say it is your own Agentic Cloud');
    if (!page.includes(`<meta name="acc-public-host" content="${domain}">`)) throw new Error(`the page does not name ${domain}`);
    return 'invite-only, on its own name';
  });
  await probe(`https://git.${domain} answers`, async () => {
    const health = await json(`https://git.${domain}/health`);
    if (!health.ok) throw new Error(`health says ${JSON.stringify(health)}`);
    return `disk ${health.diskUsedPercent}% used`;
  });
  await probe(`previews and sites (*.${domain}) answer`, async () => {
    const health = await json(`https://install-check-${randomBytes(3).toString('hex')}.${domain}/__router/health`);
    if (!health.ok || health.domain !== domain) throw new Error(`router says ${JSON.stringify(health)}`);
    return 'certificate and router fine';
  });
  await probe(`mail in (mx.${domain}) offers encryption`, async () => {
    const health = await json(`http://${mxV4}/health`);
    if (!health.starttls) throw new Error('the mail receiver has no certificate yet');
    return 'STARTTLS on';
  });
  // Port 25 is closed on many home and office networks, so a silent port is
  // reported, never counted against the copy.
  const banner = await smtpBanner(mxV4).catch((error) => `not reachable from this computer (${error.message}); many networks close port 25 outbound`);
  results.push({ what: `mail in (mx.${domain}) port 25`, ok: true, soft: true, detail: banner });
  return results;
}

export function readSmtpBanner(host, port = 25, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('no answer in 10 s')); }, timeoutMs);
    socket.once('data', (data) => {
      clearTimeout(timer);
      socket.end('QUIT\r\n');
      const line = String(data).split('\r\n')[0];
      if (line.startsWith('220')) resolve(line); else reject(new Error(line));
    });
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

const jsonList = (text) => JSON.parse(text || '[]') ?? [];
const minutes = (ms) => `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;

/**
 * The whole install. Every step records itself in the state file when it is
 * done, so running the command again carries on from the first step that is
 * not; nothing is made twice. Keys live in the state file (mode 600) only
 * until they are stored in Fly, and the two the admin must see (the master
 * key and the first account's code) until they are printed at the end.
 */
export async function install(options, deps = {}) {
  const log = deps.say ?? say;
  const started = Date.now();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 20) throw new Error(`Node ${process.versions.node} is too old; the installer needs 20 or newer.`);

  const updateKey = readUpdateKey(readFileSync(options['key-file'], 'utf8'));
  const domain = String(options.domain ?? '').toLowerCase().replace(/\.$/, '');
  const org = String(options.org ?? '');
  if (!org) throw new Error('--org is the Fly organization your own Agentic Cloud goes into (its slug, as `fly orgs list` shows).');
  if (!DOMAIN_SHAPE.test(domain)) throw new Error('--domain is the name your own Agentic Cloud lives on, like agents.theirco.com.');
  if (updateKey.domain !== domain) throw new Error(`This update key was issued for ${updateKey.domain}, not ${domain}. Ask us for a key for ${domain}, or use that domain.`);
  const smtpHost = options['smtp-host'] ? String(options['smtp-host']).trim() : '';
  if (smtpHost && options['resend-key-file']) throw new Error('Mail out goes one way: --resend-key-file or --smtp-host, not both.');
  if (smtpHost && options['smtp-user'] && !options['smtp-password-file']) throw new Error('--smtp-user needs --smtp-password-file.');
  // The licence, or its deliberate absence. Read for its domain
  // only: the copy itself checks the signature.
  let licenceText = null;
  if (options['licence-file']) {
    licenceText = readFileSync(options['licence-file'], 'utf8').trim();
    let payload = null;
    try { payload = JSON.parse(Buffer.from(licenceText.split('.')[1] ?? '', 'base64url').toString('utf8')); } catch { /* below */ }
    if (payload?.kind !== 'licence') throw new Error('That file does not hold a licence. Ask us for the licence file.');
    if (payload.domain !== domain) throw new Error(`This licence was issued for ${payload.domain}, not ${domain}.`);
  } else if (!options['no-licence'] && !existsSync(path.resolve(options.state ?? `${String(options.name ?? updateKey.customer).toLowerCase()}-copy.json`))) {
    throw new Error('Your own Agentic Cloud needs its licence: --licence-file <file>. Run with --no-licence only if your contract says it has none.');
  }
  const prefix = String(options.name ?? updateKey.customer).toLowerCase();
  if (!PREFIX_SHAPE.test(prefix)) throw new Error('--name is a short lowercase prefix for its app names, like theirco.');
  const names = namesFor(prefix);

  const stateFile = path.resolve(options.state ?? `${prefix}-copy.json`);
  const logFile = path.resolve(`${prefix}-install.log`);
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { steps: {} };
  if (state.domain && state.domain !== domain) throw new Error(`${stateFile} is the record of ${state.domain}, not ${domain}.`);
  const save = () => writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  Object.assign(state, { prefix, org, domain, customer: updateKey.customer });
  if (options['no-licence']) state.extraEnv = { ...state.extraEnv, backend: { ...state.extraEnv?.backend, COPY_LICENCE: 'off' } };

  const bin = deps.flyctl ?? findFlyctl();
  if (!bin) throw new Error('flyctl is not installed. Install it (fly.io/docs/flyctl/install) and run this again.');
  let token = deps.token ?? process.env.FLY_API_TOKEN ?? '';
  const fly = deps.fly ?? ((args, opts) => flyRunner({ bin, token, logFile })(args, opts));
  if (!token) token = (await fly(['auth', 'token'], { quiet: true })).trim();
  if (!token) throw new Error('No Fly token: set FLY_API_TOKEN, or sign in with `fly auth login`.');

  let stepNumber = 0;
  const STEPS = 11;
  const step = async (key, title, run) => {
    stepNumber += 1;
    const label = `[${String(stepNumber).padStart(2)}/${STEPS}] ${title}`;
    if (state.steps[key]) { log(`${label}: done before`); return; }
    const at = Date.now();
    log(`${label}…`);
    await run();
    state.steps[key] = new Date().toISOString();
    save();
    log(`${' '.repeat(8)}done in ${((Date.now() - at) / 1000).toFixed(0)} s`);
  };
  const setSecrets = async (app, values) => {
    const lines = Object.entries(values).map(([name, value]) => `${name}=${String(value).replace(/\n/g, '\\n')}`).join('\n');
    // Before the first deploy they wait for it; afterwards they restart the app.
    await fly(['secrets', 'import', '-a', app, ...(state.steps.deploy ? [] : ['--stage'])], { input: `${lines}\n`, quiet: true });
  };
  const ips = async (app) => jsonList(await fly(['ips', 'list', '-a', app, '--json']));

  log(`Your own Agentic Cloud for ${domain}, in the Fly organization ${org} (apps ${prefix}-*).`);
  log(`State: ${stateFile}   Log: ${logFile}`);

  // 1. Before anything is made: the organization can pay, the key opens a release.
  stepNumber += 1;
  log(`[ 1/${STEPS}] Checking the organization, the update key and the release…`);
  const orgFacts = await checkOrganization(token, org, fetchImpl);
  state.region = state.region ?? options.region ?? orgFacts.nearestRegion ?? 'iad';
  const source = (deps.updatesSource ?? updatesSource)({ customer: updateKey.customer, key: updateKey.key, url: options.updates || UPDATES_URL, fetchImpl });
  const release = state.release ?? await source.release(options.release || 'latest');
  log(`        ${orgFacts.name}: billing current. Region ${state.region}. Release ${release.version}. Update key good for releases until ${updateKey.until}.`);
  save();

  await step('apps', 'Creating the five apps', async () => {
    const listed = jsonList(await fly(['apps', 'list', '-o', org, '--json'])).map((app) => app.Name ?? app.name);
    for (const app of [names.images, names.backend, names.git, names.router, names.mx]) {
      if (listed.includes(app)) continue;
      try {
        await fly(['apps', 'create', app, '-o', org]);
      } catch (error) {
        if (/taken|already exists/i.test(error.message)) throw new Error(`The app name ${app} belongs to someone else on Fly. Run again with --name <another prefix>.`);
        throw error;
      }
    }
  });

  await step('release', `Copying release ${release.version} into registry.fly.io/${names.images}`, async () => {
    const dest = (deps.flyRegistry ?? flyRegistry)({ app: names.images, token, fetchImpl });
    const { copied } = await (deps.copyRelease ?? copyRelease)({ source, dest, version: release.version, log });
    state.release = { version: release.version, commit: release.commit, tags: Object.fromEntries(Object.entries(copied).map(([name, image]) => [name, image.tag])) };
  });

  await step('buckets', 'Creating the two buckets (files, database backups)', async () => {
    state.pending = state.pending ?? {};
    for (const [key, bucket] of [['media', names.media], ['backups', names.backups]]) {
      if (state.pending[key]) continue;
      const output = await fly(['storage', 'create', '-n', bucket, '-o', org, '--yes'], { quiet: true });
      state.pending[key] = bucketKeys(output);
      save();
    }
  });

  await step('keys', 'Making the keys', async () => {
    const ssh = sshKeyPair(`${names.backend}@${domain}`);
    let backendToken = null;
    try {
      const minted = (await fly(['tokens', 'create', 'org', '-o', org, '-n', `${names.backend} (your own Agentic Cloud)`, '-x', '87600h'], { quiet: true })).trim();
      backendToken = minted.split('\n').find((line) => line.startsWith('FlyV1 ')) ?? null;
    } catch { /* an organization token cannot make another: the backend keeps this one */ }
    if (!backendToken) log('        The backend keeps the organization token this install runs with (it cannot make a second one).');
    state.pending = {
      ...state.pending,
      FLY_API_TOKEN: backendToken ?? token,
      FLY_SSH_PRIVATE_KEY: ssh.privateKey,
      FLY_SSH_PUBLIC_KEY: ssh.publicKey,
      SECRETS_MASTER_KEY: randomBytes(32).toString('base64'),
      GIT_HOST_SECRET: randomBytes(32).toString('hex'),
      CI_STATUS_SECRET: randomBytes(32).toString('hex'),
      MAIL_INGEST_SECRET: randomBytes(32).toString('hex'),
      FIRST_ACCOUNT_CODE: randomBytes(18).toString('base64url'),
    };
  });

  await step('secrets', 'Storing the keys in Fly', async () => {
    const p = state.pending;
    await setSecrets(names.backend, {
      FLY_API_TOKEN: p.FLY_API_TOKEN,
      FLY_SSH_PRIVATE_KEY: p.FLY_SSH_PRIVATE_KEY,
      FLY_SSH_PUBLIC_KEY: p.FLY_SSH_PUBLIC_KEY,
      SECRETS_MASTER_KEY: p.SECRETS_MASTER_KEY,
      GIT_HOST_SECRET: p.GIT_HOST_SECRET,
      CI_STATUS_SECRET: p.CI_STATUS_SECRET,
      MAIL_INGEST_SECRET: p.MAIL_INGEST_SECRET,
      FIRST_ACCOUNT_CODE: p.FIRST_ACCOUNT_CODE,
      ...(licenceText ? { LICENCE: licenceText } : {}),
      MEDIA_S3_ENDPOINT: p.media.endpoint,
      MEDIA_S3_BUCKET: p.media.bucket,
      MEDIA_S3_REGION: p.media.region,
      MEDIA_S3_ACCESS_KEY_ID: p.media.accessKeyId,
      MEDIA_S3_SECRET_ACCESS_KEY: p.media.secretAccessKey,
      BACKUP_S3_ENDPOINT: p.backups.endpoint,
      BACKUP_S3_BUCKET: p.backups.bucket,
      BACKUP_S3_ACCESS_KEY_ID: p.backups.accessKeyId,
      BACKUP_S3_SECRET_ACCESS_KEY: p.backups.secretAccessKey,
    });
    await setSecrets(names.git, { GIT_HOST_SECRET: p.GIT_HOST_SECRET, CI_WEBHOOK_SECRET: p.GIT_HOST_SECRET });
    await setSecrets(names.mx, { MAIL_INGEST_SECRET: p.MAIL_INGEST_SECRET });
    // Stored: from here the file keeps only what the admin is shown at the end.
    state.pending = { SECRETS_MASTER_KEY: p.SECRETS_MASTER_KEY, FIRST_ACCOUNT_CODE: p.FIRST_ACCOUNT_CODE };
  });

  await step('addresses', 'Taking the addresses (the mail receiver\'s own IPv4)', async () => {
    for (const app of [names.backend, names.git, names.router]) {
      const have = await ips(app);
      if (!have.some((ip) => ip.Type === 'shared_v4' || ip.Type === 'v4')) await fly(['ips', 'allocate-v4', '--shared', '-a', app, '--yes']);
      if (!have.some((ip) => ip.Type === 'v6')) await fly(['ips', 'allocate-v6', '-a', app]);
    }
    // Mail cannot share an IPv4 with other Fly apps: a dedicated one, $2 a month.
    if (!(await ips(names.mx)).some((ip) => ip.Type === 'v4')) await fly(['ips', 'allocate-v4', '-a', names.mx, '--yes']);
  });

  const deployApp = (which, peerIp) => deployOne({ fly, state, names, which, release: state.release, peerIp });

  await step('deploy', 'Starting the four apps from your own registry', async () => {
    for (const which of ['backend', 'git', 'router', 'mx']) {
      const at = Date.now();
      await deployApp(which);
      log(`        ${names[which].padEnd(22)} up in ${((Date.now() - at) / 1000).toFixed(0)} s`);
    }
    // The backend pins its agents' machines to its own private address, which
    // exists only once its machine does.
    const machines = jsonList(await fly(['machine', 'list', '-a', names.backend, '--json']));
    state.peerIp = machines[0]?.private_ip;
    if (!state.peerIp) throw new Error('the backend\'s machine has no private address yet');
    await deployApp('backend', state.peerIp);
  });

  await step('certificates', 'Asking for the certificates', async () => {
    for (const [app, host] of [[names.backend, domain], [names.git, `git.${domain}`], [names.router, `*.${domain}`]]) {
      const have = jsonList(await fly(['certs', 'list', '-a', app, '--json'])).map((cert) => cert.Hostname ?? cert.hostname);
      if (!have.includes(host)) await fly(['certs', 'add', host, '-a', app]);
    }
    const wildcard = JSON.parse(await fly(['certs', 'show', `*.${domain}`, '-a', names.router, '--json']));
    state.acmeTarget = bareHost(wildcard.dns_requirements?.acme_challenge?.target);
    const backendIps = await ips(names.backend);
    state.backendV4 = backendIps.find((ip) => ip.Type === 'shared_v4' || ip.Type === 'v4')?.Address;
    state.backendV6 = backendIps.find((ip) => ip.Type === 'v6')?.Address;
    state.mxV4 = (await ips(names.mx)).find((ip) => ip.Type === 'v4')?.Address;
    if (!state.acmeTarget || !state.backendV4 || !state.backendV6 || !state.mxV4) throw new Error('Fly did not report every address yet; run again in a minute.');
  });

  const resendKey = options['resend-key-file'] ? readFileSync(options['resend-key-file'], 'utf8').trim() : null;
  if (smtpHost && !state.sending) {
    log(`        Sending mail out through ${smtpHost}…`);
    await setSecrets(names.backend, {
      SMTP_HOST: smtpHost,
      SMTP_PORT: String(options['smtp-port'] ?? 587),
      ...(options['smtp-user']
        ? { SMTP_USER: String(options['smtp-user']), SMTP_PASSWORD: readFileSync(options['smtp-password-file'], 'utf8').trim() }
        : {}),
    });
    state.sending = { provider: 'smtp', host: smtpHost };
    save();
  }
  const provider = resendKey ? (deps.resendProvider ?? resendProvider)({ key: resendKey, fetchImpl }) : null;
  if (provider && !state.sending) {
    log(`        Registering ${domain} with Resend for mail out…`);
    const { id, records } = await provider.register(domain);
    await setSecrets(names.backend, { RESEND_API_KEY: resendKey, RESEND_MAIL_API_KEY: resendKey });
    state.sending = { provider: 'resend', id, records };
    save();
  }

  const records = dnsRecords({
    domain, names, backendV4: state.backendV4, backendV6: state.backendV6, mxV4: state.mxV4, acmeTarget: state.acmeTarget, provider: state.sending?.records,
  });
  await step('dns', 'Waiting for the DNS records, the certificates and the mail domain', async () => {
    log(`\n  Add these ${records.length} records at ${domain}'s DNS provider, all DNS only (not proxied):\n\n${formatRecords(records)}\n`);
    if (state.sending?.provider === 'smtp') {
      log(`  Also add the SPF and DKIM records ${state.sending.host} gives you for ${domain}: only that provider knows`);
      log('  them, so the installer does not wait for them. Without them mail out goes to spam.\n');
    }
    log('  The installer checks them with the domain\'s own name servers every 15 s. You can stop it and');
    log('  run the same command again later: it carries on from here.\n');
    const { resolver } = await (deps.authoritativeResolver ?? authoritativeResolver)(domain);
    const deadline = Date.now() + Number(options.wait ?? 60) * 60_000;
    let said = '';
    let mxNamedAt = 0;
    let mxRestartedAt = 0;
    let mxRestarts = 0;
    let certsCheckedAt = 0;
    for (;;) {
      const missing = [];
      for (const record of records) if (!(await checkRecord(resolver, record)).ok) missing.push(record);
      const certs = {};
      for (const [app, host] of [[names.backend, domain], [names.git, `git.${domain}`], [names.router, `*.${domain}`]]) {
        certs[host] = JSON.parse(await fly(['certs', 'show', host, '-a', app, '--json'])).status;
      }
      const certsWaiting = Object.entries(certs).filter(([, status]) => status !== 'Ready').map(([host]) => host);
      let mailCert = false;
      try {
        mailCert = Boolean((await (await fetchImpl(`http://${state.mxV4}/health`, { signal: AbortSignal.timeout(5000) })).json()).starttls);
      } catch { /* not up yet */ }
      const mxNameReady = !missing.some((record) => record.name === `mx.${domain}`);
      mxNamedAt = mxNameReady ? mxNamedAt || Date.now() : 0;
      // The receiver asks Let's Encrypt when it starts and twice a day; once its
      // name points at it, a restart makes it ask now. Not the moment the name
      // appears (asked within seconds, the proof's first try failed: Let's
      // Encrypt still saw the old answer), and at most four times, inside Let's
      // Encrypt's limit of five failures an hour.
      const settled = mxNamedAt && Date.now() - mxNamedAt >= (deps.settleMs ?? 60_000);
      if (settled && !mailCert && mxRestarts < 4 && Date.now() - mxRestartedAt > 5 * 60_000) {
        await fly(['apps', 'restart', names.mx]);
        mxRestartedAt = Date.now();
        mxRestarts += 1;
      }
      if (!missing.length && certsWaiting.length && Date.now() - certsCheckedAt > 60_000) {
        for (const host of certsWaiting) {
          const app = host === domain ? names.backend : host.startsWith('git.') ? names.git : names.router;
          await fly(['certs', 'check', host, '-a', app]).catch(() => {});
        }
        certsCheckedAt = Date.now();
      }
      const sendingReady = !provider || state.sending?.provider !== 'resend' || (!missing.length && await provider.verified(state.sending.id));
      const line = [
        missing.length ? `${records.length - missing.length} of ${records.length} records right (waiting for ${missing.map((r) => `${r.name} ${r.type}`).join(', ')})` : `all ${records.length} records right`,
        certsWaiting.length ? `certificates waiting: ${certsWaiting.join(', ')}` : 'certificates issued',
        mailCert ? 'mail certificate issued' : mxRestarts < 4 ? 'mail certificate waiting'
          : `mail certificate waiting (the receiver asks again by itself every 12 h, or now with: fly apps restart ${names.mx})`,
        ...(provider && state.sending?.provider === 'resend' ? [sendingReady ? 'mail out verified' : 'mail out waiting for Resend'] : []),
      ].join('; ');
      if (line !== said) { log(`  ${new Date().toISOString().slice(11, 19)}  ${line}`); said = line; }
      if (!missing.length && !certsWaiting.length && mailCert && sendingReady) break;
      if (Date.now() > deadline) throw new Error('Still waiting for the line above. Nothing is lost: run the same command again to carry on.');
      await sleep(deps.pollMs ?? 15_000);
    }
  });

  await step('smoke', 'Smoke test', async () => {
    const results = await (deps.smokeTest ?? smokeTest)({ domain, mxV4: state.mxV4, fetchImpl });
    for (const result of results) log(`        ${result.ok ? 'ok  ' : 'FAIL'}  ${result.what}: ${result.detail}`);
    if (results.some((result) => !result.ok)) throw new Error('The smoke test failed (above). Run the same command again once it is fixed.');
  });

  const shown = state.pending ?? {};
  log(`\nYour own Agentic Cloud is ready. This run took ${minutes(Date.now() - started)}.`);
  log(`\n  Sign-in address:  https://${domain}`);
  if (shown.FIRST_ACCOUNT_CODE) {
    log(`  First admin:      https://${domain}/signup#first-account=${shown.FIRST_ACCOUNT_CODE}`);
    log('                    The first person to open it and sign up becomes the admin. It works once,');
    log('                    and only while there is no account yet; everyone else joins by invite.');
  }
  if (shown.SECRETS_MASTER_KEY) {
    log(`  Master key:       ${shown.SECRETS_MASTER_KEY}`);
    log('                    Keep it offline, now: this is the only time it is shown. Without it a database');
    log('                    restored into a new install cannot open the keys people saved in it.');
  }
  if (!state.sending) log(`  Mail out:         not set up. Run again with --resend-key-file <file> or --smtp-host <host> to send as ${domain}.`);
  log(`  Kept here:        ${stateFile} (names and addresses, no keys); the upgrade command reads it.`);
  state.pending = {};
  save();
  return state;
}

/** Which image each app runs, and the order a release rolls through them. */
const IMAGE_OF = { backend: 'backend', git: 'git-host', router: 'router', mx: 'mx' };
const ROLL_ORDER = ['backend', 'git', 'router', 'mx'];

/** One of the copy's four apps, deployed from its own registry at a release. */
export async function deployOne({ fly, state, names, which, release, peerIp }) {
  const configs = appConfigs({
    names, org: state.org, region: state.region, domain: state.domain, tags: release.tags, peerIp, version: release.version, extraEnv: state.extraEnv,
  });
  const dir = mkdtempSync(path.join(tmpdir(), `${state.prefix}-${which}-`));
  try {
    writeFileSync(path.join(dir, 'fly.toml'), `${configs[which]}\n`);
    await fly(['deploy', '--config', path.join(dir, 'fly.toml'), '--app', names[which], '--image',
      `registry.fly.io/${names.images}:${release.tags[IMAGE_OF[which]]}`, '--ha=false', '--yes'], { cwd: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The copy's database, by SQLite's own tool inside the backend's machine:
 *  the online backup API, safe while the Workspace keeps writing. */
const sqlite = (fly, names, sql) => fly(['ssh', 'console', '-a', names.backend, '-C',
  `sqlite3 -cmd ".timeout 15000" /data/backend.db ${JSON.stringify(sql)}`]);

async function waitHealthy(url, fetchImpl, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const answer = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
      if (answer.ok) return;
    } catch { /* restarting */ }
    if (Date.now() > deadline) throw new Error(`${url} did not answer within ${timeoutMs / 1000} s`);
    await sleep(3000);
  }
}

/**
 * An upgrade with a way back:
 *
 *   node install.mjs upgrade --key-file <update key> [--release <version|latest>] [--drill]
 *
 * run where the installer left <prefix>-copy.json. It copies the new release
 * into the copy's registry, snapshots the database (SQLite's online backup,
 * kept on the backend's disk) and asks Fly for disk snapshots of the backend
 * and code host as a second net, then rolls the backend, code host, router and
 * mail receiver to the new release one by one and runs the smoke test. If
 * anything fails from the snapshot on, it rolls every app back to the
 * release it came from and puts the database back as it was at the
 * snapshot. Whatever was written in between is lost, which is why it is
 * minutes. `--drill` rehearses exactly that: once the new release passes, it
 * writes a mark into the database, fails on purpose, rolls back, and checks
 * the mark is gone. An upgrade that was interrupted carries on, with its own
 * snapshot, when the same command runs again.
 */
export async function upgrade(options, deps = {}) {
  const log = deps.say ?? say;
  const started = Date.now();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const updateKey = readUpdateKey(readFileSync(options['key-file'], 'utf8'));
  const stateFile = path.resolve(options.state ?? `${updateKey.customer}-copy.json`);
  if (!existsSync(stateFile)) throw new Error(`There is no ${stateFile}. Run this where the installer left it, or give --state <file>.`);
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  if (!state.release?.tags || !state.steps?.smoke) throw new Error(`${stateFile} is not a finished install. Run the installer to the end first.`);
  if (updateKey.domain !== state.domain) throw new Error(`This update key was issued for ${updateKey.domain}, not ${state.domain}.`);
  const save = () => writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  const names = namesFor(state.prefix);
  const domain = state.domain;

  const bin = deps.flyctl ?? findFlyctl();
  if (!bin) throw new Error('flyctl is not installed. Install it (fly.io/docs/flyctl/install) and run this again.');
  let token = deps.token ?? process.env.FLY_API_TOKEN ?? '';
  const logFile = path.resolve(`${state.prefix}-upgrade.log`);
  const fly = deps.fly ?? ((args, opts) => flyRunner({ bin, token, logFile })(args, opts));
  if (!token) token = (await fly(['auth', 'token'], { quiet: true })).trim();
  if (!token) throw new Error('No Fly token: set FLY_API_TOKEN, or sign in with `fly auth login`.');
  const source = (deps.updatesSource ?? updatesSource)({ customer: updateKey.customer, key: updateKey.key, url: options.updates || UPDATES_URL, fetchImpl });
  const smoke = deps.smokeTest ?? smokeTest;
  const timed = async (title, run) => {
    const at = Date.now();
    log(`  ${title}…`);
    const result = await run();
    log(`      done in ${((Date.now() - at) / 1000).toFixed(0)} s`);
    return result;
  };

  let run = state.upgrade;
  if (run) {
    log(`Carrying on with the upgrade from ${run.from.version} to ${run.toVersion} begun ${run.startedAt}.`);
  } else {
    await checkOrganization(token, state.org, fetchImpl);
    const target = await source.release(options.release || 'latest');
    if (target.version === state.release.version && !options.drill) {
      log(`${domain} already runs release ${target.version}; nothing to do.`);
      return state;
    }
    run = { from: state.release, toVersion: target.version, drill: Boolean(options.drill), startedAt: new Date().toISOString() };
    state.upgrade = run;
    save();
    log(`Upgrading ${domain} from ${run.from.version} to ${run.toVersion}${run.drill ? ' as a drill: it fails on purpose once the new release is up, and rolls back' : ''}.`);
  }

  const rollBack = async (why) => {
    run.phase = 'rolling-back';
    save();
    log(`\n  ${why}\n  Rolling back to ${run.from.version}, database as it was at ${run.snapshot.at}.`);
    for (const which of ROLL_ORDER) await timed(`${names[which]} back to ${run.from.version}`, () => deployOne({ fly, state, names, which, release: run.from, peerIp: state.peerIp }));
    await timed('database back to the snapshot', async () => {
      await sqlite(fly, names, `.restore ${run.snapshot.file}`);
      // The Workspace drops what it held in memory and opens the snapshot.
      await fly(['apps', 'restart', names.backend]);
      await waitHealthy(`https://${domain}/api/health`, fetchImpl);
    });
    if (run.drill) {
      const marks = (await sqlite(fly, names, "SELECT count(*) FROM sqlite_master WHERE name = 'upgrade_drill'")).trim().split('\n').pop();
      if (marks !== '0') throw new Error('The drill\'s mark is still in the database: the snapshot was NOT put back. Look at the backend before anything else.');
      log('  The drill\'s mark, written after the snapshot, is gone: the database is the snapshot.');
    }
    const results = await smoke({ domain, mxV4: state.mxV4, fetchImpl });
    for (const result of results) log(`    ${result.ok ? 'ok  ' : 'FAIL'}  ${result.what}: ${result.detail}`);
    if (results.some((result) => !result.ok)) throw new Error(`Rolled back to ${run.from.version}, but the smoke test still fails (above). The snapshot is ${run.snapshot.file} on ${names.backend}.`);
    delete state.upgrade;
    save();
  };

  if (run.phase === 'rolling-back') {
    await rollBack('An earlier run was rolling back when it stopped.');
    log(`\n${domain} is back on ${run.from.version} (${minutes(Date.now() - started)}).`);
    return state;
  }

  if (!run.to) {
    await timed(`Copying release ${run.toVersion} into registry.fly.io/${names.images}`, async () => {
      const dest = (deps.flyRegistry ?? flyRegistry)({ app: names.images, token, fetchImpl });
      const { release, copied } = await (deps.copyRelease ?? copyRelease)({ source, dest, version: run.toVersion, log });
      run.to = { version: release.version, commit: release.commit, tags: Object.fromEntries(Object.entries(copied).map(([name, image]) => [name, image.tag])) };
      save();
    });
  }

  if (!run.snapshot) {
    await timed('Snapshotting the database', async () => {
      const file = `/data/pre-upgrade-${run.from.version}.db`;
      // One snapshot on the disk at a time: the one this upgrade can go back to.
      await fly(['ssh', 'console', '-a', names.backend, '-C', 'sh -c \'rm -f /data/pre-upgrade-*.db\'']);
      await sqlite(fly, names, `.backup ${file}`);
      const check = await fly(['ssh', 'console', '-a', names.backend, '-C', `sqlite3 ${file} "PRAGMA integrity_check"`]);
      if (!/\bok\b/.test(check)) throw new Error(`the snapshot ${file} failed its integrity check`);
      run.snapshot = { file, at: new Date().toISOString() };
      save();
    });
    // A second net: Fly's own snapshots of the two disks that hold data.
    for (const app of [names.backend, names.git]) {
      for (const volume of jsonList(await fly(['volumes', 'list', '-a', app, '--json']).catch(() => '[]'))) {
        await fly(['volumes', 'snapshots', 'create', volume.id ?? volume.ID]).catch((error) => log(`  (Fly disk snapshot of ${app} not taken: ${error.message})`));
      }
    }
  }

  // The backend's address as it is now: Fly moves a machine now and then, and
  // a backend restored onto a new one has a new address. The backend goes by
  // its own and re-pins the machines itself; this keeps the
  // setting it is given, and what a diagnostics bundle shows, the same.
  const backendNow = jsonList(await fly(['machine', 'list', '-a', names.backend, '--json']).catch(() => '[]'))[0]?.private_ip;
  if (backendNow && backendNow !== state.peerIp) {
    log(`  The backend's private address is now ${backendNow} (was ${state.peerIp}).`);
    state.peerIp = backendNow;
    save();
  }

  try {
    for (const which of ROLL_ORDER) {
      await timed(`${names[which]} to ${run.to.version}`, () => deployOne({ fly, state, names, which, release: run.to, peerIp: state.peerIp }));
    }
    const results = await timed('Smoke test', () => smoke({ domain, mxV4: state.mxV4, fetchImpl }));
    for (const result of results) log(`    ${result.ok ? 'ok  ' : 'FAIL'}  ${result.what}: ${result.detail}`);
    if (results.some((result) => !result.ok)) throw new Error('The smoke test failed on the new release (above).');
    if (run.drill) {
      await sqlite(fly, names, `CREATE TABLE IF NOT EXISTS upgrade_drill (at TEXT); INSERT INTO upgrade_drill VALUES ('${new Date().toISOString()}');`);
      throw new Error(`Drill: ${run.to.version} is up and passed; failing on purpose, with a mark written to the database after the snapshot.`);
    }
  } catch (error) {
    await rollBack(error.message);
    if (run.drill) {
      log(`\nDrill done: ${domain} went to ${run.to.version}, came back to ${run.from.version} with its database as it was, in ${minutes(Date.now() - started)}.`);
      return state;
    }
    throw new Error(`The upgrade to ${run.to.version} failed and ${domain} is back on ${run.from.version} (${minutes(Date.now() - started)}).`);
  }

  state.previous = run.from;
  state.release = run.to;
  delete state.upgrade;
  save();
  log(`\n${domain} runs release ${run.to.version}. This upgrade took ${minutes(Date.now() - started)}.`);
  log(`  The database as it was before is ${run.snapshot.file} on ${names.backend}, until the next upgrade.`);
  return state;
}

function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) throw new Error(`unexpected argument ${argv[i]}`);
    // A flag with no value after it (--drill) is a yes.
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) {
      out[argv[i].slice(2)] = true;
      continue;
    }
    out[argv[i].slice(2)] = argv[i + 1];
    i += 1;
  }
  return out;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = flags(rest);
  if (command === 'install') {
    if (!options.org || !options.domain || !options['key-file']) throw new Error('--org, --domain and --key-file are all needed.');
    await install(options);
    return;
  }
  if (command === 'upgrade') {
    if (!options['key-file']) throw new Error('--key-file is needed: the update key your own Agentic Cloud was installed with.');
    await upgrade(options);
    return;
  }
  if (command !== 'copy') {
    say('usage: node install.mjs install --org <fly organization> --domain <domain> --key-file <update key file>');
    say('         --licence-file <licence file> | --no-licence');
    say('         [--name <prefix>] [--region <code>] [--release <version>] [--wait <minutes>]');
    say('         [--resend-key-file <file> | --smtp-host <host> [--smtp-port <587|465>] [--smtp-user <user> --smtp-password-file <file>]]');
    say('       node install.mjs upgrade --key-file <update key file> [--release <version|latest>] [--drill] [--state <file>]');
    say('       node install.mjs copy --customer <id> --key-file <file> --to-app <images app> [--release <version|latest>]');
    process.exit(2);
  }
  const token = process.env.FLY_API_TOKEN;
  if (!token) throw new Error('FLY_API_TOKEN is not set: a Fly token for the organization your own Agentic Cloud is in.');
  if (!options.customer || !options['key-file'] || !options['to-app']) throw new Error('--customer, --key-file and --to-app are all needed.');
  const key = readFileSync(options['key-file'], 'utf8').trim();
  const source = updatesSource({ customer: options.customer, key, url: options.updates || UPDATES_URL });
  const dest = flyRegistry({ app: options['to-app'], token });
  const started = Date.now();
  const { release, copied } = await copyRelease({ source, dest, version: options.release || 'latest' });
  say(`release ${release.version} is in registry.fly.io/${options['to-app']} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
  process.stdout.write(`${JSON.stringify({ version: release.version, commit: release.commit, images: copied }, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { say(`install: ${error.message}`); process.exit(1); });
}
