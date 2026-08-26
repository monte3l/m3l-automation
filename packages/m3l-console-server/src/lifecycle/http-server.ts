/**
 * `lifecycle/http-server` — the console server's `node:http` boot-and-close
 * lifecycle, and the module the whole ADR-0071 loopback-only posture rests
 * on.
 *
 * `listen()` alone does not guarantee a loopback bind: the host string
 * `main.ts` passes in is a *request*, and Node resolves it independently
 * (`localhost` does not even resolve to the address you might expect — see
 * the table below). This module never trusts the request; it re-derives the
 * bound host from `server.address()` after `listening` fires and rejects
 * anything that is not a verified loopback `AddressInfo`, closing the
 * socket first so a rejected start never leaves a live listener behind.
 *
 * Measured on Node v26.7.0, against a real listener:
 *
 * | `listen` host      | `address().address` | verdict |
 * | ------------------- | -------------------- | ------- |
 * | `127.0.0.1`          | `127.0.0.1`           | accept  |
 * | `localhost`          | `::1`                 | accept  |
 * | `::1`                | `::1`                 | accept  |
 * | `0.0.0.0`            | `0.0.0.0`             | REJECT  |
 * | `::`                 | `::`                  | REJECT  |
 * | *(host omitted)*     | `::`                  | REJECT  |
 *
 * Two consequences worth stating explicitly: `localhost` binds to the IPv6
 * loopback address `::1`, **not** `127.0.0.1` — rejecting the IPv6 loopback
 * form here would break the single most natural config value an operator
 * would type. And omitting the host binds `::` (every interface on the
 * host), which is the likeliest way to accidentally expose the console to
 * the network — exactly the failure mode this module exists to catch.
 *
 * @packageDocumentation
 */
import { createServer as createHttpServer } from "node:http";
import type { RequestListener, Server } from "node:http";
import type { AddressInfo } from "node:net";

import { M3LConsoleError } from "../errors/console-error.js";
import { isLoopbackHost } from "../net/loopback.js";

/**
 * A console server that is actually listening: the address it reports is
 * the one it verified against `server.address()`, not the one requested.
 *
 * @example
 * ```ts
 * function logBind(server: M3LListeningServer): string {
 *   return `listening on ${server.host}:${String(server.port)}`;
 * }
 * ```
 */
export interface M3LListeningServer {
  /** The verified loopback host the server actually bound, from `address()`. */
  readonly host: string;
  /** The port the server actually bound. Never `0`, even when `0` was requested. */
  readonly port: number;
  /**
   * Gracefully stops accepting new work and closes the listener.
   * Idempotent — a second call re-returns the same settling promise, and it
   * is safe to call even after a failed {@link startConsoleServer}.
   */
  close(): Promise<void>;
}

/**
 * Constructor options for {@link startConsoleServer}.
 *
 * @example
 * ```ts
 * const options: StartConsoleServerOptions = {
 *   host: "127.0.0.1",
 *   port: 0,
 *   listener: (_req, res) => {
 *     res.writeHead(200);
 *     res.end("ok");
 *   },
 *   closeTimeoutMs: 5_000,
 * };
 * ```
 */
export interface StartConsoleServerOptions {
  /** The host to request binding on. Re-verified against `address()` after bind — see the module doc table. */
  readonly host: string;
  /** The port to request binding on. `0` requests an ephemeral port. */
  readonly port: number;
  /** The `node:http` request handler. Typed as `node:http`'s own `RequestListener`, never a package-specific alias — this module must never depend on `http/`. */
  readonly listener: RequestListener;
  /** The maximum time {@link M3LListeningServer.close} waits for in-flight connections before forcing them closed. */
  readonly closeTimeoutMs: number;
  /** Test seam: builds the underlying `Server` instead of `node:http`'s `createServer`. Defaults to `createServer(listener)`. */
  readonly createServer?: () => Server;
}

/** The host/port pair verified from a real `AddressInfo`, ready to hand back to the caller. */
interface ResolvedListenAddress {
  readonly host: string;
  readonly port: number;
}

/**
 * Narrows `server.address()` to a verified loopback {@link ResolvedListenAddress},
 * or throws `ERR_CONSOLE_LISTEN_FAILED` for every shape the module doc's
 * table marks REJECT: `null` (no address could be determined), a string (a
 * UNIX socket path — this module only supports TCP), or a non-loopback
 * `AddressInfo`.
 */
function resolveLoopbackAddress(
  address: AddressInfo | string | null,
): ResolvedListenAddress {
  if (address === null) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_LISTEN_FAILED",
      "console server's address() returned null after a successful listen() — a bind that cannot be verified as loopback is refused (ADR-0071)",
    );
  }
  if (typeof address === "string") {
    throw new M3LConsoleError(
      "ERR_CONSOLE_LISTEN_FAILED",
      `console server bound a UNIX socket path ("${address}") — the console server only supports TCP loopback binds (ADR-0071)`,
    );
  }
  if (!isLoopbackHost(address.address)) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_LISTEN_FAILED",
      `console server bound to non-loopback address "${address.address}" — refusing to expose the console beyond localhost (ADR-0071)`,
    );
  }
  return { host: address.address, port: address.port };
}

/**
 * Builds the idempotent `close()` for a {@link M3LListeningServer}.
 *
 * `server.close()` only sweeps connections that are ALREADY idle at the
 * instant it is called (measured on Node v26.7.0 — this is not what a
 * plain reading of the docs implies, and re-checked here in a comment
 * because it will otherwise get "simplified" away). A connection that goes
 * idle immediately afterwards — exactly the drain case, where a request is
 * in flight and about to finish — holds the server open indefinitely unless
 * swept again; `closeIdleConnections()` called right after `close()`
 * catches that window. `closeAllConnections()` resets every in-flight
 * request with `ECONNRESET`, so it may only fire once `closeTimeoutMs` has
 * elapsed — calling it eagerly would turn a graceful drain into a kill for
 * every request still being written.
 */
function createCloseOnce(
  server: Server,
  closeTimeoutMs: number,
): () => Promise<void> {
  let closePromise: Promise<void> | undefined;

  return function close(): Promise<void> {
    if (closePromise !== undefined) return closePromise;

    closePromise = new Promise<void>((resolve) => {
      const forceCloseTimer = setTimeout(() => {
        server.closeAllConnections();
      }, closeTimeoutMs);

      server.close(() => {
        clearTimeout(forceCloseTimer);
        resolve();
      });
      server.closeIdleConnections();
    });

    return closePromise;
  };
}

/**
 * Starts the console server's `node:http` listener and resolves once the
 * bind has been verified as loopback-only, per ADR-0071 (see the module doc
 * table for the exact `listen()`-host-to-`address()`-result mapping).
 *
 * @param options - See {@link StartConsoleServerOptions}.
 * @returns A promise resolving to the verified {@link M3LListeningServer}.
 * @throws {@link M3LConsoleError} with code `ERR_CONSOLE_LISTEN_FAILED` when
 *   `listen()` itself fails, or when the server bound to an address that is
 *   not a verified TCP loopback address — in the latter case the server is
 *   closed before the promise rejects, so a rejected start never leaves a
 *   live socket behind.
 *
 * @example
 * ```ts
 * import { M3LError } from "@m3l-automation/m3l-common/core";
 *
 * try {
 *   const server = await startConsoleServer({
 *     host: "127.0.0.1",
 *     port: 0,
 *     listener: (_req, res) => {
 *       res.writeHead(200);
 *       res.end("ok");
 *     },
 *     closeTimeoutMs: 5_000,
 *   });
 *   console.log(`listening on ${server.host}:${String(server.port)}`);
 *   await server.close();
 * } catch (error) {
 *   if (error instanceof M3LError) {
 *     // error.code === "ERR_CONSOLE_LISTEN_FAILED"
 *   }
 * }
 * ```
 */
export function startConsoleServer(
  options: StartConsoleServerOptions,
): Promise<M3LListeningServer> {
  const server = options.createServer?.() ?? createHttpServer(options.listener);

  return new Promise<M3LListeningServer>((resolve, reject) => {
    const cleanup = (): void => {
      server.removeListener("error", onError);
      server.removeListener("listening", onListening);
    };

    function onError(error: Error): void {
      cleanup();
      reject(
        new M3LConsoleError(
          "ERR_CONSOLE_LISTEN_FAILED",
          `console server failed to start listening on ${options.host}:${String(options.port)}`,
          { cause: error },
        ),
      );
    }

    function onListening(): void {
      cleanup();
      try {
        const address = resolveLoopbackAddress(server.address());
        resolve({
          host: address.host,
          port: address.port,
          close: createCloseOnce(server, options.closeTimeoutMs),
        });
      } catch (error) {
        // Assert-then-leak is the exact bug this branch exists to prevent:
        // close the socket before rejecting, and don't wait for the close
        // to settle (nor let a close-time failure shadow this rejection) —
        // the caller must observe the address-validation failure, not
        // whatever happens to `close()` afterward.
        server.close(() => undefined);
        reject(
          error instanceof M3LConsoleError
            ? error
            : new M3LConsoleError(
                "ERR_CONSOLE_LISTEN_FAILED",
                "console server failed address validation after listening",
                { cause: error },
              ),
        );
      }
    }

    server.on("error", onError);
    server.on("listening", onListening);
    server.listen(options.port, options.host);
  });
}
