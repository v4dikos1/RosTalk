//! Generated control-plane protocol types (`proto/rostalk/v1`).
//!
//! `rostalk.v1.rs` is produced by `make gen` (buf + protoc-gen-prost) and must
//! not be edited by hand. This module only wraps the generated file so the rest
//! of the crate has a stable path, `rostalk_core::proto::*`.
//!
//! The file is pulled in with `include!` on purpose: rustfmt does not follow
//! macro includes, so `cargo fmt --check` keeps checking only hand-written Rust
//! while the generated code keeps the exact shape protoc-gen-prost emitted.

#[allow(clippy::all, rustdoc::all)]
mod generated {
    include!("rostalk.v1.rs");
}

pub use generated::*;

#[cfg(test)]
mod tests {
    use prost::Message;

    use super::*;

    #[test]
    fn hello_frame_round_trips() {
        let frame = ClientFrame {
            request_id: 7,
            payload: Some(client_frame::Payload::Hello(Hello {
                protocol_version: crate::PROTOCOL_VERSION,
                client_version: "test".to_owned(),
                public_key: vec![0u8; 32],
                nickname: "tester".to_owned(),
                invite: String::new(),
                password: String::new(),
            })),
        };

        let encoded = frame.encode_to_vec();
        let decoded = ClientFrame::decode(encoded.as_slice()).expect("frame decodes");

        assert_eq!(decoded, frame);
    }

    #[test]
    fn nickname_frame_round_trips() {
        let frame = ClientFrame {
            request_id: 9,
            payload: Some(client_frame::Payload::SetNickname(SetNickname {
                nickname: "new name".to_owned(),
            })),
        };

        let encoded = frame.encode_to_vec();
        let decoded = ClientFrame::decode(encoded.as_slice()).expect("frame decodes");

        assert_eq!(decoded, frame);
    }

    #[test]
    fn event_carries_channel_move() {
        let frame = ServerFrame {
            reply_to: 0,
            payload: Some(server_frame::Payload::Event(Event {
                payload: Some(event::Payload::UserMoved(UserMoved {
                    user_id: 7,
                    from_channel_id: 1,
                    to_channel_id: 2,
                })),
            })),
        };

        let decoded =
            ServerFrame::decode(frame.encode_to_vec().as_slice()).expect("server frame decodes");

        let Some(server_frame::Payload::Event(event)) = decoded.payload else {
            panic!("expected an event payload");
        };
        let Some(event::Payload::UserMoved(moved)) = event.payload else {
            panic!("expected a user_moved payload");
        };
        assert_eq!((moved.user_id, moved.to_channel_id), (7, 2));
    }
}
