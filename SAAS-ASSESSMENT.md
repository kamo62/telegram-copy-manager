# SaaS topology assessment

Date: 2026-07-30. Status: recommendation, nothing implemented.
Revision 2, after an independent adversarial review and two owner questions (Fly.io as host, whether
Telegram sells a commercial ingestion product).

Question asked: does the productionalised SaaS need a new folder/repo, given it integrates with
`linux-mt5`, and is `boxyhq/saas-starter-kit` a useful base if Cloudflare is preferred?

## Read this first: the gating question is regulatory, not technical

Automatic execution of third-party trade signals without per-trade client intervention can qualify as
portfolio management under MiFID. ESMA said so in its 2012 Q&A and reaffirmed it in a 2023
supervisory briefing aimed specifically at copy trading. That is a licensable activity.

This product sits worse than eToro-style copy trading on the axis that matters. The operator hosts
the customer's logged-in MT5 terminal on the operator's own infrastructure, and the operator's
software places the orders. Every hosting layer you add weakens the "we only sell software" position.

Many MT4/MT5 copier products do operate unlicensed, so this is likely survivable, and it is
jurisdiction-dependent. The point is that the answer can change the product shape entirely. A
self-hosted licence sold to the trader, where they run the container and the software never touches
your infrastructure, is a materially different business from hosted SaaS, and it is the fallback if
the answer comes back badly.

Get this answered before writing the provisioner. It is cheap to ask now and expensive to discover
after you have built per-tenant hosting.

## Answer to the question asked

Yes, a new repo. Three repos:

```
telegram-tc/   (exists, stays)  -> the per-tenant trading engine. Publishes tc-engine:<ver>.
linux-mt5/     (exists, stays)  -> the per-tenant MT5 runtime. Publishes linux-mt5:<ver>.
tc-cloud/      (NEW)            -> the Cloudflare control plane. Signup, billing, provisioning.
```

The reasons are that the two planes share no code, and `linux-mt5` carries a public non-commercial
licence that should keep a clean repo edge away from proprietary billing code. A monorepo would work
fine on the mechanics, since path-filtered CI and independent deploys are routine, so do not reject
it on those grounds. If the `tc-cloud` console ends up sharing API types with the engine, publish a
small types package rather than merging the repos.

## Container per tenant, not a row-level tenant_id retrofit

Current state, measured:

| Fact | Value |
| --- | --- |
| Auth on `/api/*` | none. Only `cors()` at `app.ts:401` |
| Tenancy key | none. `accountId` (715 references) is an MT5 account, not a customer |
| `apps/api/src/app.ts` | 555 KB, single file |
| `apps/api/src/api.test.ts` | 552 KB |
| Persistence | `bun:sqlite`, one file, about 30 tables, schema created in code |
| Telegram ingest | `setInterval` poll calling `iterMessages` over a long-lived MTProto connection |
| Telegram credentials | one process-level `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` (`telegram.ts:583`) |
| EA auth | `linkCode` on register and heartbeat only. Not on poll or report. See the security item below |

The obvious SaaS move is to add `tenant_id` to about 30 tables and thread it through 715 call sites
in a 555 KB file. Do not do that. A missed `WHERE` clause here does not leak a row, it executes
tenant A's signal on tenant B's live account.

Give each tenant their own engine container with their own SQLite file. The engine takes its identity
from config and is otherwise unchanged. Why this is right and not just easier:

1. Each tenant brings their own Telegram session and their own MT5 broker credentials.
2. Each tenant already needs their own MT5 container, so per-tenant compute is already the cost
   structure. The engine process alongside it is nearly free.
3. SQLite stays SQLite. No D1 migration for trading data, no store-layer rewrite, and the existing
   552 KB test suite keeps passing as-is.
4. Blast radius. The known gramjs reconnect freeze becomes one tenant's outage.
5. Schema drift across tenants is handled, because the engine self-migrates in code on boot.
6. `app.ts` stops being a launch blocker. It stays a velocity problem, fixed on its own schedule.

### The one thing this model would have cost you, and the fix

"There is no cross-tenant data worth sharing" is wrong. Many tenants will subscribe to the same
public signal channels. A provider's win rate measured across many subscribers' real executions is
far more meaningful than any single tenant's sample, and an aggregated provider leaderboard is a
product feature competitors cannot easily copy. That is a moat.

Container-per-tenant does not block this. The rule "the control plane never queries trading tables"
does. So amend the rule rather than the architecture: each engine pushes an anonymised
signal-outcome event stream outbound to the control plane (Cloudflare Queues into D1 or R2). The
control plane still never reaches into a tenant DB. Aggregation needs tenant consent and real
anonymisation design, so treat it as a deliberate feature and not a side effect.

### Trial economics

A free trial under this model costs a full MT5 provision: gigabytes of Wine prefix and minutes of
install, before you know whether the signup is real. Offer a paper-trade or parser-only tier that
runs the engine with no MT5 container attached. The parser is the part that demonstrates value
anyway, and it costs almost nothing to run.

## Hosting: quoted 2026-07-30, decision deferred pending two answers

### Measured per-tenant footprint

Taken from the live production box (Intel Xeon E31265L, a 2011 Sandy Bridge part at 2.4GHz), so treat
these as a pessimistic ceiling. A current cloud vCPU has roughly 2.5x the per-thread performance.

| Process | RSS | CPU |
| --- | --- | --- |
| `main` (terminal64.exe under Wine) | 39.3 MB | 33.9% |
| Xvfb | 23.1 MB | 3.2% |
| bun (linux-mt5 control API) | 12.3 MB | 0.4% |
| x11vnc | 10.2 MB | 0.1% |
| wineserver | 3.1 MB | 11.6% |
| websockify plus Wine services | ~21 MB | ~0 |
| **MT5 container total** | **105.9 MB** | **~56% of one thread** |
| `telegram-tc-app-1` engine | 194.8 MB | 1.6% |

A tenant pair is about 300 MB RAM, 0.57 threads on 2011 silicon, and 3.4 GB disk (2.7 GB Wine prefix
plus 0.7 GB engine data). On a modern dedicated vCPU that is closer to 0.25 vCPU per tenant.

Planning figures: **0.25 vCPU, 300 MB RAM, 3.4 GB disk per tenant**, held to 70% CPU for headroom.

### Quotes obtained 2026-07-30

Same 4 vCPU class, monthly. Vultr figures are the General Purpose tier, which is dedicated vCPU.
Shared-vCPU tiers are cheaper and are the wrong product here, because MT5 draws sustained CPU and
gets throttled on shared cores.

| Option | Region | Spec | $/mo | At 10 tenants | Share of EUR 400 MRR |
| --- | --- | --- | --- | --- | --- |
| Hetzner CCX23 | Falkenstein, DE | 4 dedicated, 16 GB, 160 GB | ~29 | $2.90/tenant | 7% |
| Vultr General Purpose | Johannesburg | 4 vCPU, 16 GB, 80 GB | 120 | $12/tenant | 28% |
| Azure | Johannesburg | 4 vCPU class | 126.29 | $12.60/tenant | 29% |
| AWS | Cape Town (no JHB region) | 4 vCPU class | 147 | $14.70/tenant | 34% |
| GCP | Johannesburg | 4 vCPU class | 167 | $16.70/tenant | 39% |

Vultr and Azure are effectively tied for Johannesburg and both beat AWS and GCP. Hetzner is 4x
cheaper than the best JHB option, which prices being in Johannesburg at about **USD 1,090 per year**
at ten tenants.

Vultr scales at a flat rate, so the growth path is clean:

| Vultr JHB | $/mo | Tenants with headroom | $/tenant |
| --- | --- | --- | --- |
| 1 vCPU / 4 GB / 30 GB | 30 | 2-3, disk-bound | ~11 |
| 2 vCPU / 8 GB / 50 GB | 60 | 5-6 | ~11 |
| 4 vCPU / 16 GB / 80 GB | 120 | 11 | ~11 |

Region availability: Azure (South Africa North), GCP (`africa-south1`), Vultr, and Fly (`jnb`) all
have Johannesburg. AWS has Cape Town (`af-south-1`) only. Hetzner has no African presence, so about
160 to 180 ms from JHB. Also worth quoting local providers, which often undercut hyperscalers for
South African hosting: Xneelo (the former Hetzner South Africa, a separate company from Hetzner
Germany), Afrihost Cloud, and RSAWEB.

### One concrete trap

Avoid burstable instance families for this workload. AWS `t3`/`t4g` and Azure `B`-series bill on CPU
credits, and MT5 draws sustained rather than bursty CPU. Ten tenants at 0.25 vCPU is 2.5 vCPU
continuous, which exceeds a `t3.xlarge`'s 1.6 vCPU baseline. You either pay unlimited-mode surcharges
or get throttled into EA latency you will waste a day diagnosing.

### The two answers that should decide this, both cheap to get

1. **Broker ping.** For a trade copier the latency that matters is MT5 terminal to broker server, not
   operator to server. FTMO and HFM typically run European servers. If so, a Johannesburg box adds
   150 to 180 ms to every order and Hetzner is both cheaper and closer to the venue. Check the ping to
   the trade server in the MT5 status bar on the running terminal.
2. **POPIA.** If you sell to South African customers while holding their Telegram sessions and broker
   account data, data residency may not be optional. That settles the question regardless of latency
   or cost. Ask alongside the copy-trading licensing question at the top of this document.

Hold the hosting decision until both are answered. Nothing else in the plan changes either way,
because the `TenantHost` interface keeps the host a driver rather than a rewrite.

### Do not host tenants on the current box

Measured on 2026-07-30: 7.7 GB RAM with 4.3 GB used and **swap fully exhausted** (2,028 MB of
2,048 MB), 11 to 19% iowait, and a 916 GB disk at 90%. The largest single memory consumer is
`qbittorrent-nox` at 1,073 MB, and the media stack (qbittorrent, Sonarr, Radarr, jackett, jellyfin)
totals about 1,991 MB, which is 6.6x the entire MT5 plus engine footprint. MT5 is one of the
best-behaved things on the machine at 1.4% of RAM.

The exhausted swap is the likely explanation for the "reboots often" note in the deployment memory,
and a plausible contributor to the gramjs reconnect freezes. This box is a media server first, by the
owner's explicit priority, so the trading stack is the thing that moves.

### Orchestration: not Kubernetes yet

k3s on Hetzner costs about the same as plain Docker Compose, because the control plane is free and it
is the same hardware. Cost is not the argument. The arguments are that single-node k3s is complexity
with no availability benefit, and that multi-node introduces pod rescheduling with volume reattach on
a pod holding a live broker session and an open position. That failure mode costs a customer money
rather than a log line, and needs PodDisruptionBudgets and a deliberate drain policy to manage.

At ten tenants a cluster would be scheduling ten pinned, stateful, non-fungible pods, which is the
workload Kubernetes is least differentiated on. Revisit past 50 tenants, when placement across many
hosts is the real bottleneck, and add it as a third `TenantHost` driver.

### One VM for the API layer: the distinction that matters

"One VM for the API layer" has two readings that cost very different amounts.

Reading A, one VM hosting many per-tenant engine containers, each with its own SQLite file. This is
the recommendation with placement set to a single host. No engine code changes.

Reading B, one shared API process serving all tenants. This forces the row-level `tenant_id` retrofit
across about 30 tables and 715 call sites that this document argues against.

Same hardware, same bill, and one of them costs a dangerous refactor. Take reading A.

## Cloudflare: control plane and edge, not runtime

Works: Pages and Workers for marketing, signup, billing, and console. D1 for the control-plane
database (tenants, users, invites, entitlements, placement, provisioning state, audit log, billing
events), which is low write volume, already SQLite-shaped, and inside the 10 GB per-database limit.
Access in front of tenant dashboards, which removes most of the reason to build auth for v1. Queues
and Cron for provisioning and the outbound analytics stream. R2 for versioned EA artifacts, encrypted
tenant backups, and log archives. Turnstile on signup.

Two things the first version of this doc called impossible are better stated as unwise, and the
distinction matters because someone will otherwise try them:

**Cloudflare Containers for MT5.** Custom instance types now reach 4 vCPU / 12 GiB / 20 GB, so the
sizing objection is out of date, and "no X server" was never a real objection since `linux-mt5`
already runs Xvfb and x11vnc inside a plain container. The actual disqualifier is that all Container
disk is ephemeral. Every wake gets a fresh disk, so the Wine prefix and the broker login are gone.
Snapshots are listed as coming. Always-on container pricing also loses badly to Hetzner. Revisit only
when persistent volumes ship.

**gramjs on Workers or Durable Objects.** Workers have TCP `connect()` and maturing `node:net` and
`node:crypto` compatibility, and people do proxy MTProto through Durable Objects. So this is possible
and experimental. It is still the wrong call: DO eviction and redeploys restart the session, always-on
duration billing per tenant is unattractive, and gramjs reconnect fragility is a known problem in
this codebase already. The ingester stays on a real Bun host, which is where it runs today.

D1 for the control plane checks out as originally stated.

Boundary:

```
Cloudflare (control plane)          Tenant machine (Fly, later Hetzner)
--------------------------          -----------------------------------
marketing + signup (Pages)          tc-engine container
console + billing (Workers)           - Hono API, local SQLite, gramjs ingester
control-plane API (Workers)         linux-mt5 container
control-plane DB (D1)                 - MT5 under Wine, persistent Wine prefix
provisioner (Queues + Cron)
analytics intake (Queues -> D1)     outbound only: health, summary, signal-outcome events
EA artifacts + backups (R2)
tenant SSO (Access)
```

## Telegram: there is no commercial product that solves ingestion

Asked directly, and the answer is worse than "it costs money."

Telegram's commercial surfaces are Premium, Ads, Stars and gifts, and Business account features
(greetings, quick replies, your own support chatbot). None sells read access to channels you do not
own. There is no paid data or ingestion tier.

The Bot API is official and free, and a bot added to a channel as admin does receive posts. The
blocker is that only that channel's owner can add it, and signal providers are third parties.

The MTProto client API that gramjs uses is also official and documented. It is how every third-party
Telegram client works and using it is permitted. What you do not get is a commercial tier, an SLA, or
immunity from anti-spam heuristics. Automated reading across many accounts from one API ID is exactly
what those heuristics target.

On the WhatsApp comparison: the WhatsApp Business Cloud API is a genuine paid product from Meta, and
it also does not do this. It is for a business messaging its own customers, not reading third-party
groups, and Meta bans the unofficial libraries aggressively. Even the platform with a real commercial
API does not sell this capability.

So the options are: the tenant's own account via gramjs (what you do today, and the reason per-tenant
`api_id` matters, because it makes the "the tenant is reading channels they subscribed to" framing
true rather than decorative), or getting providers to add your bot as a channel admin. The second
will never cover the long tail, but for your top providers it is worth asking. It gives a more
reliable feed than polling, removes the grey area, and creates a business relationship that could
itself be the moat.

Telegram ships quickly, so re-check their current API and business pages before building onboarding
around this.

## boxyhq/saas-starter-kit

Its stack is Next.js, Postgres, Prisma, NextAuth, SAML Jackson, Retraced, Svix, Stripe, Apache 2.0.
Take three ideas, leave the code:

1. The team / member / invitation schema shape. Copy it into D1 rather than reinventing.
2. Audit log as a first-class entity. The control plane needs its own for billing changes,
   provisioning, and guardian unpauses.
3. The API-key model, if programmatic access ever matters.

| boxyhq provides | Use instead |
| --- | --- |
| NextAuth | Cloudflare Access for v1. Better Auth on Workers with D1 later if wanted |
| SAML Jackson (SSO + SCIM) | Nothing. Largest part of boxyhq, least relevant to a retail trader product |
| Retraced (audit) | A D1 table |
| Svix (webhooks) | Cloudflare Queues plus a Worker |
| Stripe | Stripe directly, webhook handled by a Worker |
| Prisma + Postgres | D1 for the control plane. Trading data stays in per-tenant SQLite |
| Sentry | Keep Sentry, or Tail Workers plus Logpush |

The deeper mismatch is the model. boxyhq assumes a shared-database web app with many users in one
Postgres. This is a provisioned per-tenant appliance, so the closer references are managed
single-tenant products such as Ghost Pro.

## Risks

**0. Regulatory qualification.** See the top of this document. Gating.

**1. Telegram credential custody and ToS exposure.** One app-level API id and hash today. Holding
customers' Telegram sessions means holding credentials that grant full account access, and heavy
automated reading across many accounts from one API id is the pattern Telegram bans. Require each
tenant to supply their own `api_id` and `api_hash`. Encrypt `StringSession` values at rest under a
per-tenant key held in the control plane, never plaintext in the tenant's own DB. Write the "Telegram
banned our api_id" runbook before launch.

**2. A bug here loses customer money, not customer data.** Five structural trade-safety findings from
the 2026-07-20 audit are still open (NETTING account handling, non-unique account identity,
`SPLIT_ORDER` per-leg contract, pre-proof virtual-TP `HIT` latching, memory-only trailing stops), and
there is already a real duplicate-open incident on VIP Gold. Under a SaaS these become support tickets
with a monetary claim attached. Close them before the first external tenant. Add a per-tenant and a
global kill switch owned by the control plane.

**3. Unauthenticated EA endpoints.** `/api/mt5/poll` and `/api/mt5/poll-line` lease queue items on a
bare `accountId` query parameter (`app.ts:1025-1035`). `/api/mt5/report` accepts an execution report
with no auth at all (`app.ts:1037-1041`). `linkCode` is checked on register and heartbeat only.
Account ids are `mt5-<accountNumber>`, which is low entropy. Today this is contained by a private
network. The moment a tunnel exposes the app with an `/api/mt5/*` exemption for Access, anyone can
lease another tenant's work items and post fabricated execution reports. Fix by keeping EA-to-engine
traffic on the machine's private network only, or by adding a per-account token to all nine endpoints.
This is a pre-launch blocker either way.

**4. Version skew across three moving parts.** Engine, EA `.ex5`, and MT5 image versions must be
mutually compatible. Note the correction here: `eaVersion` is already sent in both the register and
heartbeat payloads (`TelegramTC_EA.mq5:158` and `:1832`) and stored server-side (`app.ts:5570`) with
no gate. Gating at register would enforce nothing, because `RegisterAccount()` is fire-and-forget in
`OnInit` and the EA polls regardless while carrying only `accountId`. The enforcement point is the
lease: have `leaseNextQueueItem` refuse work when the stored `ea_version` is below minimum. That works
against today's EAs with no EA change, because heartbeat keeps the stored version fresh.

**5. No FloodWait or ban handling anywhere.** Neither `telegram.ts` nor `app.ts` handles a tenant
being rate-limited or banned mid-session. That is silent signal loss, and it is distinct from the
"our api_id got banned" case. Needs per-tenant detection, backoff, and a notification to that tenant.

**6. Prop-firm and broker restrictions on copy tools.** There is already an FTMO rejection in the
project history. A supported-brokers policy, and an explicit unsupported list, belongs in onboarding
rather than in a support conversation after someone pays.

## Sequencing

Before the first external paying tenant:

- Regulatory question answered for the target jurisdiction.
- Trade-safety backlog closed (risk 2).
- EA endpoint authentication fixed (risk 3).
- EA version gate enforced at lease (risk 4).
- FloodWait and ban detection with tenant notification (risk 5).
- Engine takes tenant identity and all secrets from config. Verify `SEED_DEMO_DATA` (`app.ts:386`)
  and `DEFAULT_MT5_ACCOUNT_ID` cannot bleed into a real tenant.
- Auth in front of the dashboard. Cloudflare Access is the fastest honest answer.
- Provisioning is one idempotent command; deprovisioning genuinely deletes the Wine prefix and the
  tenant DB.
- Encrypted per-tenant backups to R2 with a restore that has actually been tested.
- Kill switch, per-tenant and global.
- Stripe subscription state gates provisioning.
- Supported-brokers policy published.
- A status page and an on-call path. A frozen ingester at 02:00 is lost signals, which is the product
  failing silently.

Can wait: cross-tenant provider analytics (design consent first), SAML and SCIM, teams beyond a
single owner, self-serve broker onboarding (do the first ten by hand, it teaches you the failure
modes), `app.ts` decomposition, the Hetzner migration, multi-region.

## Licensing note

`linux-mt5` is licensed free for non-commercial use, with commercial and hosted use reserved to the
copyright holder. You are the copyright holder, so you can use it. Running it inside a paid hosted
service makes you a commercial user of your own non-commercially-licensed repo, which is fine alone
and needs a CLA or a relicence the moment you take an outside contribution or a co-founder. Keeping
it in its own repo away from proprietary billing code keeps that boundary clean.
