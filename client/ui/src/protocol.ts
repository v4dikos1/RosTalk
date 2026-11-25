// Typed access to the generated control-plane bindings (proto/rostalk/v1).
//
// Never edit the files under src/proto by hand: they are produced by
// `make gen` from the .proto sources, which are the single source of truth
// (CONTRIBUTING.md). The UI never opens a socket itself; stage 2.2 puts the
// connection into the Rust core and the UI talks to it through IPC.
export * as admin from "./proto/rostalk/v1/admin_pb";
export * as channels from "./proto/rostalk/v1/channels_pb";
export * as error from "./proto/rostalk/v1/error_pb";
export * as events from "./proto/rostalk/v1/events_pb";
export * as handshake from "./proto/rostalk/v1/handshake_pb";
export * as protocol from "./proto/rostalk/v1/protocol_pb";
export * as state from "./proto/rostalk/v1/state_pb";

// Wire protocol version implemented by this client. Must match
// Hello.protocol_version and ServerInfo.protocol_version (see
// proto/rostalk/v1/protocol.proto).
export const PROTOCOL_VERSION = 1;
