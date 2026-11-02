# dotcom

## Development

You'll need a clerk publishable and secret key.

In `sync-worker/.dev.vars`, set `CLERK_PUBLISHABLE_KEY` & `CLERK_SECRET_KEY`. In `client/.env.local`, set `VITE_CLERK_PUBLISHABLE_KEY`.

### Running without Clerk

`pnpm dev-app:local` runs the same stack signed in as one fixed local user (`dev@localhost`), with no Clerk keys. It sets `LOCAL_DEV_AUTH=1` for the sync worker and `VITE_LOCAL_DEV_AUTH=1` for the client; set them yourself to combine with other options. The client swaps `@clerk/clerk-react` for [a shim](client/src/localDevAuth/clerkShim.tsx) and the worker accepts its fixed token in place of a Clerk session. Every permission check still runs against that user. The worker honours the flag only under `wrangler dev`, and `vite build` ignores it.

Sign-in, sign-out (it just reloads), signed-out pages, the admin pages, and the MCP OAuth flow need Clerk and don't work in this mode.

The dev stack is orchestrated by [process-compose](https://github.com/F1bonacc1/process-compose). You don't need to install it — `pnpm dev-app` fetches the pinned binary on first use. Run the app from the repo root:

```bash
pnpm dev-app
```

This brings up the whole stack — postgres and pgbouncer (in containers), zero-cache, the workers, and the client — as host processes. The ports are fixed, so only one dotcom dev stack can run at a time. The services and their startup order are defined in [`process-compose.yaml`](process-compose.yaml).

### Working with the stack

By default `pnpm dev-app` opens the process-compose TUI, listing each service with its status, logs, and health.

- **Quit:** `F10` or `Ctrl-C`. This stops every process and runs postgres's `docker compose down` — the clean way to stop. Closing the terminal tab instead can leave the postgres container and stray workers running.
- **Inspect a service:** select it with the arrow keys to see its logs; press `F1` for the full key bindings (start / stop / restart a selected process).
- **Plain interleaved logs, no TUI:** `PC_DISABLE_TUI=1 pnpm dev-app` streams every service's logs to stdout (this is also how it runs in CI).
- **Drive it from another terminal or a script** — the `process-compose` client connects to the running stack:

  ```bash
  pnpm dev-app:doctor                                       # status of every service
  pnpm exec process-compose process logs zero-cache --tail 200
  pnpm exec process-compose process restart sync-worker
  ```

- **Reset server state:** `pnpm dev-app:clean` tears down the postgres container + volume, the zero replica, and wrangler state.

Browser-side state is separate. After starting the stack, visit `http://localhost:3000/dev/reset-local-state` to clear local storage, IndexedDB, caches, service workers, accessible cookies, and Clerk session state for the current origin.
