# @saw/relay

The SAW relay is one small service. It carries typed JSON messages and git
refs between two members. It stores the work log. It answers activity
queries when a peer is offline. It does not carry code, file contents, or
commands. The boundary rules reject everything else.

You can host the relay yourself on any small machine that runs Node. There
are no hosted-only features (constitution, Principle VII).

## What the relay stores

One SQLite file. It holds workspaces, members, invites, messages, the work
log, boundary rejections, claims, and pause state. Keep this file safe. The
member credentials in it are stored as SHA-256 hashes, not as plain text.

## Run with Node

You need Node.js 20 or newer.

```sh
# From the repository root:
npm ci
npm run dev --workspace @saw/relay
```

The relay listens on port 8787 and writes `saw-relay.db` in the working
directory. Two environment variables change that:

| Variable         | Default        | Meaning                        |
| ---------------- | -------------- | ------------------------------ |
| `SAW_RELAY_PORT` | `8787`         | TCP port to listen on          |
| `SAW_RELAY_DB`   | `saw-relay.db` | Path of the SQLite database    |

## Run with Docker

Build from the repository root. The build needs the root manifest because
the relay uses the workspace package `@saw/shared`.

```sh
docker build -f packages/relay/Dockerfile -t saw-relay .
```

Run it with a volume, so the database survives restarts:

```sh
docker run -d --name saw-relay -p 8787:8787 -v saw-relay-data:/data saw-relay
```

The image sets `SAW_RELAY_DB=/data/saw-relay.db`. Pass `-e` flags to change
the port or the database path.

Check that it is up:

```sh
curl http://localhost:8787/
```

The relay answers with its route list.

## Point the CLI at your relay

The default relay URL is `ws://localhost:8787`. Pass your own URL when you
create or join a workspace:

```sh
saw init --relay ws://your-host:8787
saw join <invite-token> --relay ws://your-host:8787
```

`saw` writes the URL to `.saw/config.json`. After that, every command uses
it.

## Security notes

- The relay binds `0.0.0.0`, so other machines can reach it. Put it behind
  TLS (for example, a reverse proxy that terminates `wss://`) before you
  expose it to the internet.
- Every workspace action needs a bearer token. The relay compares the
  SHA-256 hash of the token with the stored hash. A database leak does not
  leak usable credentials.
- The boundary rules run on every frame. A payload that carries code, file
  contents, or smuggled content is rejected or scrubbed, and each removal
  is logged as a boundary rejection.
