# Hotel Offer Orchestrator

Compare two mock hotel suppliers using TypeScript, Express, Temporal, and Redis. Each hotel search returns the cheapest offer per normalized hotel name, with inclusive price filtering performed in Redis.

Repository: https://github.com/nishantnsut27/hotel-offer-orchestrator

## Docker quickstart

Prerequisites: Git and a running Docker Engine with Docker Compose v2 (`--wait` support), Linux containers, and internet access for pinned image/package downloads. On Windows, use Docker Desktop with its WSL 2 backend. Host ports 3000, 6379, and 7233 must be available. Node.js 22 LTS (22.13 or newer within 22.x) and npm are needed for CLI verification and host development, but Docker builds include Node.

From a clean checkout:

```sh
git clone https://github.com/nishantnsut27/hotel-offer-orchestrator.git
cd hotel-offer-orchestrator
docker compose --profile local up --build --wait
docker compose ps
curl "http://localhost:3000/health"
curl "http://localhost:3000/api/hotels?city=delhi&minPrice=5000&maxPrice=6000"
```

In PowerShell, use `curl.exe` for curl examples and `npm.cmd` for npm commands, including forwarded Newman flags. No `.env` file is needed for Docker quickstart. The local profile runs separate API, worker, Temporal development-server, and Redis containers. Published ports bind to loopback. Temporal runs headless; port 7233 is its gRPC endpoint, not a web page.

Expected response:

```json
[
  { "name": "Holtin", "price": 5340, "supplier": "Supplier B", "commissionPct": 20 },
  { "name": "Radison", "price": 5900, "supplier": "Supplier A", "commissionPct": 13 }
]
```

All prices are INR. Commission does not adjust ranking. Every response includes a generated `x-request-id` header.

## Architecture and data flow

1. Express validates and normalizes the query, then starts `hotels-<request-id>` in Temporal.
2. Two Temporal activities call the supplier HTTP endpoints in parallel and validate their payloads.
3. Deterministic workflow/domain code deduplicates trimmed, lowercase names and selects the lowest price. Supplier A wins equal-price ties; the selected display name and commission are preserved.
4. A Redis activity atomically replaces `hotel-offers:results:<workflow-id>` with the complete selected offers, using price scores and serialized JSON members, and sets a five-minute expiry.
5. The same activity runs an inclusive `ZRANGEBYSCORE` query with open ends for absent bounds. The workflow orders matches by ascending price, then name, and Express returns the result.

Each valid request creates a fresh workflow and an isolated Redis key. Retry writes replace the same complete set safely. Empty results remove the key and return `[]` through Redis. A fresh request rebuilds offers after data loss. Supplier HTTP and Redis I/O run in activities; workflow code uses no environment reads, HTTP, Redis, or wall-clock time.

`src/api` handles HTTP validation/mapping, `src/config` validates startup settings, `src/domain` contains types and deterministic selection, `src/suppliers` contains fixtures and the HTTP client, `src/activities` handles I/O, `src/workflows` orchestrates it, and `src/runtime` manages processes and connections.

The application image supports `api`, `worker`, and combined `demo` modes. Docker builds precompile the workflow bundle, use a non-root runtime user and init process, and pin the Node/Redis image digests and Temporal CLI archive checksum. Temporal SDK 1.26.0, Redis client 6.3.1, and CLI 1.10.1 are pinned.

## API and fixtures

| Endpoint                                                  | Behavior                                          |
| --------------------------------------------------------- | ------------------------------------------------- |
| `GET /`                                                   | Service name and implemented paths                |
| `GET /api/hotels?city=delhi`                              | All selected Delhi offers                         |
| `GET /api/hotels?city=mumbai&minPrice=5000&maxPrice=6400` | Inclusive Redis price range                       |
| `GET /supplierA/hotels`                                   | Full Supplier A fixture array                     |
| `GET /supplierB/hotels`                                   | Full Supplier B fixture array                     |
| Supplier endpoint `?city=delhi`                           | Optional normalized city filter                   |
| `GET /health/live`                                        | Process liveness                                  |
| `GET /health/ready`                                       | API, Temporal, Redis, and active-worker readiness |
| `GET /health`                                             | Infrastructure plus both suppliers                |
| `GET /internal/probe`                                     | Real Temporal/Redis diagnostic, only when enabled |

`city` is required for hotel searches and trimmed/lowercased. Missing, blank, repeated, array, and structured city values return 400. Price bounds are optional finite, non-negative decimal numbers; fractional and scientific notation are accepted. Blank, malformed, negative, repeated, structured, non-finite, or inverted bounds return 400. Bounds include both endpoints. Unknown cities and empty ranges return 200 with `[]` when both suppliers are healthy.

Supplier responses contain exactly `hotelId`, `name`, `price`, `city`, and `commissionPct`. Each supplier has four Delhi and two Mumbai entries; no city query returns all six in fixture order. Supplier A's Holtin entry is:

```json
{ "hotelId": "a1", "name": "Holtin", "price": 6000, "city": "delhi", "commissionPct": 10 }
```

Complete winners, in response order:

| City   | Hotel         | A price | B price | Winner     | Price | Commission % |
| ------ | ------------- | ------- | ------- | ---------- | ----- | ------------ |
| Delhi  | MetroStay     | 4500    | —       | Supplier A | 4500  | 12           |
| Delhi  | CityInn       | —       | 4800    | Supplier B | 4800  | 14           |
| Delhi  | Holtin        | 6000    | 5340    | Supplier B | 5340  | 20           |
| Delhi  | Radison       | 5900    | 6200    | Supplier A | 5900  | 13           |
| Delhi  | Oberoi        | 7000    | 7000    | Supplier A | 7000  | 15           |
| Mumbai | Sea View      | 5200    | 5000    | Supplier B | 5000  | 18           |
| Mumbai | West End      | —       | 6400    | Supplier B | 6400  | 14           |
| Mumbai | Harbour Grand | 7800    | —       | Supplier A | 7800  | 12           |

Hotel results contain exactly `name`, `price`, `supplier`, and `commissionPct`. Errors contain exactly an `error` object with `code` and `message`, without stack traces. For example:

```json
{ "error": { "code": "INVALID_QUERY", "message": "Invalid hotel search query" } }
```

Unknown routes return 404, supplier/dependency failures 503, search deadlines 504, and unexpected failures 500. If either supplier remains unavailable, the whole search fails with 503, including an unknown-city or empty-range search. Invalid hotel queries still return 400. Disabled supplier routes check availability before validating their own city queries.

## Health, retries, and shutdown

`/health/live` returns 200 with `{ "status": "up" }` while serving HTTP. `/health/ready` returns 200 only when API, Temporal, Redis, and a worker heartbeat are up; supplier availability is independent of readiness. Worker heartbeats are scoped by namespace/task queue, refreshed every five seconds, and expire after fifteen seconds.

`/health` concurrently checks infrastructure and both configured supplier URLs, including payload validation and a two-second supplier deadline. Healthy response:

```json
{
  "status": "ready",
  "checks": {
    "api": "up",
    "worker": "up",
    "temporal": "up",
    "redis": "up",
    "supplierA": "up",
    "supplierB": "up"
  }
}
```

Full health returns 503 with `status: "not_ready"` when any required check is down. Individual checks can report `up`, `down`, or `not_configured`. Readiness contains only the four infrastructure checks.

Supplier HTTP requests, including body reads, time out after two seconds. Supplier activities have five-second start-to-close timeouts and at most three attempts, with one- and two-second retry delays. Invalid payloads, malformed JSON, and permanent client errors fail after one attempt. Redis activities have three-second timeouts, at most two attempts, and a one-second retry delay. Redis failure returns an error without bypassing storage.

Hotel workflow execution and HTTP deadlines are thirty and thirty-five seconds. HTTP deadlines request best-effort cancellation bounded at two seconds. Required process failures trigger cleanup. Startup/shutdown budgets are sixty/ten seconds. Shutdown cancels active work and closes connections. Structured logs include request/workflow IDs, activity attempts, and sanitized failure types; workflow events are replay aware.

## Postman and clean-checkout checks

With Node 22 and the healthy Docker deployment:

```sh
npm ci
npm run lint
npm run format:check
npm run typecheck
npm run build
npm run validate:postman
npm run test:postman
```

Import [the collection](postman/hotel-offer-orchestrator.postman_collection.json) into Postman. Its collection variables are `baseUrl=http://localhost:3000` and `supplierDown=none`. Run the entire collection with a 40000 ms request timeout. During an outage set `supplierDown` to `A` or `B` to match the server; mode/configuration mismatches fail assertions.

The 75 requests assert request IDs, JSON shapes, exact fixture fields/values/order, Delhi/Mumbai winners, the Oberoi tie, supplier-exclusive hotels, normalized/unknown cities, inclusive/open/equal/zero/fractional/scientific/empty ranges, invalid queries, service index, unknown routes, and all three health endpoints. The complete collection must pass in each correctly configured mode.

Newman 6.2.3 runs the CLI checks. Ajv 6.15.0 validates against the bundled [official Postman v2.1 schema](postman/schema/collection-v2.1.0.json) using its Draft 4 dialect offline. Schema source: https://schema.getpostman.com/json/collection/v2.1.0/collection.json. `test:postman` validates before executing and sets a forty-second request timeout. Standard Newman arguments pass through npm:

```sh
npm run test:postman -- --env-var baseUrl=http://127.0.0.1:3000 --env-var supplierDown=none
```

Postman variables do not change server flags. Configure those separately below.

## Supplier outage and recovery

PowerShell, after starting the local profile:

```powershell
$env:SUPPLIER_A_DOWN = 'true'
$env:SUPPLIER_B_DOWN = 'false'
docker compose --profile local up -d --no-deps api
npm.cmd run test:postman -- --env-var supplierDown=A

$env:SUPPLIER_A_DOWN = 'false'
$env:SUPPLIER_B_DOWN = 'true'
docker compose --profile local up -d --no-deps api
npm.cmd run test:postman -- --env-var supplierDown=B

$env:SUPPLIER_A_DOWN = 'false'
$env:SUPPLIER_B_DOWN = 'false'
docker compose --profile local up -d --no-deps api
npm.cmd run test:postman -- --env-var supplierDown=none
```

Each `up` recreates the API when flags change; the worker keeps calling it over HTTP. The failed supplier and valid hotel searches return 503. Full health identifies the failed supplier; readiness/liveness stay 200. Allow a few seconds for initialization after recreation. Always restore both flags after a demonstration.

For POSIX shells:

```sh
SUPPLIER_A_DOWN=true SUPPLIER_B_DOWN=false docker compose --profile local up -d --no-deps api
npm run test:postman -- --env-var supplierDown=A
SUPPLIER_A_DOWN=false SUPPLIER_B_DOWN=true docker compose --profile local up -d --no-deps api
npm run test:postman -- --env-var supplierDown=B
SUPPLIER_A_DOWN=false SUPPLIER_B_DOWN=false docker compose --profile local up -d --no-deps api
npm run test:postman -- --env-var supplierDown=none
```

Availability is configured at startup, with no public control endpoint.

## Configuration

Settings are validated once at startup. Docker supplies service URLs. Host processes can copy `.env.example` to `.env`; process environment values take precedence over the file. Do not commit credentials or `.env`.

| Variable              | Default / purpose                                  |
| --------------------- | -------------------------------------------------- |
| `PORT`                | `3000`, HTTP listener                              |
| `NODE_ENV`            | `development`; Docker uses `production`            |
| `LOG_LEVEL`           | `info`; `debug`, `info`, `warn`, `error` supported |
| `APP_MODE`            | `api`; also `worker` and combined `demo`           |
| `TEMPORAL_ADDRESS`    | `127.0.0.1:7233`                                   |
| `TEMPORAL_NAMESPACE`  | `default`                                          |
| `TEMPORAL_TASK_QUEUE` | `hotel-offers`; API and worker must match          |
| `TEMPORAL_CLI_PATH`   | `temporal`, for combined demo                      |
| `REDIS_URL`           | `redis://127.0.0.1:6379`; also `rediss://`         |
| `SUPPLIER_A_URL`      | `http://127.0.0.1:<PORT>/supplierA/hotels`         |
| `SUPPLIER_B_URL`      | `http://127.0.0.1:<PORT>/supplierB/hotels`         |
| `SUPPLIER_A_DOWN`     | `false`; `true` disables mock Supplier A           |
| `SUPPLIER_B_DOWN`     | `false`; `true` disables mock Supplier B           |
| `ENABLE_INFRA_PROBE`  | `false`; Compose enables the local diagnostic      |

Docker workers use `http://api:3000` supplier URLs. Host workers must use loopback URLs. Keep the diagnostic disabled for public deployments.

## Host development and built-server startup

Use Node 22 in both terminals. Stop the full local deployment to free the API port and avoid sharing a task queue with another worker, then start only infrastructure:

```sh
docker compose --profile local down
docker compose --profile local up --build --wait temporal redis
npm ci
npm run build
```

Copy `.env.example` to `.env` (`Copy-Item .env.example .env` in PowerShell, `cp .env.example .env` in POSIX). Retain loopback Temporal/Redis addresses and supplier defaults. Build before starting the worker because it reads `dist/workflow-bundle.js`.

PowerShell terminal 1 (API):

```powershell
$env:APP_MODE = 'api'
npm.cmd start
```

PowerShell terminal 2 (worker, same checkout):

```powershell
$env:APP_MODE = 'worker'
npm.cmd start
```

For POSIX shells use `APP_MODE=api npm start` and `APP_MODE=worker npm start`. After the worker heartbeat appears, `/health` and the collection pass. For development, replace terminal 1's `npm start` with `npm run dev`; retain the built worker in terminal 2. Rebuild/restart the worker after workflow/activity changes. The development command watches TypeScript API source.

Stop both Node processes with Ctrl+C before returning to Docker:

```sh
docker compose --profile local down
docker compose --profile local up --build --wait
```

The optional combined assessment demo uses the same image and Redis with Temporal/API/worker in one application container. Profiles are mutually exclusive; switching resets ephemeral state:

```sh
docker compose --profile local down
docker compose --profile demo up --build --wait
```

Use the same API/Postman commands. Outage commands for this profile recreate `demo` in place of `api`. To return:

```sh
docker compose --profile demo down
docker compose --profile local up --build --wait
```

## Workspace-only regression tests

README is an explicit exception to the Markdown exclusion. Other planning documents and `tests/` remain excluded from Git by project policy. Clean-checkout verification uses the shipped collection and static/build commands above; production builds do not depend on workspace tests.

In the maintainer workspace only:

```sh
npm test
npm run test:infra
npm run test:hotels
npm run test:reliability
```

Build first and run the local Docker profile for integration checks. `test:infra` checks real probe workflows. `test:hotels` verifies Temporal histories, Redis persistence/expiry, filtering, concurrency, and retry-safe writes; it accepts `HOTELS_BASE_URL`, `TEST_REDIS_URL`, `TEST_TEMPORAL_ADDRESS`, and `TEST_TEMPORAL_NAMESPACE` overrides. `test:reliability` injects failures using private temporary containers and an isolated task queue, stops/restarts infrastructure, and restores the normal stack. On Windows it expects the workspace Compose executable or a `TEST_COMPOSE_PATH` override. Unit tests cover bounded HTTP deadlines with fake clocks.

## Troubleshooting and shutdown

| Symptom                            | Check / action                                                                                                                     |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Docker cannot connect              | Start Docker Desktop/Engine; verify `docker info` and Linux containers                                                             |
| Port already allocated             | Stop other API/Redis/Temporal processes or alternate Compose profile                                                               |
| Readiness is 503                   | Inspect `docker compose ps`, `docker compose logs api worker temporal redis`, and `/health/ready`; check namespace/queue agreement |
| Readiness 200, full health 503     | Inspect supplier checks, reset both outage flags and recreate API; check supplier URLs                                             |
| Postman mode fails                 | Match `supplierDown=none/A/B` to server flags, wait for initialization, check `baseUrl`                                            |
| Worker cannot find bundle          | Run `npm run build` before host worker startup                                                                                     |
| Host worker cannot reach suppliers | Use loopback URLs and run API on the matching `PORT`                                                                               |
| Search 503 after dependency outage | Restore Redis/Temporal, restart API/worker if they exited, retry a fresh search                                                    |
| Build/download fails               | Check internet access, Docker logs, and pinned artifact availability; retain checksum verification                                 |

Use request/workflow IDs in logs to diagnose searches. Do not publish environment secrets or entire environment dumps. The enabled `GET /internal/probe` returns `{ "workflowId": "infra-...", "redis": "ok" }` after a real workflow writes, queries, and removes a temporary Redis key.

Stop the active local profile:

```sh
docker compose --profile local down
```

For the combined profile use `docker compose --profile demo down`. Temporal development-server history and Redis contents are ephemeral, including across container recreation. This is an assessment demo with no production durability claim. Public cloud hosting, external cron, and paid resources are outside the submission scope.
