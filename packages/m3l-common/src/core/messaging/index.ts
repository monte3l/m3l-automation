/**
 * `core/messaging` — an abstract messaging interface for sending plain
 * messages, templated reports, and error notifications through a uniform
 * `M3LMessenger` facade, without binding to any specific transport.
 *
 * Re-exports all public symbols from the implementation modules.
 * No logic lives here; this file is a barrel only.
 *
 * @packageDocumentation
 */

export * from "./M3LMessenger.js";
export * from "./types.js";
