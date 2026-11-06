// mm-egress: a project box's egress proxy (plans/project-box.md, M1-B; sy-59m8), the only way out of a box.
//
// It speaks HTTP CONNECT only, to port 443 only, for a name on the project's allow list only (one anchored, escaped
// pattern per line, written by mm and mounted read-only). It resolves the name itself and refuses the connection when
// any address of the name is not public: loopback, private (RFC 1918), CGNAT, link-local (with the cloud metadata
// address), IPv6 unique local, multicast, reserved, the docker networks mm names, and the networks of this container.
// Then it connects to the address it checked: there is no second lookup, so a DNS change between the check and the
// connection (rebinding) can't move it. The socket's address is checked once more just before the connect.
//
// One line per decision on stdout (mm appends it to the project's egress log, which the host ships per project).
// Go's standard library only.
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/netip"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// The only port a box may reach outside.
const outPort = 443

// Addresses a box may never reach through its proxy, whatever name points there.
var blocked = mustPrefixes(
	"0.0.0.0/8",      // "this" network
	"10.0.0.0/8",     // private (RFC 1918); mm's box networks are here
	"100.64.0.0/10",  // carrier-grade NAT
	"127.0.0.0/8",    // loopback
	"169.254.0.0/16", // link-local, with the cloud metadata address 169.254.169.254
	"172.16.0.0/12",  // private (RFC 1918); docker's default bridges are here
	"192.0.0.0/24",   // IETF protocol assignments
	"192.0.2.0/24",   // documentation
	"192.88.99.0/24", // 6to4 relay
	"192.168.0.0/16", // private (RFC 1918)
	"198.18.0.0/15",  // benchmarking
	"198.51.100.0/24",
	"203.0.113.0/24", // documentation
	"224.0.0.0/4",    // multicast
	"240.0.0.0/4",    // reserved, and the broadcast address
	"::/96",          // unspecified, loopback, IPv4-compatible
	"64:ff9b::/96",   // NAT64: an IPv4 address inside
	"64:ff9b:1::/48", // local NAT64
	"100::/64",       // discard
	"2001::/32",      // Teredo: an IPv4 address inside
	"2001:db8::/32",  // documentation
	"2002::/16",      // 6to4: an IPv4 address inside
	"fc00::/7",       // unique local (ULA)
	"fe80::/10",      // link-local
	"fec0::/10",      // site-local (deprecated)
	"ff00::/8",       // multicast
)

func mustPrefixes(s ...string) []netip.Prefix {
	out := make([]netip.Prefix, 0, len(s))
	for _, x := range s {
		out = append(out, netip.MustParsePrefix(x))
	}
	return out
}

// parsePrefixes reads a list of networks (CIDR or a single address), separated by commas or spaces.
func parsePrefixes(s string) ([]netip.Prefix, error) {
	var out []netip.Prefix
	for _, f := range strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == ' ' || r == '\n' || r == '\t' }) {
		if p, err := netip.ParsePrefix(f); err == nil {
			out = append(out, p.Masked())
		} else if a, err2 := netip.ParseAddr(f); err2 == nil {
			out = append(out, netip.PrefixFrom(a.Unmap(), a.Unmap().BitLen()))
		} else {
			return nil, fmt.Errorf("not a network: %q", f)
		}
	}
	return out, nil
}

// Policy decides which addresses are out of reach: the fixed list, the networks mm names, and the networks this
// container is on now (local: read at each check, since mm connects the box's network after the start).
type Policy struct {
	deny  []netip.Prefix
	local func() []netip.Prefix
}

// Why says why an address is refused ("" when it is public).
func (p *Policy) Why(a netip.Addr) string {
	if !a.IsValid() {
		return "not an address"
	}
	a = a.Unmap().WithZone("")
	for _, pf := range blocked {
		if pf.Contains(a) {
			return "a non-public address (" + pf.String() + ")"
		}
	}
	for _, pf := range p.deny {
		if pf.Contains(a) {
			return "a docker or local network (" + pf.String() + ")"
		}
	}
	if p.local != nil {
		for _, pf := range p.local() {
			if pf.Contains(a) {
				return "a network of this proxy (" + pf.String() + ")"
			}
		}
	}
	return ""
}

// checkDial is the last check, on the socket's own address, just before the connect.
func (p *Policy) checkDial(address string) error {
	ap, err := netip.ParseAddrPort(address)
	if err != nil {
		return fmt.Errorf("connect to %q: %v", address, err)
	}
	if ap.Port() != outPort {
		return fmt.Errorf("connect to port %d: only %d", ap.Port(), outPort)
	}
	if w := p.Why(ap.Addr()); w != "" {
		return fmt.Errorf("connect to %s: %s", ap.Addr(), w)
	}
	return nil
}

var nameRe = regexp.MustCompile(`^[a-z0-9_]([a-z0-9_-]*)(\.[a-z0-9_-]+)*$`)

// normName gives the name in the form the allow list matches (lower case, no final dot), or "" if it is not a name
// or an address.
func normName(h string) string {
	h = strings.TrimSuffix(strings.ToLower(h), ".")
	if a, err := netip.ParseAddr(h); err == nil {
		return a.String()
	}
	if len(h) > 253 || !nameRe.MatchString(h) {
		return ""
	}
	return h
}

// allowed matches a name against the allow file: one pattern per line, the same anchored and escaped patterns mm has
// written since tinyproxy (`^github\.com(:443)?$`). Read at each connection, so a new list applies at once. An
// unreadable file allows nothing; a line that is not a pattern allows nothing.
func allowed(file, name string) bool {
	b, err := os.ReadFile(file)
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if !strings.HasPrefix(line, "^") || !strings.HasSuffix(line, "$") {
			continue // only anchored patterns
		}
		re, err := regexp.Compile(line)
		if err != nil {
			continue
		}
		if re.MatchString(name) {
			return true
		}
	}
	return false
}

// Server is the proxy. resolve and dial are fields so the tests can stand in for DNS and the network.
type Server struct {
	Allow    string
	Policy   *Policy
	Idle     time.Duration
	Header   time.Duration
	Max      int
	Log      *log.Logger
	resolve  func(ctx context.Context, host string) ([]netip.Addr, error)
	dial     func(ctx context.Context, addr netip.AddrPort) (net.Conn, error)
	sem      chan struct{}
	resolves atomic.Int64
}

func NewServer(allow string, p *Policy, lg *log.Logger) *Server {
	s := &Server{Allow: allow, Policy: p, Idle: 120 * time.Second, Header: 15 * time.Second, Max: 100, Log: lg}
	s.resolve = func(ctx context.Context, host string) ([]netip.Addr, error) {
		return net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	}
	s.dial = func(ctx context.Context, ap netip.AddrPort) (net.Conn, error) {
		d := net.Dialer{Timeout: 10 * time.Second, Control: func(_, address string, _ syscall.RawConn) error { return p.checkDial(address) }}
		return d.DialContext(ctx, "tcp", ap.String())
	}
	return s
}

var plain = regexp.MustCompile(`^[A-Za-z0-9.:_/\[\]-]+$`)

// logf writes one line: time, what happened, then key=value pairs (values quoted when they need it).
func (s *Server) logf(event string, kv ...string) {
	var b strings.Builder
	b.WriteString(time.Now().UTC().Format(time.RFC3339))
	b.WriteString(" ")
	b.WriteString(event)
	for i := 0; i+1 < len(kv); i += 2 {
		if kv[i+1] == "" {
			continue
		}
		v := kv[i+1]
		if !plain.MatchString(v) {
			v = strconv.Quote(v)
		}
		b.WriteString(" " + kv[i] + "=" + v)
	}
	s.Log.Print(b.String())
}

func reply(c net.Conn, code int, msg string) {
	c.SetWriteDeadline(time.Now().Add(5 * time.Second))
	fmt.Fprintf(c, "HTTP/1.1 %d %s\r\nContent-Type: text/plain\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s\n", code, http.StatusText(code), len(msg)+1, msg)
}

// Serve accepts connections until the listener closes.
func (s *Server) Serve(ln net.Listener) error {
	s.sem = make(chan struct{}, s.Max)
	for {
		c, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return err
			}
			time.Sleep(50 * time.Millisecond)
			continue
		}
		select {
		case s.sem <- struct{}{}:
			go func() { defer func() { <-s.sem }(); s.handle(c) }()
		default:
			go func() {
				defer c.Close()
				s.logf("refused", "from", host(c.RemoteAddr()), "why", "too many connections")
				reply(c, 503, "too many connections")
			}()
		}
	}
}

func host(a net.Addr) string {
	if h, _, err := net.SplitHostPort(a.String()); err == nil {
		return h
	}
	return a.String()
}

func (s *Server) handle(c net.Conn) {
	defer c.Close()
	from := host(c.RemoteAddr())
	c.SetDeadline(time.Now().Add(s.Header))
	lr := &io.LimitedReader{R: c, N: 64 << 10} // the request head; lifted once the tunnel is up
	br := bufio.NewReader(lr)
	req, err := http.ReadRequest(br)
	if err != nil {
		s.logf("refused", "from", from, "why", "not an HTTP request")
		reply(c, 400, "not an HTTP request")
		return
	}
	refuse := func(code int, name, port, addr, why string) {
		s.logf("refused", "from", from, "name", name, "port", port, "address", addr, "why", why)
		reply(c, code, "mm egress: refused: "+why)
	}
	if req.Method != http.MethodConnect {
		h := req.URL.Hostname()
		if h == "" {
			h = req.Host
		}
		refuse(403, h, req.URL.Port(), "", "only https (CONNECT) to port 443 goes out, not "+req.Method)
		return
	}
	hp := req.URL.Host
	if hp == "" {
		hp = req.Host
	}
	h, port, err := net.SplitHostPort(hp)
	if err != nil {
		refuse(400, hp, "", "", "CONNECT needs a name and a port")
		return
	}
	if port != strconv.Itoa(outPort) {
		refuse(403, h, port, "", "only port 443 goes out")
		return
	}
	name := normName(h)
	if name == "" {
		refuse(403, h, port, "", "not a host name")
		return
	}
	if !allowed(s.Allow, name) {
		refuse(403, name, port, "", "not on this project's egress list")
		return
	}
	// resolve once; every address must be public; connect to the addresses checked here, never to the name
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	s.resolves.Add(1)
	addrs, err := s.resolve(ctx, name)
	if err != nil || len(addrs) == 0 {
		refuse(502, name, port, "", "the name does not resolve")
		return
	}
	sort.SliceStable(addrs, func(i, j int) bool { return addrs[i].Unmap().Is4() && !addrs[j].Unmap().Is4() }) // IPv4 first
	for _, a := range addrs {
		if w := s.Policy.Why(a); w != "" {
			refuse(403, name, port, a.Unmap().String(), "the name resolves to "+w)
			return
		}
	}
	var up net.Conn
	var used netip.Addr
	var last error
	for _, a := range addrs {
		ap := netip.AddrPortFrom(a.Unmap(), outPort)
		if up, last = s.dial(ctx, ap); last == nil {
			used = ap.Addr()
			break
		}
	}
	if up == nil {
		why := "could not connect"
		if last != nil {
			why += ": " + last.Error()
		}
		refuse(502, name, port, addrs[0].Unmap().String(), why)
		return
	}
	defer up.Close()
	s.logf("allowed", "from", from, "name", name, "port", port, "address", used.String())
	c.SetDeadline(time.Time{})
	if _, err := io.WriteString(c, "HTTP/1.1 200 Connection established\r\n\r\n"); err != nil {
		return
	}
	lr.N = 1 << 62
	start := time.Now()
	sent, recv := pipe(c, br, up, s.Idle)
	s.logf("closed", "from", from, "name", name, "address", used.String(), "sent", strconv.FormatInt(sent, 10), "received", strconv.FormatInt(recv, 10), "seconds", strconv.Itoa(int(time.Since(start).Seconds())))
}

// pipe copies both ways until both sides end, or nothing moved either way for idle.
func pipe(client net.Conn, cr io.Reader, up net.Conn, idle time.Duration) (sent, recv int64) {
	var last atomic.Int64
	last.Store(time.Now().UnixNano())
	var once sync.Once
	closeAll := func() { once.Do(func() { client.Close(); up.Close() }) }
	var wg sync.WaitGroup
	cp := func(dst, src net.Conn, r io.Reader, n *int64) {
		defer wg.Done()
		buf := make([]byte, 32<<10)
		for {
			src.SetReadDeadline(time.Now().Add(idle))
			k, err := r.Read(buf)
			if k > 0 {
				last.Store(time.Now().UnixNano())
				dst.SetWriteDeadline(time.Now().Add(idle))
				if _, werr := dst.Write(buf[:k]); werr != nil {
					closeAll()
					return
				}
				*n += int64(k)
			}
			if err != nil {
				if errors.Is(err, os.ErrDeadlineExceeded) && time.Since(time.Unix(0, last.Load())) < idle {
					continue // the other way is busy
				}
				if errors.Is(err, io.EOF) {
					if tc, ok := dst.(interface{ CloseWrite() error }); ok {
						tc.CloseWrite()
						return
					}
				}
				closeAll()
				return
			}
		}
	}
	wg.Add(2)
	go cp(up, client, cr, &sent)
	go cp(client, up, up, &recv)
	wg.Wait()
	closeAll()
	return
}

// localNets: the networks this container is on (its box network and its way out), never a destination.
func localNets() []netip.Prefix {
	var out []netip.Prefix
	as, _ := net.InterfaceAddrs()
	for _, a := range as {
		if n, ok := a.(*net.IPNet); ok {
			if p, err := netip.ParsePrefix(n.String()); err == nil {
				out = append(out, p.Masked())
			}
		}
	}
	return out
}

func main() {
	listen := flag.String("listen", ":8888", "address to listen on")
	allow := flag.String("allow", "/etc/mm/allow", "the allow list (one anchored pattern per line)")
	deny := flag.String("deny", os.Getenv("MM_EGRESS_DENY"), "more networks to refuse (comma-separated; default $MM_EGRESS_DENY)")
	idle := flag.Duration("idle", 120*time.Second, "close a tunnel idle this long")
	max := flag.Int("max", 100, "most connections at once")
	flag.Parse()
	lg := log.New(os.Stdout, "", 0)
	extra, err := parsePrefixes(*deny)
	if err != nil {
		lg.Fatalf("%s mm-egress: -deny: %v", time.Now().UTC().Format(time.RFC3339), err)
	}
	s := NewServer(*allow, &Policy{deny: extra, local: localNets}, lg)
	s.Idle, s.Max = *idle, *max
	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		lg.Fatalf("%s mm-egress: %v", time.Now().UTC().Format(time.RFC3339), err)
	}
	var ds []string
	for _, p := range append(extra, localNets()...) {
		ds = append(ds, p.String())
	}
	s.logf("start", "listen", *listen, "allow", *allow, "port", strconv.Itoa(outPort), "deny", strings.Join(ds, ","))
	lg.Fatal(s.Serve(ln))
}
