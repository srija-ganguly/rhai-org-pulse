# Production Optimizations — PoC Gaps to Fix

Known issues and shortcuts in this PoC that must be addressed before production use.

## Performance

- [ ] **Images collector timeout** — No request-level timeout or cancellation. A single product with thousands of GitLab registry tags (e.g. builder images with 2,100+ tags) blocks the server indefinitely. Fix: add per-product timeout, run as background job, or skip GitLab registry tags above a threshold.
- [ ] **Sequential product processing** — All collectors iterate products sequentially. The Dashboard's dispatcher runs products in parallel K8s Jobs (MAX_PARALLEL=2). Fix: use `Promise.all` with concurrency limit across products.
- [ ] **No connection pooling** — Each `fetch()` call opens a new connection. The Dashboard's Python `requests.Session` reuses TCP connections. Fix: use a shared `undici.Agent` or Node's built-in HTTP agent for connection reuse.
- [ ] **No tag pagination caching** — The images collector re-fetches all tags on every run even for incremental syncs. Fix: cache tag lists or use `since` parameter if registry supports it.
- [ ] **GitLab API rate limiting** — No rate limit handling beyond basic retry. Heavy drops/changelogs collection can hit GitLab's rate limits. Fix: add Retry-After header support and global rate limit tracking.

## Data Correctness

- [ ] **Releases upsert key** — Dashboard uses `_id` (Beanie-generated ObjectId), PoC upserts on `product_key` + `platform_release_number`. Verify this produces correct deduplication for all edge cases.
- [ ] **Products `collectors` field** — PoC stores the `collectors` array from YAML; Dashboard strips it before DB write and adds `sync_completed_at`/`sync_success` fields (set by dispatcher). Decide which fields to include.
- [ ] **Repositories `id` field** — Dashboard's Beanie adds an `id` field (null). PoC doesn't include it. Minor schema difference.
- [ ] **Drops `sync_completed_at`** — Set by Dashboard's dispatcher after all collectors finish for a product. Not replicated in PoC since there's no dispatcher concept. Decide if needed.
- [ ] **Artifact `git_repository` field** — Dashboard uses Beanie `Link[GitRepository]` (DBRef). PoC stores `git_repository_key` (string). Linking collector uses string key for lookups, which works, but schema differs from Dashboard.
- [ ] **Changelogs zero output** — Changelogs collector produced 0 results. Investigate: may need drops with `git_branch` set AND artifacts linked to those drops with matching commits. Verify the changelog logic matches Dashboard's prerequisite chain.
- [ ] **Wheels zero output** — Wheels collector produced 0 results. Investigate: `rhai` product has no `wheels-collections` in collectors list, and `builder-images` repos may not have `type: wheels-collection`. Check YAML config.

## Configuration

- [ ] **Quote all `.env` values** — Values containing `#` get truncated by dotenv (it treats `#` as inline comment). Always wrap values in double quotes: `KEY="value"`. This is safe for all services — dotenv strips the quotes. Caused a real auth failure in this PoC with `REGISTRY_REDHAT_PASSWORD`.

## Security

- [ ] **MongoDB credentials** — Currently in `.env` which is gitignored. For production, use Vault-synced K8s secrets (same as Dashboard).
- [ ] **Registry credentials in memory** — Credentials are held in `context.secrets` (frozen object) for the process lifetime. Same as Dashboard — acceptable, but note for security review.
- [ ] **No auth on API routes** — All auth removed for PoC testing. Production must re-add `requireAuth`/`requireAdmin` middleware.
- [ ] **SSO token caching** — SSOClient caches tokens in memory with expiry. Verify renewal logic handles clock skew and token revocation.

## Reliability

- [ ] **No graceful shutdown** — Long-running sync blocks server shutdown (Ctrl+C doesn't work). Fix: use `AbortController` to cancel in-flight requests on SIGTERM, add request timeout to all sync endpoints.
- [ ] **No sync cancellation** — Once a sync starts, there's no way to stop it. Fix: add an abort mechanism via `POST /sync/cancel` that signals the running collector to stop.
- [ ] **Error isolation** — One failing product in a collector loop stops all subsequent products. Fix: wrap each product iteration in try/catch (partially done for drops, not for images/wheels/releases).
- [ ] **No retry on GitLab 5xx** — `gitlab-fetcher.js` has no retry logic (unlike `registry-client.js` which does). Fix: add retry with backoff, matching the Dashboard's pattern.
- [ ] **MongoDB connection resilience** — No reconnect logic if MongoDB connection drops. Fix: enable `MongoClient` auto-reconnect options or implement manual reconnect.

## Operational

- [ ] **No logging framework** — Uses `console.log/warn/error`. Production should use structured logging (matching Org Pulse's patterns or adding a logger).
- [ ] **No metrics/observability** — Timing is logged but not exposed as metrics. Fix: integrate with Org Pulse's diagnostics system, add Prometheus-style counters if needed.
- [ ] **Dispatcher equivalent** — Dashboard uses a K8s CronJob dispatcher that creates separate Jobs per collector per product with resource limits. Org Pulse's refresh registry handles scheduling but runs everything in-process. For heavy collectors (images), consider external job execution.
- [ ] **Resource limits** — No memory or CPU limits on collector operations. Dashboard's dispatcher sets per-Job resource limits (e.g. 512Mi for images). In-process Node.js collectors share the server's memory.
- [ ] **Conflict with original collectors** — If both systems write to the same MongoDB, upserts could overwrite each other. For production, either: (a) use a separate database, (b) disable original collectors, or (c) add write coordination.

## Code Quality

- [ ] **Test coverage** — Only 17 unit tests for the original 3 collectors. The 9 new collectors have no tests. Fix: add tests for all collectors before merging.
- [ ] **Hardcoded constants** — GitLab project paths, Pyxis API URLs, Atlas URLs, Konflux API server URL are hardcoded. Fix: make configurable via module secrets or config.
- [ ] **No input validation** — API endpoints don't validate query parameters. Fix: add schema validation for query params.
- [ ] **ESLint module-process-env rule** — PoC reads `DEMO_MODE` from `process.env` directly (line 17). Production must use `context.secrets` or the module config pattern.
