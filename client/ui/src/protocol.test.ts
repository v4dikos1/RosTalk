import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";

import { PROTOCOL_VERSION } from "./protocol";
import { SetNicknameSchema } from "./proto/rostalk/v1/channels_pb";
import { EventSchema, UserMovedSchema } from "./proto/rostalk/v1/events_pb";
import { HelloSchema } from "./proto/rostalk/v1/handshake_pb";
import {
  AckSchema,
  ClientFrameSchema,
  ServerFrameSchema,
} from "./proto/rostalk/v1/protocol_pb";

// Contract smoke test: the generated TypeScript bindings must encode and decode
// the frames the server speaks. It also pins the oneof shape, which is easy to
// break when regenerating with a different protobuf-es version.
describe("control-plane contract", () => {
  it("round-trips a Hello client frame", () => {
    const frame = create(ClientFrameSchema, {
      requestId: 42n,
      payload: {
        case: "hello",
        value: create(HelloSchema, {
          protocolVersion: PROTOCOL_VERSION,
          clientVersion: "test",
          publicKey: new Uint8Array(32),
          nickname: "tester",
          invite: "",
        }),
      },
    });

    const decoded = fromBinary(ClientFrameSchema, toBinary(ClientFrameSchema, frame));

    expect(decoded.requestId).toBe(42n);
    expect(decoded.payload?.case).toBe("hello");
    if (decoded.payload?.case !== "hello") {
      throw new Error("unexpected payload variant");
    }
    expect(decoded.payload.value.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(decoded.payload.value.nickname).toBe("tester");
  });

  it("keeps events reply-free and typed", () => {
    const serverFrame = create(ServerFrameSchema, {
      replyTo: 0n,
      payload: {
        case: "event",
        value: create(EventSchema, {
          payload: {
            case: "userMoved",
            value: create(UserMovedSchema, {
              userId: 7n,
              fromChannelId: 1n,
              toChannelId: 2n,
            }),
          },
        }),
      },
    });

    const decoded = fromBinary(
      ServerFrameSchema,
      toBinary(ServerFrameSchema, serverFrame),
    );

    expect(decoded.replyTo).toBe(0n);
    expect(decoded.payload?.case).toBe("event");
    if (decoded.payload?.case !== "event") {
      throw new Error("unexpected payload variant");
    }
    const event = decoded.payload.value.payload;
    expect(event?.case).toBe("userMoved");
    if (event?.case !== "userMoved") {
      throw new Error("unexpected event variant");
    }
    expect(event.value.toChannelId).toBe(2n);
  });

  it("round-trips a nickname change and its ack", () => {
    const request = create(ClientFrameSchema, {
      requestId: 9n,
      payload: {
        case: "setNickname",
        value: create(SetNicknameSchema, { nickname: "new name" }),
      },
    });
    const ack = create(ServerFrameSchema, {
      replyTo: 9n,
      payload: { case: "ack", value: create(AckSchema) },
    });

    const decodedRequest = fromBinary(
      ClientFrameSchema,
      toBinary(ClientFrameSchema, request),
    );
    const decodedAck = fromBinary(
      ServerFrameSchema,
      toBinary(ServerFrameSchema, ack),
    );

    expect(decodedRequest.payload?.case).toBe("setNickname");
    if (decodedRequest.payload?.case !== "setNickname") {
      throw new Error("unexpected payload variant");
    }
    expect(decodedRequest.payload.value.nickname).toBe("new name");
    expect(decodedAck.replyTo).toBe(9n);
    expect(decodedAck.payload?.case).toBe("ack");
  });
});
