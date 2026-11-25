package control

import (
	"context"
	"errors"

	rostalkv1 "github.com/v4dikos1/RosTalk/proto/gen/go/rostalk/v1"

	"github.com/v4dikos1/RosTalk/server/internal/chat"
	"github.com/v4dikos1/RosTalk/server/internal/state"
)

// chatConversation maps a wire target to a conversation. Exactly one target is
// set by the oneof; zero ids are rejected instead of silently meaning "no
// conversation".
func chatConversation(target *rostalkv1.ChatTarget) (chat.Conversation, bool) {
	switch value := target.GetTarget().(type) {
	case *rostalkv1.ChatTarget_ChannelId:
		if value.ChannelId == 0 {
			return chat.Conversation{}, false
		}
		return chat.Conversation{ChannelID: value.ChannelId}, true
	case *rostalkv1.ChatTarget_PeerUserId:
		if value.PeerUserId == 0 {
			return chat.Conversation{}, false
		}
		return chat.Conversation{PeerID: int64(value.PeerUserId)}, true
	default:
		return chat.Conversation{}, false
	}
}

func (p *Plane) handleSendMessage(ctx context.Context, session *state.Session, requestID uint64, req *rostalkv1.ChatSend) {
	conversation, ok := chatConversation(req.GetTarget())
	if !ok {
		p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_INVALID_REQUEST,
			"the message target must be a channel or a user")
		return
	}
	message, err := p.chat.Send(ctx, session.UserID(), conversation, req.GetBody(), req.GetAttachmentIds())
	if err != nil {
		p.replyChatError(session, requestID, err)
		return
	}
	p.send(session, &rostalkv1.ServerFrame{
		ReplyTo: requestID,
		Payload: &rostalkv1.ServerFrame_Message{Message: message.Proto()},
	})
}

func (p *Plane) handleEditMessage(ctx context.Context, session *state.Session, requestID uint64, req *rostalkv1.EditMessage) {
	if req.GetMessageId() == 0 {
		p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_INVALID_REQUEST,
			"message_id must not be zero")
		return
	}
	message, err := p.chat.Edit(ctx, session.UserID(), int64(req.GetMessageId()), req.GetBody())
	if err != nil {
		p.replyChatError(session, requestID, err)
		return
	}
	p.send(session, &rostalkv1.ServerFrame{
		ReplyTo: requestID,
		Payload: &rostalkv1.ServerFrame_Message{Message: message.Proto()},
	})
}

func (p *Plane) handleDeleteMessage(ctx context.Context, session *state.Session, requestID uint64, req *rostalkv1.DeleteMessage) {
	if req.GetMessageId() == 0 {
		p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_INVALID_REQUEST,
			"message_id must not be zero")
		return
	}
	if err := p.chat.Delete(ctx, session.UserID(), int64(req.GetMessageId())); err != nil {
		p.replyChatError(session, requestID, err)
		return
	}
	p.replyAck(session, requestID)
}

func (p *Plane) handleChatHistory(ctx context.Context, session *state.Session, requestID uint64, req *rostalkv1.ChatHistoryRequest) {
	conversation, ok := chatConversation(req.GetTarget())
	if !ok {
		p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_INVALID_REQUEST,
			"the history target must be a channel or a user")
		return
	}
	messages, next, hasMore, err := p.chat.History(ctx, session.UserID(), conversation, req.GetCursor(), req.GetLimit())
	if err != nil {
		p.replyChatError(session, requestID, err)
		return
	}
	proto := make([]*rostalkv1.Message, 0, len(messages))
	for _, message := range messages {
		proto = append(proto, message.Proto())
	}
	p.send(session, &rostalkv1.ServerFrame{
		ReplyTo: requestID,
		Payload: &rostalkv1.ServerFrame_ChatHistory{ChatHistory: &rostalkv1.ChatHistoryPage{
			Messages:   proto,
			NextCursor: next,
			HasMore:    hasMore,
		}},
	})
}

func (p *Plane) handleMarkRead(ctx context.Context, session *state.Session, requestID uint64, req *rostalkv1.MarkRead) {
	conversation, ok := chatConversation(req.GetTarget())
	if !ok {
		p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_INVALID_REQUEST,
			"the read target must be a channel or a user")
		return
	}
	if _, err := p.chat.MarkRead(ctx, session.UserID(), conversation, req.GetUpToMessageId()); err != nil {
		p.replyChatError(session, requestID, err)
		return
	}
	p.replyAck(session, requestID)
}

func (p *Plane) replyChatError(session *state.Session, requestID uint64, err error) {
	switch {
	case errors.Is(err, chat.ErrNotFound), errors.Is(err, chat.ErrInvalidTarget):
		p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_NOT_FOUND,
			"the message or conversation does not exist")
	case errors.Is(err, chat.ErrPermissionDenied):
		p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_PERMISSION_DENIED,
			"you may not do that here")
	case errors.Is(err, chat.ErrRateLimited):
		p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_RATE_LIMITED,
			"you are sending messages too quickly")
	case errors.Is(err, chat.ErrEmptyBody), errors.Is(err, chat.ErrBodyTooLong),
		errors.Is(err, chat.ErrTooManyAttachments), errors.Is(err, chat.ErrAttachmentInvalid),
		errors.Is(err, chat.ErrInvalidCursor):
		p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_INVALID_REQUEST, err.Error())
	default:
		p.logger.Error("chat request failed", "error", err)
		p.replyError(session, requestID, rostalkv1.ErrorCode_ERROR_CODE_INTERNAL,
			"the message could not be processed")
	}
}
