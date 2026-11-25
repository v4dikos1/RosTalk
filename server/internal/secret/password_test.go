package secret

import "testing"

func TestPasswordHashRoundTrip(t *testing.T) {
	hash, err := HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	if hash == "correct horse battery staple" {
		t.Fatal("password was stored in plain text")
	}
	if !VerifyPassword(hash, "correct horse battery staple") {
		t.Fatal("correct password was rejected")
	}
	if VerifyPassword(hash, "wrong") {
		t.Fatal("wrong password was accepted")
	}
	if VerifyPassword("", "anything") {
		t.Fatal("empty hash was accepted")
	}
	if VerifyPassword("$argon2id$broken", "x") {
		t.Fatal("malformed hash was accepted")
	}
	if VerifyPassword(hash, "") {
		t.Fatal("empty password was accepted")
	}
	if _, err := HashPassword(""); err == nil {
		t.Fatal("empty password was hashed")
	}
}

func TestPasswordHashIsSalted(t *testing.T) {
	first, err := HashPassword("same password")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	second, err := HashPassword("same password")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	if first == second {
		t.Fatal("two hashes of the same password are identical: the salt is not random")
	}
}
