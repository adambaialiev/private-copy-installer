# Private copy installer

This is the command that installs a **private copy** of Agentic Cloud Computer in your own [Fly.io](https://fly.io) organization, on a domain of yours, and later upgrades it. It is published so that your engineer can read exactly what it creates, what it sends and where it sends it, before running it with full rights over your Fly organization.

The whole installer is one file, [`install.mjs`](install.mjs). It needs Node and nothing else: no packages, and nothing is downloaded or run besides the release images described below.

## If you are an AI agent

Your person asked you to set up their own Agentic Cloud with this installer. You can run all of it, but some steps belong to them, and the installer tells you which. Put the two files they get from us (`update.key`, `licence.txt`) beside `install.mjs`, and never paste what is in them into a chat.

1. **Plan.** Run the install command with `--plan --json`. It changes nothing and costs nothing. Show your person what it will create and what it costs, and wait for their yes.
2. **Install.** Run the same command with `--json --wait 0` instead of `--plan`. It builds everything, then stops with exit code 3 and `"reason": "dns"`, listing the exact DNS records.
3. **DNS.** Give your person the records, or add them yourself if you can edit their DNS. Run `node install.mjs status --json` until its reason is no longer `dns`.
4. **Finish.** Run the install command again with `--json --wait 20`. If it ends with exit code 4, nothing is wrong: Fly is still issuing a certificate, so run it again later.
5. **Hand over.** The result names `<prefix>-handover.txt`, which holds the first-admin link and the master key. Do not read it out or copy it anywhere. Tell your person to open it, keep the master key offline, open the link, then delete the file.

```sh
node install.mjs install --org <org> --domain <domain> --key-file update.key --licence-file licence.txt --plan --json
node install.mjs install --org <org> --domain <domain> --key-file update.key --licence-file licence.txt --json --wait 0
node install.mjs status --json
node install.mjs install --org <org> --domain <domain> --key-file update.key --licence-file licence.txt --json --wait 20
```

Stop and ask your person when the result says `needs-person`. Ask them before you choose the Fly organization (its bill pays for every machine) or the domain, and before you run with `--no-licence` (only if their agreement says so). The Fly sign-in (`fly auth login`) opens a browser, so they sign in themselves.

With `--json`, every line on stdout is one JSON object, and the last line is always `{"event": "result", ...}`. The readable lines go to stderr, and no line on either holds a key. The exit codes are:

| Code | Meaning |
| --- | --- |
| `0` | Done. |
| `1` | It failed. `message` says why. |
| `2` | The command was wrong. |
| `3` | A person is needed. `reason` is one of `update-key`, `licence`, `domain`, `fly-organization`, `fly-sign-in`, `billing`, `mail-key` or `dns`. |
| `4` | Still waiting on Fly, Let's Encrypt or the mail provider. Nobody needs to do anything; run the same command again later. |

## What you need

- **Node 20 or newer** and **[flyctl](https://fly.io/docs/flyctl/install/)**, signed in or with `FLY_API_TOKEN` set to a token for the organization.
- **A Fly organization** with billing in order. The installer checks this before it creates anything.
- **A domain for the copy**, such as `agents.yourcompany.com`, where you can add DNS records. Use a name of its own, not your company's main domain: the Workspace, mail, code, previews and sites all live on it.
- **An update key and a licence** from us, each one line in a file. The update key lets the installer download our releases. The licence says how many people the copy is for and until when, and the copy checks it itself without calling us. If your contract has no licence, run with `--no-licence`.
- **A way to send mail** (optional; it can be added later). Either a [Resend](https://resend.com) API key, or any provider over standard SMTP.

## Install

```sh
node install.mjs install --org <fly organization> --domain <domain> \
     --key-file update.key --licence-file licence.txt
```

Options:

- `--name <prefix>`: the prefix for every name it creates. The default is your customer id. Fly app names are global, so the prefix must be one nobody else uses.
- `--region <code>`: the Fly region. The default is the one nearest to you.
- `--release <version>`: install a release other than the latest.
- `--resend-key-file <file>`, or `--smtp-host <host> [--smtp-port 587|465] [--smtp-user <user> --smtp-password-file <file>]`: mail out.
- `--wait <minutes>`: how long it waits for DNS and certificates before stopping. The default is 60.
- `--plan`: change nothing. It checks everything the install needs and lists what it would create, with Fly's prices, and the DNS records it will ask for.
- `--json`: print progress and the result as JSON lines on stdout. The first-admin link and the master key then go to `<prefix>-handover.txt` (readable only by you) instead of the screen.

It runs eleven steps and prints each one. You can stop it at any point and run the same command again: it carries on from what is already there.

At the end it prints:

- the sign-in address;
- a **one-time link that makes the first admin**;
- the copy's **master key**. This is shown once. Keep it offline: without it, a database restored into a new copy cannot open the keys people saved in it.

## Check where it stands

```sh
node install.mjs status [--state <prefix>-copy.json] [--resend-key-file <file>] [--json]
```

It only looks. It asks your domain's own name servers for each record, Fly for each certificate, and the mail receiver for its own. It says what is still missing and never creates, restarts or changes anything.

## Upgrade

```sh
node install.mjs upgrade --key-file update.key [--release <version>] [--drill] [--json]
```

1. It copies the new release into your registry.
2. It snapshots the database and takes Fly snapshots of the two disks that hold data.
3. It moves each app to the new release and runs the smoke test.
4. If anything fails, it puts every app back on the release it came from and restores the database snapshot.

`--drill` rehearses that rollback on purpose and proves the database came back. An interrupted upgrade carries on when run again.

## What it creates in your organization

| What | Names |
| --- | --- |
| Five apps: the image registry, the backend (the Workspace and its database), the code host, the router for previews and sites, and the mail receiver | `<prefix>-images`, `-backend`, `-git`, `-router`, `-mx` |
| Two buckets: files, and database backups | `<prefix>-media`, `<prefix>-backups` |
| Three disks: the database, the code, and the mail receiver's certificate | created with the apps |
| A dedicated IPv4 address for the mail receiver (a Fly charge), since mail cannot run on a shared one | on `<prefix>-mx` |
| Certificates for the domain, `git.` and `*.` | requested from Fly |

Keys are made on your machine and stored only as Fly secrets on your apps:

- an SSH key the backend uses to reach your agents' machines;
- the master key;
- shared secrets between the backend, the code host and the mail receiver;
- the first-admin code.

It also asks Fly for a separate organization token for the backend. It writes `<prefix>-copy.json` beside itself, holding names and addresses only and never a key; the upgrade command reads it. A log of each run goes to `<prefix>-install.log` or `<prefix>-upgrade.log`.

It prints about twelve DNS records for you to add and checks them with your domain's own name servers. If you use SMTP, add your provider's own SPF and DKIM records too.

## Where it connects, and what it sends

- **Fly** (flyctl, and `api.fly.io` to read your organization's billing state): to create and deploy everything above, in your organization, with your token.
- **Our update service** (`https://acc-updates.fly.dev`): signed in as your customer id and update key, only to download a release's list of images and the images themselves. It sends nothing about your copy. Your copy runs only from your own registry and never pulls from us.
- **Your domain's name servers**: to check the records you added.
- **Resend's API** (only with `--resend-key-file`): to register your domain for sending and read the records it needs.
- **Your copy itself**: the smoke test reads the health pages of the Workspace, the code host, the router and the mail receiver, the sign-up page, and the mail receiver's greeting on port 25.

There is no telemetry. Once installed, the copy makes no call to us; its licence check is done offline.

## Tests

```sh
npm test    # node --test test/*.test.mjs
```

The tests run every command against fakes of flyctl, Fly, the update service and DNS, so they create nothing anywhere.

## Licence

Apache License 2.0. See [LICENSE](LICENSE).
