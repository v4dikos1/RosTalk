package main

import (
	"bytes"
	"strings"
	"testing"

	rostalkv1 "github.com/v4dikos1/RosTalk/proto/gen/go/rostalk/v1"
)

func testWelcome() *rostalkv1.Welcome {
	return &rostalkv1.Welcome{
		SelfUserId: 1,
		Snapshot: &rostalkv1.ServerSnapshot{
			Server: &rostalkv1.ServerInfo{Name: "RosTalk", ProtocolVersion: 1, OnlineUsers: 2},
			Channels: []*rostalkv1.Channel{
				{Id: 1, Name: "Лобби", Position: 0, UserCount: 1},
				{Id: 2, Name: "AFK", Position: 1},
				{Id: 3, Name: "Вложенная", ParentId: 1, Position: 0, Temporary: true},
			},
			Users: []*rostalkv1.User{
				{Id: 1, Nickname: "alice", ChannelId: 1},
				{Id: 2, Nickname: "bob"},
			},
		},
	}
}

func TestViewResolvesChannelsByNameAndID(t *testing.T) {
	v := newView(&bytes.Buffer{}, testWelcome())

	if id, ok := v.channelID("1"); !ok || id != 1 {
		t.Fatalf("channelID(\"1\") = %d, %v", id, ok)
	}
	if id, ok := v.channelID("afk"); !ok || id != 2 {
		t.Fatalf("channelID(\"afk\") = %d, %v", id, ok)
	}
	if _, ok := v.channelID("42"); ok {
		t.Fatal("channelID accepted a numeric id that does not exist")
	}
	if _, ok := v.channelID("nope"); ok {
		t.Fatal("channelID accepted an unknown name")
	}
}

func TestChannelTreeIsIndented(t *testing.T) {
	var out bytes.Buffer
	v := newView(&out, testWelcome())
	printChannelTree(&out, v)

	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 4 {
		t.Fatalf("tree has %d lines:\n%s", len(lines), out.String())
	}
	if !strings.Contains(lines[1], "Лобби") || !strings.Contains(lines[1], "users 1") {
		t.Fatalf("Lobby line = %q", lines[1])
	}
	if !strings.HasPrefix(lines[2], "  - Вложенная") {
		t.Fatalf("nested channel is not indented: %q", lines[2])
	}
	if !strings.Contains(lines[3], "AFK") {
		t.Fatalf("AFK line = %q", lines[3])
	}
}

func TestEventPrintingUpdatesNames(t *testing.T) {
	var out bytes.Buffer
	v := newView(&out, testWelcome())
	v.handle(&rostalkv1.ServerFrame{
		Payload: &rostalkv1.ServerFrame_Event{Event: &rostalkv1.Event{
			Payload: &rostalkv1.Event_UserMoved{UserMoved: &rostalkv1.UserMoved{
				UserId:        1,
				FromChannelId: 1,
				ToChannelId:   2,
			}},
		}},
	})
	line := out.String()
	if !strings.Contains(line, "alice moved Лобби -> AFK") {
		t.Fatalf("move was not printed with names: %q", line)
	}
	if v.users[1].GetChannelId() != 2 {
		t.Fatal("the local view did not apply the move")
	}
}

func TestExecuteChannelsRejectsBadLink(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if err := execute([]string{"channels", "https://example.test"}, &stdout, &stderr); err == nil {
		t.Fatal("expected an error for a non-rostalk link")
	}
}

func TestExecuteWatchRejectsBadLink(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if err := execute([]string{"watch", "https://example.test"}, &stdout, &stderr); err == nil {
		t.Fatal("expected an error for a non-rostalk link")
	}
}

func TestSplitArgumentsKeepsFlagsAndPositionalsApart(t *testing.T) {
	flags, positional := splitArguments([]string{
		"rostalk://join?host=1", "1", "--nick", "alice", "--timeout=5s", "--identity", "id.key",
	})
	wantFlags := []string{"--nick", "alice", "--timeout=5s", "--identity", "id.key"}
	if strings.Join(flags, " ") != strings.Join(wantFlags, " ") {
		t.Fatalf("flags = %v, want %v", flags, wantFlags)
	}
	wantPositional := []string{"rostalk://join?host=1", "1"}
	if strings.Join(positional, " ") != strings.Join(wantPositional, " ") {
		t.Fatalf("positional = %v, want %v", positional, wantPositional)
	}

	flags, positional = splitArguments([]string{"--nick", "alice", "link", "channel"})
	if len(flags) != 2 || len(positional) != 2 {
		t.Fatalf("flags = %v, positional = %v", flags, positional)
	}
}

func TestExecuteJoinRequiresAChannel(t *testing.T) {
	var stdout, stderr bytes.Buffer
	err := execute([]string{"join", "rostalk://join?host=127.0.0.1:7443&fp=00&invite=x"}, &stdout, &stderr)
	if err == nil || !strings.Contains(err.Error(), "channel") {
		t.Fatalf("join without a channel = %v, want a usage error", err)
	}
}
