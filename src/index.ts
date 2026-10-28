interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}${responseHints(res)}`,
    res.url,
    res.status,
  );
}

/**
 * Facts about a FAILED response that live in its headers, not its body, appended
 * so the gateway's classifier (which only ever sees this string) can tell a limit
 * from a wall from a refusal (fleet #3477). Both are standard, both are absent on
 * almost every response, and neither is invented: `Retry-After` is the server
 * saying "come back later" (the one thing that makes a 403 a throttle), and
 * Cloudflare marks a bot challenge with `cf-mitigated: challenge`.
 */
function responseHints(res: Response): string {
  const hints: string[] = [];
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) hints.push(`retry-after: ${retryAfter.slice(0, 40)}`);
  if ((res.headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge') hints.push('Cloudflare bot challenge (cf-mitigated: challenge)');
  return hints.length ? ` (${hints.join('; ')})` : '';
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ── Bounded readers — peak memory, not just wall time (fleet #3322) ──────
//
// `parseJson` above does `await res.text()` then `JSON.parse(raw)`, so a
// multi-megabyte upstream body is held TWICE at peak: once as the raw string
// and once as the object graph (which for an array of small objects runs
// several times the byte size). Nothing in `workers/gateway` can see that
// peak — it happens inside the pack, before any gateway code holds a payload —
// which is why the gateway-side payload caps of #3293 and #3320 did not move
// the 503/1102 rate at all.
//
// Measured on the live gateway, 2026-10-19, sha fa5de5c34, direct tools/call:
//   statcan_list_cubes  8,049,566 B   <- one upstream array, no limit argument
//   gnomad_gene BRCA1   2,732,706 B
// Five of those in flight at the quality runner's width is ~40 MB of parse
// peak against a 128 MB isolate; Cloudflare kills the isolate and every
// request in flight returns 503/1102, which is why the victims look random.
//
// `readJsonArrayPrefix` is the fix for the dominant shape: an upstream that
// returns one enormous top-level JSON array with no server-side paging. It
// parses elements off the stream and DISCARDS the consumed bytes, so peak
// retained memory is one element plus one chunk rather than the whole body,
// and it cancels the body as soon as it has what it was asked for.

/** Default ceiling for a single upstream JSON body read into an isolate.
 *  Chosen so the known tail (statcan 8.0 MB, gnomad 2.7 MB) is bounded well
 *  below the point where a handful of concurrent reads exhausts 128 MB. */
const DEFAULT_MAX_JSON_BYTES = 1_500_000;

interface JsonArrayPrefix<T> {
  /** The decoded elements, at most `maxItems` of them. */
  items: T[];
  /** True when the upstream array had more elements than we read. */
  truncated: boolean;
  /** Bytes actually pulled off the socket — the number that bounds memory. */
  bytesRead: number;
  /** `Content-Length` if the upstream declared one, else null. */
  declaredBytes: number | null;
}

/**
 * Read the FIRST `maxItems` elements of a top-level JSON array off a response
 * stream without ever materialising the whole body.
 *
 * Use this instead of `parseJson` when the upstream returns one big array and
 * offers no `limit`/`offset` of its own. Peak retained memory is one element
 * plus the current chunk; the body is cancelled as soon as `maxItems` is
 * reached, so the remaining megabytes are never transferred at all.
 *
 *     const { items, truncated } = await readJsonArrayPrefix<Cube>(
 *       res, 'StatCan WDS', { maxItems: limit + offset });
 *
 * `maxBytes` is a second, independent backstop for a pathological element (a
 * single 50 MB object): hitting it stops the read and sets `truncated`, rather
 * than throwing, because a partial answer plus an explicit truncated flag is
 * more useful to a caller than an error.
 */
async function readJsonArrayPrefix<T>(
  res: Response,
  name: string,
  opts: { maxItems: number; maxBytes?: number },
): Promise<JsonArrayPrefix<T>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  const declaredRaw = Number(res.headers.get('content-length'));
  const declaredBytes = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  // No streaming body available (a mock, or an already-buffered response):
  // fall back to the whole-text path so behaviour stays correct, just unbounded.
  if (!res.body) {
    const all = await parseJson<T[]>(res, name);
    if (!Array.isArray(all)) throw new Error(`upstream_down: ${name} returned ${typeof all} where a JSON array was expected.`);
    return {
      items: all.slice(0, opts.maxItems),
      truncated: all.length > opts.maxItems,
      bytesRead: declaredBytes ?? 0,
      declaredBytes,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const items: T[] = [];

  let buf = '';
  let scan = 0;
  let bytesRead = 0;
  let started = false; // consumed the opening '['
  let arrayEnded = false;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let elemStart = -1;
  let truncated = false;

  const push = (text: string) => {
    const t = text.trim();
    if (!t) return;
    items.push(JSON.parse(t) as T);
  };

  try {
    outer: while (items.length < opts.maxItems && !arrayEnded) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      buf += decoder.decode(value, { stream: true });
      if (bytesRead > maxBytes) { truncated = true; break; }

      for (; scan < buf.length; scan++) {
        const ch = buf[scan];

        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }

        if (!started) {
          if (ch === '[') { started = true; continue; }
          if (ch.trim() === '') continue;
          throw new Error(
            `upstream_down: ${name} returned a body that does not begin with a JSON array (saw ${JSON.stringify(ch)}). ` +
              'This reader is only for upstreams that answer with one top-level array.',
          );
        }

        if (ch === '"') { if (depth === 0 && elemStart < 0) elemStart = scan; inStr = true; continue; }

        if (ch === '{' || ch === '[') {
          if (depth === 0 && elemStart < 0) elemStart = scan;
          depth++;
          continue;
        }

        if (ch === '}' || ch === ']') {
          if (depth > 0) {
            depth--;
            if (depth === 0 && elemStart >= 0) {
              push(buf.slice(elemStart, scan + 1));
              elemStart = -1;
              if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
            }
            continue;
          }
          // depth 0 and a closing bracket: the end of the top-level array.
          if (elemStart >= 0) { push(buf.slice(elemStart, scan)); elemStart = -1; }
          arrayEnded = true;
          break outer;
        }

        if (ch === ',' && depth === 0) {
          if (elemStart >= 0) {
            push(buf.slice(elemStart, scan));
            elemStart = -1;
            if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
          }
          continue;
        }

        // A bare scalar element (number / true / false / null).
        if (depth === 0 && elemStart < 0 && ch.trim() !== '') elemStart = scan;
      }

      // Drop everything already consumed. THIS is what bounds memory: without
      // it `buf` grows to the full body and the reader is streaming in name only.
      if (elemStart >= 0) {
        buf = buf.slice(elemStart);
        scan -= elemStart;
        elemStart = 0;
      } else {
        buf = buf.slice(scan);
        scan = 0;
      }
    }
  } finally {
    // Cancel rather than drain: the point is that the remaining megabytes are
    // never transferred. A cancel on an already-finished body is a no-op.
    await reader.cancel().catch(() => {});
  }

  return { items, truncated, bytesRead, declaredBytes };
}

/**
 * `parseJson`, with a hard ceiling on how many bytes are read.
 *
 * For an upstream whose body is not a single array (so `readJsonArrayPrefix`
 * does not apply) but which can still answer with megabytes. Unlike the array
 * reader this one THROWS when the cap is hit, because a truncated prefix of an
 * arbitrary JSON document is not parseable and there is no partial answer to
 * hand back. A declared `Content-Length` over the cap is refused before a
 * single chunk is read.
 */
async function parseJsonBounded<T>(
  res: Response,
  name: string,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES,
): Promise<T> {
  const declaredRaw = Number(res.headers.get('content-length'));
  const declared = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  const tooBig = (n: number) =>
    new Error(
      `upstream_down: ${name} answered with ${n.toLocaleString()} bytes, over this pack's ${maxBytes.toLocaleString()}-byte ceiling. ` +
        'The body is not read past the ceiling on purpose — a few concurrent reads of a body that size exhaust the ' +
        'Worker isolate and take every other in-flight request down with them. Narrow the request (a smaller range, ' +
        'a specific id, or a lower limit) and retry.',
    );

  if (declared !== null && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooBig(declared);
  }
  if (!res.body) return parseJson<T>(res, name);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let bytesRead = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) throw tooBig(bytesRead);
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected. ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON. ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}
/**
 * MSHA mine records — search a US mine by operator or mine name, or look up
 * a known MSHA Mine ID for its status, recent inspections, violations (with
 * assessed penalties) and employment/production (fleet #2822). Also counts a
 * mine's violations by calendar year/range, broken down by violator type and
 * S&S, in one call (msha_violation_counts, fleet #3181) — msha_mine_detail's
 * violations list is capped at violations_limit and carries no true count.
 *
 * SOURCE. MSHA's Mine Data Retrieval System (msha.gov/mdrs) is a
 * MicroStrategy BI application embedded in an <iframe>, not a JSON endpoint
 * a Worker can call per request (confirmed 2026-10-08: the page's src is
 * microstrategy.msha.gov/MicroStrategy/asp/Main.aspx). MSHA instead
 * publishes the same underlying data as downloadable pipe-delimited files at
 * arlweb.msha.gov/OpenGovernmentData — refreshed roughly weekly. US federal
 * data, public domain. This pack reads a weekly-refreshed mirror in Supabase
 * (msha_mines, msha_violations, msha_inspections,
 * msha_employment_production), loaded by scripts/ingest-msha-mines.mjs
 * (.github/workflows/msha-mines-refresh.yml) — see that script's header for
 * why the fetch is done directly rather than routed through the gateway
 * (unlike registry.faa.gov, arlweb.msha.gov answers a plain fetch() from a
 * Cloudflare Worker edge with no blocking).
 *
 * BOUNDED ON PURPOSE. Violations and Inspections carry MSHA's full history
 * back to 2000 (millions of rows); employment/production the same. This
 * pack's backing tables hold only the most recent 5 calendar years of each
 * (see migration 237's header and the ingest script) — every response that
 * touches those tables says so with a `bound` field, so a caller never reads
 * a short list as "this mine only has N violations ever."
 */

const UA = 'pipeworx-mcp-msha-mines/1.0 (+https://pipeworx.io)';
const UPSTREAM = 'MSHA Mine Data Retrieval System (msha.gov/mdrs, arlweb.msha.gov)';
const RECENT_YEARS_BOUND = 5;
const VIOLATIONS_BOUND_NOTE = `Violations and inspections are loaded for the most recent ${RECENT_YEARS_BOUND} calendar years only (MSHA's full history back to 2000 is not loaded) — a low count here does not mean the mine has no older history.`;

async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const headers = { 'User-Agent': UA, ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, UPSTREAM);
}

/** The gateway injects Supabase credentials into `args` as `_supabaseUrl` /
 *  `_supabaseKey` (see MCP_PACKS `injectSupabase: true` for this pack's
 *  manifest row) — same pattern as mcps/faa-aircraft-registry. */
async function pg(args: Record<string, unknown>, path: string): Promise<any[]> {
  const url = (args._supabaseUrl as string | undefined)?.trim();
  const key = (args._supabaseKey as string | undefined)?.trim();
  if (!url || !key) throw new Error('backing-store credentials not injected');
  const res = await pwFetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' },
  });
  if (!res.ok) throw await httpError(res, 'MSHA mine records backing store');
  return parseJson<any[]>(res, 'MSHA mine records backing store');
}

/**
 * Exact row count for a filtered query, via PostgREST's `Prefer: count=exact`
 * + `Content-Range` response header rather than fetching (and counting)
 * rows — same pattern as mcps/gao-protests/src/index.ts's pgCount. `limit=1`
 * keeps the response body itself tiny; the header carries the real total
 * regardless of how many rows would otherwise match (fleet #3181 — this
 * pack had no way to COUNT a mine's violations, only list a bounded recent
 * window of them).
 */
async function pgCount(args: Record<string, unknown>, path: string): Promise<number> {
  const url = (args._supabaseUrl as string | undefined)?.trim();
  const key = (args._supabaseKey as string | undefined)?.trim();
  if (!url || !key) throw new Error('backing-store credentials not injected');
  const res = await pwFetch(`${url}/rest/v1/${path}&limit=1`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json', Prefer: 'count=exact' },
  });
  if (!res.ok) throw await httpError(res, 'MSHA mine records backing store');
  const range = res.headers.get('content-range') ?? '';
  const total = range.split('/')[1];
  const n = Number(total);
  if (!Number.isFinite(n)) throw new Error(`count_unavailable: backing store did not return a Content-Range total for ${path}`);
  return n;
}

function esc(v: string): string {
  return encodeURIComponent(v);
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
}

/**
 * Guards every tool against the "table exists but was never loaded" state
 * (same shape as mcps/faa-aircraft-registry/src/index.ts's
 * assertRegistryLoaded, fleet #2790). Without this, a mine lookup against an
 * empty table answers a confident `found:false` that reads as "MSHA has no
 * such mine" when the real condition is "our weekly refresh hasn't completed
 * yet" — a silent-zero wrong negative. Throws LOUDLY instead.
 */
/** The calendar-year window scripts/ingest-msha-mines.mjs currently keeps
 *  loaded for msha_violations/msha_inspections (recomputed from "now", same
 *  as the ingest script's own CUTOFF_YEAR) — so a count tool can say
 *  honestly which years of a request it can actually answer for. */
function loadedYearWindow(): { from: number; to: number } {
  const to = new Date().getUTCFullYear();
  return { from: to - RECENT_YEARS_BOUND + 1, to };
}

async function assertLoaded(args: Record<string, unknown>): Promise<string> {
  const rows = await pg(args, 'msha_mines?select=loaded_at&limit=1');
  if (rows.length === 0 || !rows[0]?.loaded_at) {
    throw new Error(
      'dataset_unavailable: the MSHA mine records backing tables are empty — the weekly refresh ' +
        '(scripts/ingest-msha-mines.mjs via .github/workflows/msha-mines-refresh.yml) has not yet ' +
        'completed a successful load. This is a Pipeworx-side gap, not evidence that any particular ' +
        'mine or operator is absent from MSHA records — every lookup fails the same way until the ' +
        'first load lands.',
    );
  }
  return rows[0].loaded_at;
}

const tools: McpToolExport['tools'] = [
  {
    name: 'msha_mine_search',
    description:
      'Search MSHA (Mine Safety and Health Administration) mine records by operator name, controller name, or mine name. Returns matching mines with their MSHA Mine ID, status (Active, Abandoned, Intermittent, etc.), mine type (Surface/Underground/Facility), coal vs metal/non-metal classification, commodity, state, and current operator/controller. Use this to find the Mine ID(s) for a company before calling msha_mine_detail. Sourced from MSHA\'s own bulk mine-records file (public domain), refreshed weekly. Keyless.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Operator, controller, or mine name (or part of one) to search for, e.g. "Peabody", "Warrior Met Coal", "O\'Neal Quarry".' },
        state: { type: 'string', description: 'Optional 2-letter US state code to restrict the search, e.g. "WV", "KY".' },
        status: { type: 'string', description: 'Optional exact mine status filter: Active, Abandoned, "Abandoned and Sealed", Intermittent, "New Mine", NonProducing, "Temporarily Idled".' },
        limit: { type: 'number', description: 'Max mines to return (default 25, max 100).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'msha_mine_detail',
    description:
      'Look up a known MSHA Mine ID: current status, type, commodity, operator and controller, plus recent inspections, recent violations (with assessed penalties, S&S flag, and abatement/termination dates), and recent quarterly employment and coal production. Violations/inspections/production cover only the most recent 5 calendar years (the response says so) — MSHA\'s full history back to 2000 is not loaded. Sourced from MSHA\'s own bulk mine-records files (public domain), refreshed weekly. Keyless.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        mine_id: { type: 'string', description: 'MSHA Mine ID, e.g. "4608254". Find it with msha_mine_search if you only have an operator/mine name.' },
        violations_limit: { type: 'number', description: 'Max recent violations to return (default 20, max 100).' },
        inspections_limit: { type: 'number', description: 'Max recent inspections to return (default 10, max 50).' },
      },
      required: ['mine_id'],
    },
  },
  {
    name: 'msha_violation_counts',
    description:
      'Count MSHA violations issued at one mine within a calendar year or year range — in ONE call, not a listing. Returns the TOTAL plus a breakdown by who it was issued to (Operator vs Contractor vs Agent vs Miner) and by significant-and-substantial (S&S) status. Use this instead of msha_mine_detail when the question is "how many" — msha_mine_detail only returns its most recent violations_limit rows (default 20, max 100) and has no true count. Counted by the calendar year of each violation\'s own issue date (VIOLATION_ISSUE_DT, via MSHA\'s own CAL_YR field). Only the most recent 5 calendar years are loaded (the response\'s `coverage` field says exactly which); a year outside that window comes back flagged as "not loaded," never as a silent zero. Takes a known MSHA Mine ID (use msha_mine_search to find one) or a mine/operator/controller name — the name path only works when it resolves to exactly one mine; otherwise it lists the candidates so you can retry with a mine_id. Sourced from MSHA\'s own bulk mine-records files (public domain), refreshed weekly. Keyless.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        mine_id: { type: 'string', description: 'MSHA Mine ID, e.g. "4601437". Preferred over mine_name — unambiguous.' },
        mine_name: { type: 'string', description: 'Mine, operator, or controller name to resolve to a Mine ID — used only when mine_id is omitted, and only works if it matches exactly one mine.' },
        year: { type: 'number', description: 'Single calendar year to count, e.g. 2025.' },
        year_from: { type: 'number', description: 'First calendar year of a range (inclusive). Use together with year_to instead of year.' },
        year_to: { type: 'number', description: 'Last calendar year of a range (inclusive). Use together with year_from instead of year.' },
      },
      required: [],
    },
  },
];

async function mshaMineSearch(args: Record<string, unknown>): Promise<unknown> {
  const query = String(args.query ?? '').trim();
  if (!query) throw new Error('query is required');
  const state = str(args.state);
  const status = str(args.status);
  const limit = Math.min(Math.max(Number(args.limit) || 25, 1), 100);

  const loadedAt = await assertLoaded(args);

  const q = esc(`*${query.toLowerCase()}*`);
  let path =
    `msha_mines?or=(mine_name.ilike.${q},operator_name.ilike.${q},controller_name.ilike.${q})` +
    `&select=mine_id,mine_name,coal_metal_ind,mine_type,mine_status,status_date,operator_name,controller_name,state,county_name,primary_sic,primary_canvass,no_employees&limit=${limit}&order=mine_status.asc`;
  if (state) path += `&state=eq.${esc(state.toUpperCase())}`;
  if (status) path += `&mine_status=eq.${esc(status)}`;

  const rows = await pg(args, path);

  return {
    query,
    filters: { state: state ?? null, status: status ?? null },
    count: rows.length,
    mines: rows.map((r) => ({
      mine_id: r.mine_id,
      mine_name: r.mine_name,
      operator_name: r.operator_name,
      controller_name: r.controller_name,
      mine_status: r.mine_status,
      status_date: r.status_date,
      mine_type: r.mine_type,
      coal_or_metal: r.coal_metal_ind === 'C' ? 'Coal' : r.coal_metal_ind === 'M' ? 'Metal/Non-Metal' : r.coal_metal_ind,
      commodity: r.primary_canvass ?? r.primary_sic ?? null,
      state: r.state,
      county: r.county_name,
      no_employees_on_form: num(r.no_employees),
    })),
    data_as_of: loadedAt,
    source: UPSTREAM,
    note: rows.length === 0 ? 'No mine, operator, or controller name matched this query.' : undefined,
  };
}

async function mshaMineDetail(args: Record<string, unknown>): Promise<unknown> {
  const mineId = String(args.mine_id ?? '').trim();
  if (!mineId) throw new Error('mine_id is required');
  const violationsLimit = Math.min(Math.max(Number(args.violations_limit) || 20, 1), 100);
  const inspectionsLimit = Math.min(Math.max(Number(args.inspections_limit) || 10, 1), 50);

  const loadedAt = await assertLoaded(args);

  const mineRows = await pg(args, `msha_mines?mine_id=eq.${esc(mineId)}&select=*&limit=1`);
  const mine = mineRows[0];

  if (!mine) {
    return {
      found: false,
      mine_id: mineId,
      note: `Mine ID "${mineId}" is not in MSHA's mine records as of the last weekly refresh.`,
      data_as_of: loadedAt,
      source: UPSTREAM,
    };
  }

  const [violations, inspections, production] = await Promise.all([
    pg(args, `msha_violations?mine_id=eq.${esc(mineId)}&select=*&order=violation_issue_dt.desc&limit=${violationsLimit}`),
    pg(args, `msha_inspections?mine_id=eq.${esc(mineId)}&select=*&order=inspection_end_dt.desc&limit=${inspectionsLimit}`),
    pg(args, `msha_employment_production?mine_id=eq.${esc(mineId)}&select=*&order=cal_yr.desc,cal_qtr.desc&limit=32`),
  ]);

  // production comes back at subunit grain (see migration 237's header) --
  // sum subunits into one row per calendar quarter here rather than at
  // ingest time, and cap at the 8 most recent quarters once summed.
  const byQuarter = new Map<string, { cal_yr: number; cal_qtr: number; avg_employee_cnt: number; hours_worked: number; coal_production: number; subunits: number }>();
  for (const r of production) {
    const key = `${r.cal_yr}-${r.cal_qtr}`;
    const cur = byQuarter.get(key) ?? { cal_yr: r.cal_yr, cal_qtr: r.cal_qtr, avg_employee_cnt: 0, hours_worked: 0, coal_production: 0, subunits: 0 };
    cur.avg_employee_cnt += num(r.avg_employee_cnt) ?? 0;
    cur.hours_worked += num(r.hours_worked) ?? 0;
    cur.coal_production += num(r.coal_production) ?? 0;
    cur.subunits += 1;
    byQuarter.set(key, cur);
  }
  const quarters = Array.from(byQuarter.values())
    .sort((a, b) => (b.cal_yr - a.cal_yr) || (b.cal_qtr - a.cal_qtr))
    .slice(0, 8);

  const violationsTotalPenaltyAssessed = violations.reduce((sum, v) => sum + (num(v.amount_due) ?? 0), 0);
  const violationsTotalPenaltyPaid = violations.reduce((sum, v) => sum + (num(v.amount_paid) ?? 0), 0);

  return {
    found: true,
    mine_id: mine.mine_id,
    mine_name: mine.mine_name,
    coal_or_metal: mine.coal_metal_ind === 'C' ? 'Coal' : mine.coal_metal_ind === 'M' ? 'Metal/Non-Metal' : mine.coal_metal_ind,
    mine_type: mine.mine_type,
    mine_status: mine.mine_status,
    status_date: mine.status_date,
    operator: { id: mine.operator_id, name: mine.operator_name },
    controller: { id: mine.controller_id, name: mine.controller_name },
    location: { state: mine.state, county: mine.county_name, district: mine.district, office: mine.office_name, longitude: str(mine.longitude), latitude: str(mine.latitude) },
    commodity: { primary_sic: mine.primary_sic, primary_canvass: mine.primary_canvass },
    no_employees_on_form: num(mine.no_employees),
    inspections: {
      bound: VIOLATIONS_BOUND_NOTE,
      count_returned: inspections.length,
      recent: inspections.map((i) => ({
        event_no: i.event_no,
        inspection_begin_dt: i.inspection_begin_dt,
        inspection_end_dt: i.inspection_end_dt,
        activity: i.activity,
        activity_code: i.activity_code,
        operator_name: i.operator_name,
        total_inspection_hours: num(i.total_insp_hours),
        total_onsite_hours: num(i.total_onsite_hours),
      })),
    },
    violations: {
      bound: VIOLATIONS_BOUND_NOTE,
      count_returned: violations.length,
      total_penalty_assessed_in_window_usd: Math.round(violationsTotalPenaltyAssessed * 100) / 100,
      total_penalty_paid_in_window_usd: Math.round(violationsTotalPenaltyPaid * 100) / 100,
      recent: violations.map((v) => ({
        violation_no: v.violation_no,
        violation_issue_dt: v.violation_issue_dt,
        section_cited: v.part_section,
        type: v.cit_ord_safe,
        significant_and_substantial: v.sig_sub === 'Y' ? true : v.sig_sub === 'N' ? false : null,
        likelihood: v.likelihood,
        injury_illness_gravity: v.inj_illness,
        negligence: v.negligence,
        no_affected: num(v.no_affected),
        proposed_penalty_usd: num(v.proposed_penalty),
        amount_due_usd: num(v.amount_due),
        amount_paid_usd: num(v.amount_paid),
        termination_dt: v.termination_dt,
        termination_type: v.termination_type,
        contested: v.contested_ind === 'Y',
      })),
    },
    employment_production: {
      bound: `${VIOLATIONS_BOUND_NOTE} Figures are summed across all reported subunits (underground, surface, mill, etc.) for each calendar quarter.`,
      quarters,
    },
    data_as_of: loadedAt,
    source: UPSTREAM,
  };
}

/** Resolves mine_id (verified to exist) or mine_name (must match exactly one
 *  mine) to a single {mineId, mineName}. Throws a NAMED error either way on
 *  a lookup failure — never a silent empty result — per fleet #3181. */
async function resolveMine(
  args: Record<string, unknown>,
  mineIdInput: string | null,
  mineNameInput: string | null,
): Promise<{ mineId: string; mineName: string | null }> {
  if (mineIdInput) {
    const rows = await pg(args, `msha_mines?mine_id=eq.${esc(mineIdInput)}&select=mine_id,mine_name&limit=1`);
    if (rows.length === 0) {
      throw new Error(`mine_not_found: Mine ID "${mineIdInput}" is not in MSHA's mine records as of the last weekly refresh.`);
    }
    return { mineId: rows[0].mine_id, mineName: rows[0].mine_name ?? null };
  }
  const name = mineNameInput as string;
  const q = esc(`*${name.toLowerCase()}*`);
  const rows = await pg(
    args,
    `msha_mines?or=(mine_name.ilike.${q},operator_name.ilike.${q},controller_name.ilike.${q})&select=mine_id,mine_name&limit=5`,
  );
  if (rows.length === 0) {
    throw new Error(`mine_not_found: No mine, operator, or controller name matched "${name}". Try msha_mine_search for candidates, then pass a mine_id.`);
  }
  if (rows.length > 1) {
    const candidates = rows.map((r) => `${r.mine_id} (${r.mine_name})`).join(', ');
    throw new Error(
      `ambiguous_mine_name: "${name}" matched ${rows.length}${rows.length === 5 ? '+' : ''} mines — ${candidates}. Call msha_mine_search to pick one, then pass its mine_id here.`,
    );
  }
  return { mineId: rows[0].mine_id, mineName: rows[0].mine_name ?? null };
}

async function mshaViolationCounts(args: Record<string, unknown>): Promise<unknown> {
  const mineIdInput = str(args.mine_id);
  const mineNameInput = str(args.mine_name);
  if (!mineIdInput && !mineNameInput) throw new Error('mine_id or mine_name is required');

  const year = num(args.year);
  const yearFrom = num(args.year_from);
  const yearTo = num(args.year_to);
  let lo: number;
  let hi: number;
  if (year != null) {
    lo = hi = year;
  } else if (yearFrom != null && yearTo != null) {
    lo = Math.min(yearFrom, yearTo);
    hi = Math.max(yearFrom, yearTo);
  } else {
    throw new Error('year, or both year_from and year_to, is required');
  }

  const loadedAt = await assertLoaded(args);
  const { mineId, mineName } = await resolveMine(args, mineIdInput, mineNameInput);

  const window = loadedYearWindow();
  const requestedYears = { from: lo, to: hi };
  const outOfWindow = hi < window.from || lo > window.to;
  const partiallyOutOfWindow = !outOfWindow && (lo < window.from || hi > window.to);

  const yearFilter = lo === hi ? `cal_yr=eq.${lo}` : `cal_yr=gte.${lo}&cal_yr=lte.${hi}`;
  const base = `msha_violations?mine_id=eq.${esc(mineId)}&${yearFilter}`;

  const [total, operator, contractor, agent, miner, sigSubYes, sigSubNo] = outOfWindow
    ? [0, 0, 0, 0, 0, 0, 0]
    : await Promise.all([
        pgCount(args, `${base}&select=id`),
        pgCount(args, `${base}&violator_type_cd=eq.Operator&select=id`),
        pgCount(args, `${base}&violator_type_cd=eq.Contractor&select=id`),
        pgCount(args, `${base}&violator_type_cd=eq.Agent&select=id`),
        pgCount(args, `${base}&violator_type_cd=eq.Miner&select=id`),
        pgCount(args, `${base}&sig_sub=eq.Y&select=id`),
        pgCount(args, `${base}&sig_sub=eq.N&select=id`),
      ]);
  const otherViolatorType = Math.max(0, total - operator - contractor - agent - miner);
  const sigSubNotRecorded = Math.max(0, total - sigSubYes - sigSubNo);

  let coverage: string;
  if (outOfWindow) {
    coverage = `Requested year(s) ${lo === hi ? lo : `${lo}-${hi}`} are entirely outside the loaded window (only calendar years ${window.from}-${window.to} are held) — this total is NOT a real zero, it means that period is not loaded here.`;
  } else if (partiallyOutOfWindow) {
    coverage = `Requested year(s) ${lo === hi ? lo : `${lo}-${hi}`} partially fall outside the loaded window (only calendar years ${window.from}-${window.to} are held) — the count below covers only the overlap with ${window.from}-${window.to}, not the full requested range.`;
  } else {
    coverage = `Calendar years ${window.from}-${window.to} are loaded; the requested year(s) ${lo === hi ? lo : `${lo}-${hi}`} are fully within that window.`;
  }

  return {
    mine_id: mineId,
    mine_name: mineName,
    requested_years: requestedYears,
    date_field: "violation_issue_dt, counted by its calendar year (MSHA's CAL_YR field)",
    coverage,
    total_violations: total,
    by_violator_type: { operator, contractor, agent, miner, other: otherViolatorType },
    significant_and_substantial: { yes: sigSubYes, no: sigSubNo, not_recorded: sigSubNotRecorded },
    data_as_of: loadedAt,
    source: UPSTREAM,
    note:
      total === 0 && !outOfWindow
        ? `No violations recorded for mine ${mineId} in ${lo === hi ? lo : `${lo}-${hi}`} within the loaded window (calendar years ${window.from}-${window.to}).`
        : undefined,
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'msha_mine_search':
      return mshaMineSearch(args);
    case 'msha_mine_detail':
      return mshaMineDetail(args);
    case 'msha_violation_counts':
      return mshaViolationCounts(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
