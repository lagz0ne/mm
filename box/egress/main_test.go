package main

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"log"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestWhy(t *testing.T) {
	p := &Policy{deny: mustPrefixes("8.8.8.0/24")}
	refused := []string{"127.0.0.1", "127.1.2.3", "10.0.0.5", "10.231.7.2", "172.17.0.1", "172.31.255.255", "192.168.1.1",
		"100.64.0.1", "169.254.169.254", "169.254.1.1", "0.0.0.0", "0.1.2.3", "224.0.0.1", "239.255.255.250", "255.255.255.255",
		"::1", "::", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "fc00::1", "fd12:3456::1", "fe80::1",
		"fe80::1%eth0", "ff02::1", "64:ff9b::a00:1", "2002:a00:1::1", "8.8.8.8"}
	for _, s := range refused {
		if w := p.Why(netip.MustParseAddr(s)); w == "" {
			t.Errorf("%s: allowed, want refused", s)
		}
	}
	for _, s := range []string{"140.82.121.4", "1.1.1.1", "104.16.0.1", "2606:4700::1111", "::ffff:1.1.1.1", "172.32.0.1", "100.128.0.1"} {
		if w := p.Why(netip.MustParseAddr(s)); w != "" {
			t.Errorf("%s: refused (%s), want allowed", s, w)
		}
	}
}

// The proxy's own networks are read at each check: a network connected after the start counts too.
func TestLocalNets(t *testing.T) {
	var nets []netip.Prefix
	p := &Policy{local: func() []netip.Prefix { return nets }}
	a := netip.MustParseAddr("198.41.0.9")
	if p.Why(a) != "" {
		t.Fatal("refused before the network is there")
	}
	nets = mustPrefixes("198.41.0.0/24")
	if w := p.Why(a); !strings.Contains(w, "a network of this proxy") {
		t.Fatalf("after: %q", w)
	}
}

func TestCheckDial(t *testing.T) {
	p := &Policy{}
	for _, a := range []string{"127.0.0.1:443", "10.0.0.1:443", "[::1]:443", "1.1.1.1:80", "[::ffff:10.0.0.1]:443", "nonsense"} {
		if p.checkDial(a) == nil {
			t.Errorf("%s: dial allowed", a)
		}
	}
	if err := p.checkDial("1.1.1.1:443"); err != nil {
		t.Errorf("1.1.1.1:443: %v", err)
	}
}

func TestParsePrefixes(t *testing.T) {
	ps, err := parsePrefixes("172.17.0.0/16, 10.231.5.0/24 203.0.114.7")
	if err != nil || len(ps) != 3 || ps[2].String() != "203.0.114.7/32" {
		t.Fatalf("got %v %v", ps, err)
	}
	if _, err := parsePrefixes("nope"); err == nil {
		t.Fatal("nope parsed")
	}
}

func allowFile(t *testing.T, body string) string {
	f := filepath.Join(t.TempDir(), "allow")
	if err := os.WriteFile(f, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return f
}

func TestAllowed(t *testing.T) {
	f := allowFile(t, "^github\\.com(:443)?$\n^(.+\\.)?example\\.org(:443)?$\nnot-anchored\\.com\n^bad(pattern$\n")
	for name, want := range map[string]bool{"github.com": true, "api.github.com": false, "githubxcom": false, "evilgithub.com": false,
		"github.com.evil.net": false, "example.org": true, "a.b.example.org": true, "not-anchored.com": false, "x.not-anchored.com": false} {
		if got := allowed(f, name); got != want {
			t.Errorf("%s: %v, want %v", name, got, want)
		}
	}
	if allowed(filepath.Join(t.TempDir(), "missing"), "github.com") {
		t.Error("a missing list allows")
	}
}

func TestNormName(t *testing.T) {
	for in, want := range map[string]string{"GitHub.COM.": "github.com", "a_b.example": "a_b.example", "::ffff:10.0.0.1": "::ffff:10.0.0.1",
		"bad name": "", "a/b": "", "": "", "x..y": "", "-x.y": ""} {
		if got := normName(in); got != want {
			t.Errorf("%q: %q, want %q", in, got, want)
		}
	}
}

// A proxy with fake DNS and a fake network: every dial reaches an echo server; the log goes to a buffer.
type rig struct {
	s     *Server
	addr  string
	logs  *syncBuf
	dns   map[string][]string
	dials []netip.AddrPort
	mu    sync.Mutex
}

type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (b *syncBuf) Write(p []byte) (int, error) { b.mu.Lock(); defer b.mu.Unlock(); return b.b.Write(p) }
func (b *syncBuf) String() string              { b.mu.Lock(); defer b.mu.Unlock(); return b.b.String() }

func newRig(t *testing.T, dns map[string][]string) *rig {
	r := &rig{logs: &syncBuf{}, dns: dns}
	f := allowFile(t, "^good\\.example(:443)?$\n^loop\\.example(:443)?$\n^ten\\.example(:443)?$\n^meta\\.example(:443)?$\n^mixed\\.example(:443)?$\n^mapped\\.example(:443)?$\n^ula\\.example(:443)?$\n")
	r.s = NewServer(f, &Policy{}, log.New(r.logs, "", 0))
	r.s.resolve = func(_ context.Context, host string) ([]netip.Addr, error) {
		var out []netip.Addr
		for _, a := range r.dns[host] {
			out = append(out, netip.MustParseAddr(a))
		}
		if len(out) == 0 {
			return nil, errors.New("no such host")
		}
		return out, nil
	}
	r.s.dial = func(_ context.Context, ap netip.AddrPort) (net.Conn, error) {
		if err := r.s.Policy.checkDial(ap.String()); err != nil {
			return nil, err
		}
		r.mu.Lock()
		r.dials = append(r.dials, ap)
		r.mu.Unlock()
		a, b := net.Pipe()
		go func() { io.Copy(b, b); b.Close() }() // echo
		return a, nil
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	r.addr = ln.Addr().String()
	go r.s.Serve(ln)
	return r
}

// ask sends a request head and returns the proxy's status line, and the connection (open after a 200).
func (r *rig) ask(t *testing.T, head string) (string, net.Conn, *bufio.Reader) {
	c, err := net.Dial("tcp", r.addr)
	if err != nil {
		t.Fatal(err)
	}
	c.SetDeadline(time.Now().Add(5 * time.Second))
	io.WriteString(c, head)
	br := bufio.NewReader(c)
	line, _ := br.ReadString('\n')
	for {
		l, err := br.ReadString('\n')
		if err != nil || l == "\r\n" {
			break
		}
	}
	return strings.TrimSpace(line), c, br
}

func TestProxy(t *testing.T) {
	r := newRig(t, map[string][]string{
		"good.example": {"2606:4700::1", "140.82.121.4"}, "loop.example": {"127.0.0.1"}, "ten.example": {"10.1.2.3"},
		"meta.example": {"169.254.169.254"}, "mixed.example": {"140.82.121.4", "192.168.0.7"}, "mapped.example": {"::ffff:127.0.0.1"},
		"ula.example": {"fd00::1"}, "off.example": {"140.82.121.4"},
	})
	cases := []struct{ head, status, log string }{
		{"CONNECT loop.example:443 HTTP/1.1\r\n\r\n", "403", `refused from=127.0.0.1 name=loop.example port=443 address=127.0.0.1`},
		{"CONNECT ten.example:443 HTTP/1.1\r\n\r\n", "403", `name=ten.example port=443 address=10.1.2.3 why="the name resolves to a non-public address (10.0.0.0/8)"`},
		{"CONNECT meta.example:443 HTTP/1.1\r\n\r\n", "403", `name=meta.example port=443 address=169.254.169.254`},
		{"CONNECT mixed.example:443 HTTP/1.1\r\n\r\n", "403", `name=mixed.example port=443 address=192.168.0.7`},
		{"CONNECT mapped.example:443 HTTP/1.1\r\n\r\n", "403", `name=mapped.example port=443 address=127.0.0.1`},
		{"CONNECT ula.example:443 HTTP/1.1\r\n\r\n", "403", `name=ula.example port=443 address=fd00::1`},
		{"CONNECT off.example:443 HTTP/1.1\r\n\r\n", "403", `name=off.example port=443 why="not on this project's egress list"`},
		{"CONNECT good.example:80 HTTP/1.1\r\n\r\n", "403", `name=good.example port=80 why="only port 443 goes out"`},
		{"GET http://good.example/ HTTP/1.1\r\nHost: good.example\r\n\r\n", "403", `name=good.example why="only https (CONNECT) to port 443 goes out, not GET"`},
		{"CONNECT 10.0.0.1:443 HTTP/1.1\r\n\r\n", "403", `name=10.0.0.1 port=443 why="not on this project's egress list"`},
		{"CONNECT nowhere.example HTTP/1.1\r\n\r\n", "400", `why="CONNECT needs a name and a port"`},
		{"hello\r\n\r\n", "400", `why="not an HTTP request"`},
	}
	for _, c := range cases {
		st, conn, _ := r.ask(t, c.head)
		conn.Close()
		if !strings.Contains(st, " "+c.status+" ") {
			t.Errorf("%q: %q, want %s", c.head, st, c.status)
		}
		if !strings.Contains(r.logs.String(), c.log) {
			t.Errorf("%q: no log line with %q in:\n%s", c.head, c.log, r.logs.String())
		}
	}
	if len(r.dials) != 0 {
		t.Fatalf("refused names were dialed: %v", r.dials)
	}
	// an allowed name with public addresses: one lookup, the tunnel goes to the IPv4 address it checked, data flows
	before := r.s.resolves.Load()
	st, conn, br := r.ask(t, "CONNECT GOOD.example:443 HTTP/1.1\r\nHost: good.example:443\r\n\r\n")
	if !strings.Contains(st, " 200 ") {
		t.Fatalf("good.example: %q\n%s", st, r.logs.String())
	}
	io.WriteString(conn, "ping\n")
	if got, _ := br.ReadString('\n'); got != "ping\n" {
		t.Errorf("tunnel echo: %q", got)
	}
	conn.Close()
	if n := r.s.resolves.Load() - before; n != 1 {
		t.Errorf("%d lookups, want 1", n)
	}
	if len(r.dials) != 1 || r.dials[0].String() != "140.82.121.4:443" {
		t.Errorf("dials %v, want [140.82.121.4:443]", r.dials)
	}
	time.Sleep(100 * time.Millisecond)
	if !strings.Contains(r.logs.String(), "allowed from=127.0.0.1 name=good.example port=443 address=140.82.121.4") {
		t.Errorf("no allowed line:\n%s", r.logs.String())
	}
}

// Rebinding: the name changes to a private address after the check. The proxy never looks it up again: each
// connection is checked on its own lookup, and the connect goes to the address that lookup gave.
func TestRebinding(t *testing.T) {
	r := newRig(t, map[string][]string{"good.example": {"140.82.121.4"}})
	st, conn, _ := r.ask(t, "CONNECT good.example:443 HTTP/1.1\r\n\r\n")
	conn.Close()
	if !strings.Contains(st, " 200 ") {
		t.Fatalf("first: %q", st)
	}
	r.dns["good.example"] = []string{"127.0.0.1"}
	st, conn, _ = r.ask(t, "CONNECT good.example:443 HTTP/1.1\r\n\r\n")
	conn.Close()
	if !strings.Contains(st, " 403 ") || !strings.Contains(r.logs.String(), "name=good.example port=443 address=127.0.0.1") {
		t.Fatalf("after the change: %q\n%s", st, r.logs.String())
	}
	if len(r.dials) != 1 {
		t.Fatalf("dials %v", r.dials)
	}
}

func TestIdle(t *testing.T) {
	r := newRig(t, map[string][]string{"good.example": {"140.82.121.4"}})
	r.s.Idle = 200 * time.Millisecond
	st, conn, br := r.ask(t, "CONNECT good.example:443 HTTP/1.1\r\n\r\n")
	if !strings.Contains(st, " 200 ") {
		t.Fatalf("%q", st)
	}
	conn.SetDeadline(time.Now().Add(3 * time.Second))
	if _, err := br.ReadByte(); err == nil {
		t.Fatal("read data from an idle tunnel")
	}
	time.Sleep(50 * time.Millisecond)
	if !strings.Contains(r.logs.String(), "closed from=127.0.0.1 name=good.example") {
		t.Errorf("no closed line:\n%s", r.logs.String())
	}
}
