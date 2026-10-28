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
 * `install --plan`, with the same flags, changes nothing and costs nothing:
 * it makes every check the install makes before it creates anything (Node,
 * flyctl and its sign-in, the organization and its bill, the domain, the
 * update key and the release it opens, the licence, mail out), and lists
 * everything the install would create with Fly's list price, and the DNS
 * records it will ask for. It writes no file, not even its state or a log.
 *
 *   node install.mjs status [--state <file>] [--resend-key-file <file>]
 *
 * `status` only looks: it asks the domain's own name servers for each record,
 * Fly for each certificate and the mail receiver for its own, and says what
 * is still missing. It never creates, restarts or nudges anything.
 *
 * With --json, stdout carries one JSON object per line: progress, then the
 * result, always the last line. The readable lines stay on stderr. No line
 * on either holds a key: with --json, the first admin's link and the master
 * key go to ./<prefix>-handover.txt (mode 600) instead of the screen.
 *
 * Exit codes: 0 done, 1 failed, 2 the command was wrong, 3 a person is
 * needed (the result's `reason` says for what), 4 still waiting on Fly, Let's
 * Encrypt or the mail provider, with nothing for anyone to do but run the
 * same command again later.
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
  appendFileSync, chmodSync, createReadStream, createWriteStream, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
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

/** Not a failure: something only a person can do, such as adding the DNS
 *  records, handing over a file from us, or settling a Fly bill. Exit 3,
 *  with a `reason` a program can read and the details it needs. */
export class PersonNeeded extends Error {
  constructor(reason, message, details = {}) {
    super(message);
    this.name = 'PersonNeeded';
    this.reason = reason;
    this.details = details;
  }
}

/** Not a failure either: Fly, Let's Encrypt or the mail provider is still at
 *  it, and nobody can hurry it. Exit 4: run the same command again later. */
export class StillWaiting extends Error {
  constructor(reason, message, details = {}) {
    super(message);
    this.name = 'StillWaiting';
    this.reason = reason;
    this.details = details;
  }
}

/** The command itself was wrong: a flag missing or two that clash. Exit 2. */
export class UsageError extends Error {}

export const EXIT = { done: 0, failed: 1, usage: 2, person: 3, waiting: 4 };

export function exitCodeOf(error) {
  if (error instanceof PersonNeeded) return EXIT.person;
  if (error instanceof StillWaiting) return EXIT.waiting;
  if (error instanceof UsageError) return EXIT.usage;
  return EXIT.failed;
}

/** The last line a command prints with --json when it stopped. */
export function resultOf(error) {
  const outcome = error instanceof PersonNeeded ? 'needs-person' : error instanceof StillWaiting ? 'waiting' : 'failed';
  return { event: 'result', outcome, exitCode: exitCodeOf(error), reason: error.reason ?? null, message: error.message, ...(error.details ?? {}) };
}

const jsonLine = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
/** Where a command's events go: a test's own list, stdout with --json, or nowhere. */
const eventSink = (options, deps) => deps.emit ?? (options.json ? jsonLine : () => {});

/** Where releases come from: our update service, signed in as the customer. */
export function updatesSource({ url = UPDATES_URL, customer, key, fetchImpl = fetch }) {
  const auth = basic(customer, key);
  const get = async (pathname, init = {}) => {
    const answer = await fetchImpl(`${url}${pathname}`, { ...init, headers: { authorization: auth, ...(init.headers ?? {}) } });
    if (answer.status === 401) throw new PersonNeeded('update-key', 'The update service did not accept this customer id and update key.');
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

// What a person is asked for, in the same words wherever it is asked.
const ORG_NEEDED = '--org is the Fly organization your own Agentic Cloud goes into (its slug, as `fly orgs list` shows). Its bill pays for every machine, so the person who owns it chooses.';
const DOMAIN_NEEDED = '--domain is the name your own Agentic Cloud lives on, like agents.theirco.com: a name of its own, not the company\'s main domain.';
const PREFIX_NEEDED = '--name is a short lowercase prefix for its app names, like theirco.';
const NO_TOKEN = 'No Fly token: set FLY_API_TOKEN, or sign in with `fly auth login`.';
const keyForAnotherDomain = (updateKey, domain) => `This update key was issued for ${updateKey.domain}, not ${domain}. Ask us for a key for ${domain}, or use that domain.`;

/** Mail out goes one way or none, and its key is a file the person gives.
 *  Says how mail will go out, or throws what is wrong. */
export function mailOutProblem(options) {
  const smtpHost = options['smtp-host'] ? String(options['smtp-host']).trim() : '';
  const resendFile = options['resend-key-file'];
  if (smtpHost && resendFile) throw new UsageError('Mail out goes one way: --resend-key-file or --smtp-host, not both.');
  if (smtpHost && options['smtp-user'] && !options['smtp-password-file']) throw new UsageError('--smtp-user needs --smtp-password-file.');
  for (const [flag, file] of [['--resend-key-file', resendFile], ['--smtp-password-file', options['smtp-password-file']]]) {
    if (file === true) throw new UsageError(`${flag} needs a file.`);
    if (file && !existsSync(file)) throw new PersonNeeded('mail-key', `There is no file at ${file} (${flag}). The mail-sending key is the person's own, from their provider; mail out can also be added later.`);
  }
  if (resendFile) return 'through Resend; the install registers the domain there and waits for it';
  if (smtpHost) return `through ${smtpHost} over SMTP; that provider's own SPF and DKIM records are added by hand`;
  return 'not set up: everything else works without it, and it can be added later with --resend-key-file or --smtp-host';
}

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

/** The update key from its file. It comes from us with the agreement, so a
 *  missing or damaged one is for a person to fetch, not a failure. */
export function readKeyFile(file) {
  const fromUs = 'It comes from us with the agreement, one line in a file.';
  if (!file || file === true) throw new PersonNeeded('update-key', `The install needs its update key: --key-file <file>. ${fromUs}`);
  if (!existsSync(file)) throw new PersonNeeded('update-key', `There is no update key at ${file}. ${fromUs}`);
  try {
    return readUpdateKey(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new PersonNeeded('update-key', error.message);
  }
}

/** The licence, or its deliberate absence (--no-licence). Read for its
 *  domain only: the installed backend checks the signature itself. A run
 *  that carries on from a state file already stored it. */
export function readLicence(options, domain, { resuming = false } = {}) {
  if (options['licence-file'] && options['licence-file'] !== true) {
    const file = options['licence-file'];
    if (!existsSync(file)) throw new PersonNeeded('licence', `There is no licence at ${file}. It comes from us with the agreement, one line in a file.`);
    const text = readFileSync(file, 'utf8').trim();
    let payload = null;
    try { payload = JSON.parse(Buffer.from(text.split('.')[1] ?? '', 'base64url').toString('utf8')); } catch { /* below */ }
    if (payload?.kind !== 'licence') throw new PersonNeeded('licence', 'That file does not hold a licence. Ask us for the licence file.');
    if (payload.domain !== domain) throw new PersonNeeded('licence', `This licence was issued for ${payload.domain}, not ${domain}.`);
    return { text, detail: `for ${payload.people ?? 'any number of'} people at ${payload.domain}, until ${payload.ends ?? 'no end date'}` };
  }
  if (options['no-licence']) return { text: null, detail: 'none, by --no-licence (only when the agreement says so)' };
  if (resuming) return { text: null, detail: 'stored by an earlier run' };
  throw new PersonNeeded('licence', 'Your own Agentic Cloud needs its licence: --licence-file <file>. Run with --no-licence only if your contract says it has none.');
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

/** Each app's machine and disk: what appConfigs writes, and what --plan
 *  prices, from this one table. */
export const SHAPES = {
  backend: { size: 'shared-cpu-2x', cpus: 2, memory: '2gb', mb: 2048, diskGb: 3 },
  git: { size: 'shared-cpu-1x', cpus: 1, memory: '512mb', mb: 512, diskGb: 3 },
  router: { size: 'shared-cpu-1x', cpus: 1, memory: '256mb', mb: 256 },
  mx: { size: 'shared-cpu-1x', cpus: 1, memory: '256mb', mb: 256, diskGb: 1 },
};

/** Fly's published prices, as estimates (Fly's dashboard has the real bill):
 *  a shared core with 256 MB is $1.94 a month and each GB beyond it $5, a
 *  disk $0.15 per GB, a dedicated IPv4 $2, and an agent's machine
 *  (performance-2x, 4 GB) about $0.09 an hour while it is awake. */
const PRICE = { sharedCore: 1.94, ramGb: 5, includedGbPerCore: 0.25, diskGb: 0.15, ipv4: 2, agentHour: 0.09 };
const cents = (usd) => Math.round(usd * 100) / 100;
export const machineMonthlyUsd = ({ cpus, mb }) => cents(cpus * PRICE.sharedCore + Math.max(0, mb / 1024 - cpus * PRICE.includedGbPerCore) * PRICE.ramGb);

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
  const vm = (shape) => `[[vm]]\n  size = ${q(shape.size)}\n  memory = ${q(shape.memory)}`;
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
      mount('backend_data', `${SHAPES.backend.diskGb}gb`),
      `${http(true)}\n  [http_service.concurrency]\n    type = "requests"\n    soft_limit = 200\n    hard_limit = 250`,
      check('/api/health', '60s'),
      vm(SHAPES.backend),
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
      mount('git_data', `${SHAPES.git.diskGb}gb`),
      http(false),
      vm(SHAPES.git),
    ].join('\n\n'),
    router: [
      head(names.router, 'Previews and sites on *.' + domain),
      `[env]\n${envBlock({ APPS_DOMAIN: domain, BACKEND_URL: internal, PORT: '8080' })}`,
      http(true),
      check('/__router/health', '10s'),
      vm(SHAPES.router),
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
      mount('mx_data', `${SHAPES.mx.diskGb}gb`, false),
      vm(SHAPES.mx),
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

/** One record as --json shows it: exactly what to add, and why. */
const publicRecord = (record) => ({
  name: record.name, type: record.type, value: record.value, ...(record.priority !== undefined ? { priority: record.priority } : {}), why: record.why,
});

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
    // A flyctl that exits without reading its input (most commands) must
    // not crash the installer with EPIPE: its exit code says how it went.
    child.stdin.on('error', () => {});
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
    throw new PersonNeeded('fly-organization', `Fly did not show the organization ${org} to this token (${error.message}). Use a token of that organization.`);
  }
  const found = data?.organization;
  if (!found) throw new PersonNeeded('fly-organization', `There is no Fly organization ${org} for this token.`);
  const billing = { billingUrl: `https://fly.io/dashboard/${org}/billing` };
  if (!found.billable) throw new PersonNeeded('billing', `The organization ${org} has no card on file. Your own Agentic Cloud needs one (its mail address is a dedicated IPv4). Add it at fly.io/dashboard/${org}/billing and run this again.`, billing);
  if (found.billingStatus !== 'CURRENT') {
    throw new PersonNeeded('billing', `Fly says the organization ${org}'s bill is not paid (${String(found.billingStatus).toLowerCase().replace('_', ' ')}), and it refuses to create anything until it is. Settle it at fly.io/dashboard/${org}/billing and run this again.`, billing);
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
    /** Only reads: unlike verified(), it never asks Resend to check again. */
    async status(id) {
      return (await call('GET', `/domains/${id}`)).status;
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
  const emit = eventSink(options, deps);
  const started = Date.now();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 20) throw new Error(`Node ${process.versions.node} is too old; the installer needs 20 or newer.`);

  const updateKey = readKeyFile(options['key-file']);
  const domain = String(options.domain ?? '').toLowerCase().replace(/\.$/, '');
  const org = String(options.org ?? '');
  if (!org) throw new PersonNeeded('fly-organization', ORG_NEEDED);
  if (!DOMAIN_SHAPE.test(domain)) throw new PersonNeeded('domain', DOMAIN_NEEDED);
  if (updateKey.domain !== domain) throw new PersonNeeded('update-key', keyForAnotherDomain(updateKey, domain));
  const smtpHost = options['smtp-host'] ? String(options['smtp-host']).trim() : '';
  mailOutProblem(options);
  const prefix = String(options.name ?? updateKey.customer).toLowerCase();
  const licence = readLicence(options, domain, { resuming: existsSync(path.resolve(options.state ?? `${prefix}-copy.json`)) });
  const licenceText = licence.text;
  if (!PREFIX_SHAPE.test(prefix)) throw new UsageError(PREFIX_NEEDED);
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
  if (!token) throw new PersonNeeded('fly-sign-in', NO_TOKEN);

  let stepNumber = 0;
  const STEPS = 11;
  const step = async (key, title, run) => {
    stepNumber += 1;
    const label = `[${String(stepNumber).padStart(2)}/${STEPS}] ${title}`;
    const said = { event: 'step', step: stepNumber, of: STEPS, key, title };
    if (state.steps[key]) { log(`${label}: done before`); emit({ ...said, status: 'done-before' }); return; }
    const at = Date.now();
    log(`${label}…`);
    emit({ ...said, status: 'running' });
    await run();
    state.steps[key] = new Date().toISOString();
    save();
    const seconds = Math.round((Date.now() - at) / 1000);
    log(`${' '.repeat(8)}done in ${seconds} s`);
    emit({ ...said, status: 'done', seconds });
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
  emit({ event: 'step', step: 1, of: STEPS, key: 'checks', title: 'Checking the organization, the update key and the release', status: 'running' });
  const orgFacts = await checkOrganization(token, org, fetchImpl);
  state.region = state.region ?? options.region ?? orgFacts.nearestRegion ?? 'iad';
  const source = (deps.updatesSource ?? updatesSource)({ customer: updateKey.customer, key: updateKey.key, url: options.updates || UPDATES_URL, fetchImpl });
  const release = state.release ?? await source.release(options.release || 'latest');
  log(`        ${orgFacts.name}: billing current. Region ${state.region}. Release ${release.version}. Update key good for releases until ${updateKey.until}.`);
  save();
  emit({ event: 'step', step: 1, of: STEPS, key: 'checks', title: 'Checking the organization, the update key and the release', status: 'done', release: release.version, region: state.region });

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
    emit({ event: 'dns-records', domain, records: records.map(publicRecord), ...(state.sending?.provider === 'smtp' ? { alsoFromProvider: state.sending.host } : {}) });
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
      const where = {
        missing: missing.map(publicRecord),
        certificatesWaiting: certsWaiting,
        mailCertificate: mailCert,
        ...(provider && state.sending?.provider === 'resend' ? { mailOut: sendingReady ? 'verified' : 'waiting' } : {}),
      };
      if (line !== said) { log(`  ${new Date().toISOString().slice(11, 19)}  ${line}`); said = line; emit({ event: 'waiting', ...where }); }
      if (!missing.length && !certsWaiting.length && mailCert && sendingReady) break;
      if (Date.now() > deadline) {
        if (missing.length) {
          throw new PersonNeeded('dns', `${missing.length} of ${records.length} DNS records are not in place at ${domain}'s name servers yet. Add them, all DNS only, then run the same command again: it carries on from here.`, { domain, records: missing.map(publicRecord), allRecords: records.map(publicRecord) });
        }
        const reason = certsWaiting.length ? 'certificates' : !mailCert ? 'mail-certificate' : 'mail-out';
        throw new StillWaiting(reason, `Every DNS record is in; still waiting for ${certsWaiting.length ? `the certificates of ${certsWaiting.join(', ')}` : !mailCert ? 'the mail receiver\'s certificate' : 'Resend to verify the domain'}. Nobody needs to do anything. Run the same command again later: it carries on from here. Fly can take over an hour for one certificate.`, where);
      }
      await sleep(deps.pollMs ?? 15_000);
    }
  });

  await step('smoke', 'Smoke test', async () => {
    const results = await (deps.smokeTest ?? smokeTest)({ domain, mxV4: state.mxV4, fetchImpl });
    for (const result of results) log(`        ${result.ok ? 'ok  ' : 'FAIL'}  ${result.what}: ${result.detail}`);
    if (results.some((result) => !result.ok)) throw new Error('The smoke test failed (above). Run the same command again once it is fixed.');
  });

  const shown = state.pending ?? {};
  // With --json the two secrets go to a file only its owner can read, never
  // onto a screen or into a program's output: an agent hands the file over.
  const handoverFile = options.json && (shown.FIRST_ACCOUNT_CODE || shown.SECRETS_MASTER_KEY)
    ? path.join(path.dirname(stateFile), `${prefix}-handover.txt`) : null;
  log(`\nYour own Agentic Cloud is ready. This run took ${minutes(Date.now() - started)}.`);
  log(`\n  Sign-in address:  https://${domain}`);
  if (handoverFile) {
    writeFileSync(handoverFile, handoverText(domain, shown), { mode: 0o600 });
    chmodSync(handoverFile, 0o600);
    log(`  First admin and master key: in ${handoverFile}, readable only by this user.`);
    log('                    Give that file to the person who will be the admin. They open the link to');
    log('                    become the admin, keep the master key offline, then delete the file.');
  } else {
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
  }
  if (!state.sending) log(`  Mail out:         not set up. Run again with --resend-key-file <file> or --smtp-host <host> to send as ${domain}.`);
  log(`  Kept here:        ${stateFile} (names and addresses, no keys); the upgrade command reads it.`);
  state.pending = {};
  save();
  emit({
    event: 'result',
    outcome: 'done',
    exitCode: EXIT.done,
    command: 'install',
    domain,
    signInUrl: `https://${domain}`,
    release: state.release?.version ?? null,
    stateFile,
    handoverFile,
    mailOut: state.sending?.provider ?? null,
    person: handoverFile ? [
      `Open ${handoverFile}: the first-admin link in it makes the first admin, once.`,
      'Keep the master key in it offline, then delete the file.',
    ] : [],
  });
  return state;
}

/** The file --json leaves for the admin instead of printing the two secrets. */
function handoverText(domain, shown) {
  return [
    `Your own Agentic Cloud at https://${domain}`,
    '',
    ...(shown.FIRST_ACCOUNT_CODE ? [
      'First admin. The first person to open this and sign up becomes the admin. It works once,',
      'and only while there is no account yet; everyone else joins by invite:',
      `  https://${domain}/signup#first-account=${shown.FIRST_ACCOUNT_CODE}`,
      '',
    ] : []),
    ...(shown.SECRETS_MASTER_KEY ? [
      'Master key. Keep it offline, now: this is the only time it is shown. Without it a database',
      'restored into a new install cannot open the keys people saved in it:',
      `  ${shown.SECRETS_MASTER_KEY}`,
      '',
    ] : []),
    'Delete this file once the master key is kept somewhere safe.',
    '',
  ].join('\n');
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
  const emit = eventSink(options, deps);
  const started = Date.now();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const updateKey = readKeyFile(options['key-file']);
  const stateFile = path.resolve(options.state ?? `${updateKey.customer}-copy.json`);
  if (!existsSync(stateFile)) throw new Error(`There is no ${stateFile}. Run this where the installer left it, or give --state <file>.`);
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  if (!state.release?.tags || !state.steps?.smoke) throw new Error(`${stateFile} is not a finished install. Run the installer to the end first.`);
  if (updateKey.domain !== state.domain) throw new PersonNeeded('update-key', `This update key was issued for ${updateKey.domain}, not ${state.domain}.`);
  const save = () => writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  const names = namesFor(state.prefix);
  const domain = state.domain;

  const bin = deps.flyctl ?? findFlyctl();
  if (!bin) throw new Error('flyctl is not installed. Install it (fly.io/docs/flyctl/install) and run this again.');
  let token = deps.token ?? process.env.FLY_API_TOKEN ?? '';
  const logFile = path.resolve(`${state.prefix}-upgrade.log`);
  const fly = deps.fly ?? ((args, opts) => flyRunner({ bin, token, logFile })(args, opts));
  if (!token) token = (await fly(['auth', 'token'], { quiet: true })).trim();
  if (!token) throw new PersonNeeded('fly-sign-in', NO_TOKEN);
  const source = (deps.updatesSource ?? updatesSource)({ customer: updateKey.customer, key: updateKey.key, url: options.updates || UPDATES_URL, fetchImpl });
  const smoke = deps.smokeTest ?? smokeTest;
  const timed = async (title, run) => {
    const at = Date.now();
    log(`  ${title}…`);
    emit({ event: 'step', title, status: 'running' });
    const result = await run();
    const seconds = Math.round((Date.now() - at) / 1000);
    log(`      done in ${seconds} s`);
    emit({ event: 'step', title, status: 'done', seconds });
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
      emit({ event: 'result', outcome: 'done', exitCode: EXIT.done, command: 'upgrade', domain, release: target.version, unchanged: true });
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
    emit({ event: 'result', outcome: 'done', exitCode: EXIT.done, command: 'upgrade', domain, release: run.from.version, rolledBack: true });
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
      emit({ event: 'result', outcome: 'done', exitCode: EXIT.done, command: 'upgrade', domain, release: run.from.version, drill: true, rehearsed: run.to.version });
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
  emit({ event: 'result', outcome: 'done', exitCode: EXIT.done, command: 'upgrade', domain, release: run.to.version, previous: run.from.version });
  return state;
}

/** The install's steps, in order, as its state file records them. */
export const INSTALL_STEPS = ['apps', 'release', 'buckets', 'keys', 'secrets', 'addresses', 'deploy', 'certificates', 'dns', 'smoke'];

const usd = (value) => (value === null ? 'by use' : `$${value.toFixed(2)}`);

/**
 * What `install` would do, changing nothing: the checks it makes before it
 * creates anything, everything it would create with Fly's list price, and
 * the DNS records it will ask for. It only reads (flyctl's sign-in, the
 * organization and its bill, the release the update key opens, the apps
 * already there) and writes no file, not even its state or a log. Every
 * problem says who fixes it: "you" (whoever runs this) or "person" (the one
 * who owns the Fly organization, the domain and the agreement with us).
 */
export async function plan(options, deps = {}) {
  const log = deps.say ?? say;
  const emit = eventSink(options, deps);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const domain = String(options.domain ?? '').toLowerCase().replace(/\.$/, '');
  const org = typeof options.org === 'string' ? options.org : '';
  const checks = [];
  const check = async (key, run) => {
    try {
      checks.push({ key, ok: true, detail: await run() });
      return true;
    } catch (error) {
      const person = error instanceof PersonNeeded;
      checks.push({ key, ok: false, who: person ? 'person' : 'you', reason: error.reason ?? null, detail: error.message, ...(error.details ?? {}) });
      return false;
    }
  };

  await check('node', async () => {
    if (Number(process.versions.node.split('.')[0]) < 20) throw new Error(`Node ${process.versions.node} is too old; the installer needs 20 or newer.`);
    return `Node ${process.versions.node}`;
  });
  const domainOk = await check('domain', async () => {
    if (!DOMAIN_SHAPE.test(domain)) throw new PersonNeeded('domain', DOMAIN_NEEDED);
    return domain;
  });
  let updateKey = null;
  await check('update-key', async () => {
    const read = readKeyFile(options['key-file']);
    if (domainOk && read.domain !== domain) throw new PersonNeeded('update-key', keyForAnotherDomain(read, domain));
    updateKey = read;
    return `for ${read.customer} at ${read.domain}, releases until ${read.until}`;
  });
  const prefix = String(options.name ?? updateKey?.customer ?? '').toLowerCase();
  const names = PREFIX_SHAPE.test(prefix) ? namesFor(prefix) : null;
  const stateFile = path.resolve(options.state ?? `${prefix || 'install'}-copy.json`);
  const state = names && existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null;
  if (updateKey || options.name) {
    await check('name', async () => {
      if (!names) throw new UsageError(PREFIX_NEEDED);
      return `every app is named ${prefix}-*`;
    });
  }
  if (domainOk) await check('licence', async () => readLicence(options, domain, { resuming: Boolean(state) }).detail);
  await check('mail-out', async () => mailOutProblem(options));

  const bin = deps.flyctl ?? findFlyctl();
  let token = deps.token ?? process.env.FLY_API_TOKEN ?? '';
  // No log file: a plan leaves nothing behind.
  const fly = deps.fly ?? ((args, opts) => flyRunner({ bin, token })(args, opts));
  const flyOk = await check('flyctl', async () => {
    if (!bin) throw new Error('flyctl is not installed. Install it (fly.io/docs/flyctl/install) and run this again.');
    return bin;
  });
  const signedIn = flyOk && await check('fly-sign-in', async () => {
    const fromEnv = Boolean(token);
    if (!token) token = (await fly(['auth', 'token'], { quiet: true }).catch(() => '')).trim();
    if (!token) throw new PersonNeeded('fly-sign-in', `${NO_TOKEN} The sign-in opens a browser, so the person signs in.`);
    return fromEnv ? 'a Fly token is set' : 'flyctl is signed in';
  });
  let orgOk = false;
  if (signedIn) {
    orgOk = await check('fly-organization', async () => {
      if (!org) {
        let organizations = [];
        try {
          const listed = JSON.parse(await fly(['orgs', 'list', '--json']) || '{}');
          organizations = Array.isArray(listed) ? listed.map((entry) => entry.slug ?? entry.Slug).filter(Boolean) : Object.keys(listed);
        } catch { /* the person knows */ }
        throw new PersonNeeded('fly-organization', ORG_NEEDED, { organizations });
      }
      const facts = await checkOrganization(token, org, fetchImpl);
      return `${facts.name}: card on file, billing current`;
    });
  }
  let release = null;
  if (updateKey) {
    await check('release', async () => {
      const source = (deps.updatesSource ?? updatesSource)({ customer: updateKey.customer, key: updateKey.key, url: options.updates || UPDATES_URL, fetchImpl });
      release = await source.release(options.release || 'latest');
      return `release ${release.version}, which this update key opens`;
    });
  }
  let existing = [];
  if (names && orgOk) {
    await check('apps', async () => {
      const listed = jsonList(await fly(['apps', 'list', '-o', org, '--json'])).map((app) => app.Name ?? app.name);
      existing = [names.images, names.backend, names.git, names.router, names.mx].filter((app) => listed.includes(app));
      return existing.length ? `already in ${org}, and kept as they are: ${existing.join(', ')}` : `none of the five names is in ${org} yet`;
    });
  }

  const disk = (gb) => cents(gb * PRICE.diskGb);
  const creates = names ? [
    { kind: 'app', name: names.images, what: 'your own image registry, holding the release', monthlyUsd: 0 },
    { kind: 'app', name: names.backend, what: `the Workspace and its database: one ${SHAPES.backend.size} machine with ${SHAPES.backend.mb / 1024} GB of memory, always on`, monthlyUsd: machineMonthlyUsd(SHAPES.backend) },
    { kind: 'app', name: names.git, what: 'the code host: one machine that sleeps when nobody uses it (the price is if it never slept)', monthlyUsd: machineMonthlyUsd(SHAPES.git) },
    { kind: 'app', name: names.router, what: 'the router for previews and sites, always on', monthlyUsd: machineMonthlyUsd(SHAPES.router) },
    { kind: 'app', name: names.mx, what: 'the mail receiver, always on', monthlyUsd: machineMonthlyUsd(SHAPES.mx) },
    { kind: 'disk', name: `backend_data on ${names.backend}`, what: `${SHAPES.backend.diskGb} GB for the database, with daily snapshots`, monthlyUsd: disk(SHAPES.backend.diskGb) },
    { kind: 'disk', name: `git_data on ${names.git}`, what: `${SHAPES.git.diskGb} GB for the code`, monthlyUsd: disk(SHAPES.git.diskGb) },
    { kind: 'disk', name: `mx_data on ${names.mx}`, what: `${SHAPES.mx.diskGb} GB for the mail receiver's certificate`, monthlyUsd: disk(SHAPES.mx.diskGb) },
    { kind: 'bucket', name: names.media, what: 'files people and agents attach', monthlyUsd: null },
    { kind: 'bucket', name: names.backups, what: 'database backups', monthlyUsd: null },
    { kind: 'address', name: `a dedicated IPv4 on ${names.mx}`, what: 'mail cannot run on a shared address', monthlyUsd: PRICE.ipv4 },
    { kind: 'address', name: `shared IPv4 and IPv6 on ${names.backend}, ${names.git} and ${names.router}`, what: 'no charge', monthlyUsd: 0 },
    { kind: 'certificate', name: domainOk ? `${domain}, git.${domain} and *.${domain}` : 'the domain, git. and *.', what: 'from Let\'s Encrypt, through Fly', monthlyUsd: 0 },
    { kind: 'token', name: `${names.backend} (your own Agentic Cloud)`, what: 'an organization token the backend starts agent machines with', monthlyUsd: 0 },
    { kind: 'secrets', name: `Fly secrets on ${names.backend}, ${names.git} and ${names.mx}`, what: 'keys made on this computer: an SSH key, the master key, shared secrets, the first-admin code', monthlyUsd: 0 },
  ].map((item) => ({ ...item, exists: existing.includes(item.name) })) : [];
  const monthlyUsd = cents(creates.reduce((sum, item) => sum + (item.exists ? 0 : item.monthlyUsd ?? 0), 0));
  const unknown = '(given once the install has it)';
  const records = names && domainOk
    ? dnsRecords({ domain, names, backendV4: unknown, backendV6: unknown, mxV4: unknown, acmeTarget: '(given by Fly with the certificate)' }).map(publicRecord)
    : [];

  const problems = checks.filter((item) => !item.ok);
  const forPerson = problems.filter((item) => item.who === 'person');
  const forYou = problems.filter((item) => item.who === 'you');
  const outcome = forYou.length ? 'failed' : forPerson.length ? 'needs-person' : 'ready';
  const exitCode = forYou.length ? EXIT.failed : forPerson.length ? EXIT.person : EXIT.done;
  const person = [
    ...forPerson.map((item) => item.detail),
    'Read what the install will create and what it costs, and say yes before it runs.',
    `Add the DNS records the install prints${records.length ? ` (${records.length}${options['resend-key-file'] ? ', plus the mail provider\'s' : ''})` : ''} at the domain's DNS provider, unless whoever runs it can edit that DNS.`,
    'At the end, keep the master key offline and open the first-admin link.',
  ];

  log(`Plan for your own Agentic Cloud${domainOk ? ` at ${domain}` : ''}${org ? `, in the Fly organization ${org}` : ''}. Nothing has been created or changed.\n`);
  log('Checks:');
  for (const item of checks) log(`  ${item.ok ? 'ok    ' : item.who === 'person' ? 'PERSON' : 'FIX   '}  ${item.key.padEnd(17)} ${item.detail}`);
  if (creates.length) {
    log(`\nIt would create${org ? ` in ${org}` : ''}:`);
    for (const item of creates) log(`  ${usd(item.monthlyUsd).padStart(7)}  ${item.name}: ${item.what}${item.exists ? ' (already there)' : ''}`);
    log(`\n  About $${monthlyUsd.toFixed(2)} a month at Fly's published prices before any agent, plus the buckets' storage by use.`);
    log(`  Each agent machine: about $${PRICE.agentHour.toFixed(2)} an hour while it is awake, plus its disk. Fly's dashboard has the real bill.`);
  }
  if (records.length) log(`\nThe DNS records it will ask for:\n${formatRecords(records)}`);
  if (state) log(`\nAn earlier run is recorded in ${stateFile}: ${INSTALL_STEPS.filter((key) => state.steps?.[key]).join(', ') || 'nothing'} done.`);
  log(`\n${outcome === 'ready' ? 'Ready: run the same command without --plan.' : outcome === 'needs-person' ? 'A person is needed first (PERSON above).' : 'Fix the FIX lines above, then plan again.'}`);

  const result = {
    event: 'result', outcome, exitCode, command: 'plan', reason: forPerson[0]?.reason ?? null, domain: domainOk ? domain : null, org: org || null,
    release: release?.version ?? null, checks, creates, monthlyUsd, agentHourlyUsd: PRICE.agentHour, records,
    stepsDone: state ? INSTALL_STEPS.filter((key) => state.steps?.[key]) : [], person,
  };
  emit(result);
  return result;
}

/** The state file a command was pointed at, or the one the installer left here. */
function findStateFile(options) {
  if (options.state) return path.resolve(options.state);
  if (options.name) return path.resolve(`${String(options.name).toLowerCase()}-copy.json`);
  if (options['key-file']) return path.resolve(`${readKeyFile(options['key-file']).customer}-copy.json`);
  const here = readdirSync(process.cwd()).filter((file) => file.endsWith('-copy.json'));
  if (here.length === 1) return path.resolve(here[0]);
  throw new UsageError(here.length ? `Several installs are recorded here (${here.join(', ')}): say which with --state <file>.` : 'There is no <prefix>-copy.json here. Run this where the installer left it, or give --state <file>.');
}

/**
 * Where an install stands, only looking: the steps done, every DNS record as
 * the domain's own name servers answer it, each certificate as Fly reports
 * it, the mail receiver's own certificate, mail out (with --resend-key-file)
 * and, once installed, the Workspace's health. It creates, restarts and
 * nudges nothing, so it can be run as often as anyone likes.
 */
export async function status(options, deps = {}) {
  const log = deps.say ?? say;
  const emit = eventSink(options, deps);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const stateFile = findStateFile(options);
  if (!existsSync(stateFile)) throw new Error(`There is no ${stateFile}. Run this where the installer left it, or give --state <file>.`);
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  const names = namesFor(state.prefix);
  const domain = state.domain;
  const stepsDone = INSTALL_STEPS.filter((key) => state.steps?.[key]);
  const nextStep = INSTALL_STEPS.find((key) => !state.steps?.[key]) ?? null;
  const base = { event: 'result', command: 'status', domain, stateFile, release: state.release?.version ?? null, stepsDone, nextStep };
  log(`Your own Agentic Cloud at ${domain} (${stateFile}): ${stepsDone.length} of ${INSTALL_STEPS.length} install steps done${nextStep ? `, next: ${nextStep}` : ''}.`);

  const finish = (outcome, exitCode, message, more = {}) => {
    log(`\n${message}`);
    const result = { ...base, outcome, exitCode, message, ...more };
    emit(result);
    return result;
  };
  if (state.upgrade) {
    return finish('continue', EXIT.done, `An upgrade from ${state.upgrade.from?.version} to ${state.upgrade.toVersion} stopped part-way. Run the same upgrade command again: it carries on from where it stopped.`, { next: 'upgrade' });
  }
  if (!(state.acmeTarget && state.backendV4 && state.backendV6 && state.mxV4)) {
    return finish('continue', EXIT.done, `Nothing for a person yet: the install has not asked for its DNS records. Run the same install command again: it carries on at "${nextStep}".`, { next: 'install' });
  }

  const records = dnsRecords({
    domain, names, backendV4: state.backendV4, backendV6: state.backendV6, mxV4: state.mxV4, acmeTarget: state.acmeTarget, provider: state.sending?.records,
  });
  const { resolver } = await (deps.authoritativeResolver ?? authoritativeResolver)(domain);
  const missing = [];
  for (const record of records) {
    const { ok, seen } = await checkRecord(resolver, record);
    if (!ok) missing.push({ ...publicRecord(record), seen });
  }
  log(`  DNS: ${records.length - missing.length} of ${records.length} records right${missing.length ? `; missing:\n${formatRecords(missing)}` : ''}`);

  const bin = deps.flyctl ?? findFlyctl();
  if (!bin) throw new Error('flyctl is not installed. Install it (fly.io/docs/flyctl/install) and run this again.');
  let token = deps.token ?? process.env.FLY_API_TOKEN ?? '';
  const fly = deps.fly ?? ((args, opts) => flyRunner({ bin, token })(args, opts));
  if (!token) token = (await fly(['auth', 'token'], { quiet: true }).catch(() => '')).trim();
  if (!token) throw new PersonNeeded('fly-sign-in', NO_TOKEN);
  const certificates = {};
  for (const [app, host] of [[names.backend, domain], [names.git, `git.${domain}`], [names.router, `*.${domain}`]]) {
    try {
      certificates[host] = JSON.parse(await fly(['certs', 'show', host, '-a', app, '--json'])).status ?? 'unknown';
    } catch (error) {
      certificates[host] = `not readable (${error.message})`;
    }
  }
  const certificatesWaiting = Object.entries(certificates).filter(([, value]) => value !== 'Ready').map(([host]) => host);
  log(`  Certificates: ${certificatesWaiting.length ? `waiting for ${certificatesWaiting.join(', ')}` : 'all issued'}`);
  let mailCertificate = false;
  try {
    mailCertificate = Boolean((await (await fetchImpl(`http://${state.mxV4}/health`, { signal: AbortSignal.timeout(5000) })).json()).starttls);
  } catch { /* not up, or no answer */ }
  log(`  Mail receiver's certificate: ${mailCertificate ? 'issued' : 'waiting'}`);
  let mailOut = state.sending ? state.sending.provider : 'not set up';
  if (state.sending?.provider === 'resend') {
    const keyFile = options['resend-key-file'];
    if (keyFile && keyFile !== true && existsSync(keyFile)) {
      const provider = (deps.resendProvider ?? resendProvider)({ key: readFileSync(keyFile, 'utf8').trim(), fetchImpl });
      mailOut = (await provider.status(state.sending.id).catch(() => 'unknown')) === 'verified' ? 'verified' : 'waiting';
    } else {
      mailOut = 'not checked (give --resend-key-file to check Resend)';
    }
  }
  log(`  Mail out: ${mailOut}`);
  const found = { records: missing, certificates, certificatesWaiting, mailCertificate, mailOut };

  if (missing.length) {
    return finish('needs-person', EXIT.person, `A person is needed: ${missing.length} of ${records.length} DNS records are not in place at ${domain}'s name servers. Add them exactly as above, all DNS only, then check again.`, { reason: 'dns', ...found });
  }
  if (certificatesWaiting.length || !mailCertificate || mailOut === 'waiting') {
    const reason = certificatesWaiting.length ? 'certificates' : !mailCertificate ? 'mail-certificate' : 'mail-out';
    return finish('waiting', EXIT.waiting, `Every DNS record is in. Nobody needs to do anything: ${state.steps?.smoke ? 'Fly and the mail receiver renew by themselves.' : 'run the same install command again (with --wait 20). While it waits it nudges Fly and the mail receiver to ask again, which this check never does.'}`, { reason, next: state.steps?.smoke ? null : 'install', ...found });
  }
  if (!state.steps?.smoke) {
    return finish('continue', EXIT.done, 'Every DNS record and certificate is in. Run the same install command again to finish: the smoke test, then the first-admin link.', { next: 'install', ...found });
  }
  let healthy = false;
  try {
    healthy = (await (await fetchImpl(`https://${domain}/api/health`, { signal: AbortSignal.timeout(20_000) })).json()).status === 'ok';
  } catch { /* below */ }
  if (!healthy) return finish('unhealthy', EXIT.failed, `Installed, but https://${domain}/api/health does not say ok.`, found);
  return finish('installed', EXIT.done, `Installed and healthy at https://${domain}, release ${state.release?.version}.`, found);
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
    if (options.plan) {
      process.exitCode = (await plan(options)).exitCode;
      return;
    }
    if (!options.org || !options.domain || !options['key-file']) throw new UsageError('--org, --domain and --key-file are all needed.');
    await install(options);
    return;
  }
  if (command === 'status') {
    process.exitCode = (await status(options)).exitCode;
    return;
  }
  if (command === 'upgrade') {
    if (!options['key-file']) throw new UsageError('--key-file is needed: the update key your own Agentic Cloud was installed with.');
    await upgrade(options);
    return;
  }
  if (command !== 'copy') {
    say('usage: node install.mjs install --org <fly organization> --domain <domain> --key-file <update key file>');
    say('         --licence-file <licence file> | --no-licence');
    say('         [--name <prefix>] [--region <code>] [--release <version>] [--wait <minutes>]');
    say('         [--resend-key-file <file> | --smtp-host <host> [--smtp-port <587|465>] [--smtp-user <user> --smtp-password-file <file>]]');
    say('         [--plan] [--json]');
    say('       node install.mjs status [--state <file>] [--resend-key-file <file>] [--json]');
    say('       node install.mjs upgrade --key-file <update key file> [--release <version|latest>] [--drill] [--state <file>] [--json]');
    say('       node install.mjs copy --customer <id> --key-file <file> --to-app <images app> [--release <version|latest>]');
    say('exit codes: 0 done, 1 failed, 2 wrong command, 3 a person is needed, 4 still waiting (run it again later)');
    process.exitCode = EXIT.usage;
    return;
  }
  const token = process.env.FLY_API_TOKEN;
  if (!token) throw new PersonNeeded('fly-sign-in', 'FLY_API_TOKEN is not set: a Fly token for the organization your own Agentic Cloud is in.');
  if (!options.customer || !options['key-file'] || !options['to-app']) throw new UsageError('--customer, --key-file and --to-app are all needed.');
  const key = readFileSync(options['key-file'], 'utf8').trim();
  const source = updatesSource({ customer: options.customer, key, url: options.updates || UPDATES_URL });
  const dest = flyRegistry({ app: options['to-app'], token });
  const started = Date.now();
  const { release, copied } = await copyRelease({ source, dest, version: options.release || 'latest' });
  say(`release ${release.version} is in registry.fly.io/${options['to-app']} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
  process.stdout.write(`${JSON.stringify({ version: release.version, commit: release.commit, images: copied }, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    say(`install: ${error.message}`);
    // With --json the last line is always the result, stopped or not.
    if (process.argv.includes('--json')) jsonLine(resultOf(error));
    // exitCode, not exit(): a pipe on macOS is written asynchronously, and
    // exit() could cut off the line above.
    process.exitCode = exitCodeOf(error);
  });
}
