# Hotel Offer Orchestrator

Compare two mock hotel suppliers using TypeScript, Express, Temporal, and Redis. Each hotel search returns the cheapest offer per normalized hotel name, with inclusive price filtering performed in Redis.

Repository: https://github.com/nishantnsut27/hotel-offer-orchestrator

Live assessment demo: [service](https://hotelapi.nishantraj.me), [health](https://hotelapi.nishantraj.me/health), and [filtered hotel search](https://hotelapi.nishantraj.me/api/hotels?city=delhi&minPrice=5000&maxPrice=6000). Caddy manages the HTTPS certificate and redirects HTTP to HTTPS. Availability depends on the credit-funded EC2 instance remaining active.

## Docker quickstart

Prerequisites: Git and a running Docker Engine with Docker Compose v2 (`--wait` support), Linux containers, and internet access for pinned image/package downloads. On Windows, use Docker Desktop with its WSL 2 backend. Host ports 4000, 6379, and 7233 must be available. Node.js 22 LTS (22.13 or newer within 22.x) and npm are needed for CLI verification and host development, but Docker builds include Node.

From a clean checkout:

```sh
git clone https://github.com/nishantnsut27/hotel-offer-orchestrator.git
cd hotel-offer-orchestrator
docker compose --profile local up --build --wait
docker compose ps
curl "http://localhost:4000/health"
curl "http://localhost:4000/api/hotels?city=delhi&minPrice=5000&maxPrice=6000"
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

Import [the collection](postman/hotel-offer-orchestrator.postman_collection.json) into Postman. Its collection variables are `baseUrl=http://localhost:4000` and `supplierDown=none`. Run the entire collection with a 40000 ms request timeout. During an outage set `supplierDown` to `A` or `B` to match the server; mode/configuration mismatches fail assertions.

The 75 requests assert request IDs, JSON shapes, exact fixture fields/values/order, Delhi/Mumbai winners, the Oberoi tie, supplier-exclusive hotels, normalized/unknown cities, inclusive/open/equal/zero/fractional/scientific/empty ranges, invalid queries, service index, unknown routes, and all three health endpoints. The complete collection must pass in each correctly configured mode.

Newman 6.2.3 runs the CLI checks. Ajv 6.15.0 validates against the bundled [official Postman v2.1 schema](postman/schema/collection-v2.1.0.json) using its Draft 4 dialect offline. Schema source: https://schema.getpostman.com/json/collection/v2.1.0/collection.json. `test:postman` validates before executing and sets a forty-second request timeout. Standard Newman arguments pass through npm:

```sh
npm run test:postman -- --env-var baseUrl=http://127.0.0.1:4000 --env-var supplierDown=none
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
| `PORT`                | `4000`, HTTP listener                              |
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

Docker workers use `http://api:4000` supplier URLs. Host workers must use loopback URLs. Keep the diagnostic disabled for public deployments.

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

For the combined profile use `docker compose --profile demo down`. Temporal development-server history and Redis contents are ephemeral, including across container recreation. This is an assessment demo with no production durability claim. Public cloud hosting is optional for the assessment; the EC2 guide below is provided for an owner-managed demo. External cron is not required.

## Optional public deployment on AWS EC2

`compose.ec2.yaml` runs the existing combined demo (API, worker, and loopback-only Temporal) plus a private Redis container. Only HTTP is published, on host port 80 by default. Redis and Temporal have no published host ports, the infrastructure diagnostic is disabled, logs rotate, and both containers restart after a Docker/host restart. The Compose project has a separate name from the local deployment.

The configuration was verified locally and deployed on 2026-11-22 to an owner-created `t3.small` instance running Ubuntu 24.04 in Sydney (`ap-southeast-2`). A clean Docker build, real Temporal/Redis hotel searches, public health checks, and the full healthy Postman collection passed: 75 requests, 302 assertions, zero failures. This verifies the assessment demo, not sustained production capacity. The repository does not provision AWS resources.

### Choose a hosting option

Provider information checked on 2026-11-22:

| Option                                      | Fit for this application                                  | Cost / limitation                                                                                                                                                                                                                      |
| ------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS EC2 with your new-account credits       | Recommended for this demo; runs the complete Docker stack | New accounts receive $100 initially and can earn more. Free-plan access ends after six months or when credits run out, whichever comes first. A paid-plan account can incur charges after credits.                                     |
| Render Free web service plus Free Key Value | A possible experiment, not a verified deployment target   | Free web compute has 512 MB RAM and sleeps after 15 minutes without inbound traffic. API, worker, and Temporal would share that memory; this configuration has not been tested under that limit. Free Key Value loses data on restart. |
| Local Docker with a temporary public tunnel | Useful for a short demonstration                          | Your computer and Docker must remain running; tunnel availability and limits depend on the provider.                                                                                                                                   |

Sources: [AWS Free Tier](https://aws.amazon.com/free/), [AWS account plans](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier-plans.html), [Render Free](https://render.com/docs/free), and [Render pricing](https://render.com/pricing). Credits are shared with your other AWS project. In AWS Billing, check **account plan**, **remaining credits**, and **credit expiry** before launching anything. Instance compute, EBS storage, public IPv4, and data transfer can consume credits. Do not upgrade the account plan just to follow this guide.

### 1. Launch a separate EC2 demo instance

Use a separate instance to leave an existing deployment untouched. In the EC2 console, choose **Launch instance**:

- Name: `hotel-offer-orchestrator`.
- AMI: official Ubuntu Server 24.04 LTS, **64-bit x86**.
- Instance: start with `t3.small` (2 vCPU, 2 GiB RAM) if your account plan allows it. This is a practical starting size, not a measured AWS capacity guarantee. Avoid ARM/Graviton instances (`t4g`): the current Dockerfile downloads an amd64 Temporal CLI. Confirm the console's estimate and credit eligibility.
- Key pair: create/download a `.pem` key and keep it private.
- Storage: 20 GiB gp3, with **Delete on termination** enabled for this demo.
- Network: a public subnet with internet access and a public IPv4 address.
- Security group: SSH/TCP 22 from **My IP** only; HTTP/TCP 80 from `0.0.0.0/0` for a public demo. Do not add inbound rules for 6379, 7233, or 4000. No load balancer, NAT gateway, or Elastic IP is needed for this direct-IP demo.

If you reuse an existing instance, first confirm sufficient free memory/disk and available ports. Run this stack in its own checkout with `HTTP_PORT=8080` if port 80 is already occupied, and allow only that HTTP port in its security group. Do not stop, replace, or modify the other application's containers.

### 2. Connect to Ubuntu

Use EC2 **Connect** for the connection command. From PowerShell, replace the placeholders:

```powershell
ssh -i "C:\path\hotel-demo.pem" ubuntu@YOUR_EC2_PUBLIC_IP
```

The remaining installation/deployment commands run in the Ubuntu SSH session. On an existing server with Docker Engine and Compose v2 already installed, skip the installation block and check their versions instead.

### 3. Install Docker Engine and Compose v2

For a fresh Ubuntu 24.04 instance, use the [official Docker Apt repository](https://docs.docker.com/engine/install/ubuntu/):

```sh
sudo apt update
sudo apt install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources > /dev/null <<'EOF'
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker version
sudo docker compose version
```

No host Node.js installation, npm installation, or `.env` file is needed for the Docker deployment.

### 4. Clone and start the application

```sh
git clone https://github.com/nishantnsut27/hotel-offer-orchestrator.git
cd hotel-offer-orchestrator
sudo docker compose -f compose.ec2.yaml up --build --wait --wait-timeout 180
sudo docker compose -f compose.ec2.yaml ps
curl --fail http://127.0.0.1/health
curl --fail "http://127.0.0.1/api/hotels?city=delhi&minPrice=5000&maxPrice=6000"
```

Expected health: HTTP 200, with API, worker, Temporal, Redis, and both suppliers `up`. The hotel response contains Holtin at 5340 from Supplier B and Radison at 5900 from Supplier A. Closing SSH does not stop the containers.

For an existing instance using port 8080, prefix every Compose command with `HTTP_PORT=8080`, for example:

```sh
sudo HTTP_PORT=8080 docker compose -f compose.ec2.yaml up --build --wait --wait-timeout 180
curl --fail http://127.0.0.1:8080/health
```

Keep that port setting consistent for later updates; alternatively put `HTTP_PORT=8080` in a private `.env` in this checkout. `HTTP_BIND_ADDRESS` defaults to `0.0.0.0`; set it to `127.0.0.1` when an existing reverse proxy on the same host handles public traffic.

### 5. Verify the public API and Postman collection

Open `http://YOUR_EC2_PUBLIC_IP/health` and `http://YOUR_EC2_PUBLIC_IP/api/hotels?city=delhi` from your computer. Add `:8080` when using that port. If local curl succeeds but the public URL does not, check the security group, public IP, subnet routing, and host firewall.

In Postman, import `postman/hotel-offer-orchestrator.postman_collection.json`, set `baseUrl` to `http://YOUR_EC2_PUBLIC_IP` (or the port-8080 URL), set `supplierDown=none`, and run the collection. The healthy run should pass 75 requests and 302 assertions. `GET /internal/probe` must return 404 on this public configuration.

The base configuration uses HTTP. The optional HTTPS overlay below adds Caddy, automatic certificates, and HTTP redirects for a domain you control.

### 6. Update, troubleshoot, and remove the demo

```sh
git pull --ff-only
sudo docker compose -f compose.ec2.yaml up --build --wait --wait-timeout 180
sudo docker compose -f compose.ec2.yaml logs --tail 100 app redis
```

If a build or startup fails, inspect logs before changing anything. A small VM can run out of memory or disk; use `free -h` and `df -h` to diagnose. Do not publish logs containing credentials.

To stop only this application:

```sh
sudo docker compose -f compose.ec2.yaml down
```

Stopping containers does not stop EC2 billing. When the demonstration is over, terminate this project's dedicated EC2 instance in the AWS console and review any remaining EBS volumes, snapshots, or public-IP allocations. Leave your other project's resources alone. A stopped instance can still incur storage charges, and its public IP can change when started again. Temporal history and Redis offers are ephemeral; this remains an assessment demo.

## HTTPS with your own domain

`compose.ec2.https.yaml` adds pinned Caddy 2.11.9 to the EC2 deployment. Caddy owns public ports 80 and 443, redirects HTTP to the configured hostname, and proxies HTTPS to `app:4000` on the private Docker network. The overlay removes the application's host port mapping using Compose's `!reset` merge tag. Redis and Temporal remain private. Caddy stores certificate/account data in named volumes and automatically renews certificates; no certificate renewal cron is required.

Verified on 2026-11-22 at `https://hotelapi.nishantraj.me`: trusted Let's Encrypt certificate, full component health, correct hotel search, HTTP redirects, and 75 Postman requests / 302 assertions / zero failures. The certificate was retained after restarting Caddy.

Use Docker Compose 2.24.4 or newer. DNS and security-group changes happen in your provider accounts; the repository supplies the proxy configuration.

1. Point an **A record** for your chosen hostname to the EC2 public IPv4 address. For this demo, Namecheap **Domain List → Manage → Advanced DNS → Host Records** contains `A Record`, host `hotelapi`, value `13.236.95.4`, TTL `Automatic`, yielding `hotelapi.nishantraj.me`. Retain the domain's other records.
2. Allow inbound **HTTP/TCP 80** and **HTTPS/TCP 443** in this instance's security group. Port 80 handles certificate validation and HTTP redirects. Keep SSH restricted to your IP.
3. Create or edit the private `.env` file in the deployment checkout, preserving any existing settings, and add:

   ```dotenv
   PUBLIC_HOSTNAME=hotelapi.nishantraj.me
   ```

4. Start both Compose files together:

   ```sh
   sudo docker compose -f compose.ec2.yaml -f compose.ec2.https.yaml up --build --wait --wait-timeout 180
   sudo docker compose -f compose.ec2.yaml -f compose.ec2.https.yaml logs --tail 50 caddy
   curl --fail https://hotelapi.nishantraj.me/health
   curl --fail "https://hotelapi.nishantraj.me/api/hotels?city=delhi&minPrice=5000&maxPrice=6000"
   ```

   Certificate issuance can take a short time after container startup. Verify normal certificate validation without curl's `--insecure` option. If issuance fails, inspect Caddy logs and check public DNS, both inbound ports, any stale IPv6 record, and restrictive CAA records.

5. Set Postman's `baseUrl` to `https://hotelapi.nishantraj.me` and `supplierDown=none`; run the complete collection.

Use **both Compose files** for subsequent updates, restarts, and shutdown:

```sh
git pull --ff-only
sudo docker compose -f compose.ec2.yaml -f compose.ec2.https.yaml up --build --wait --wait-timeout 180
sudo docker compose -f compose.ec2.yaml -f compose.ec2.https.yaml ps
```

To stop this deployment, use `sudo docker compose -f compose.ec2.yaml -f compose.ec2.https.yaml down`. Retain the Caddy volumes so certificate/account data survives container recreation. Starting only the base file while Caddy occupies port 80 causes a port conflict. If EC2 assigns a new public IP after a stop/start, update the hostname's A record before expecting HTTPS to work.

References: [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https), [Caddy Docker deployment](https://caddyserver.com/docs/running#docker-compose), and [Compose merge/reset behavior](https://docs.docker.com/reference/compose-file/merge/).
