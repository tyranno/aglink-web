package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// defaultPort is the fixed localhost port the daemon binds and the extension
// dials. Chosen high enough to avoid the common dev ports (3000/5000/8080/9000)
// yet below the Windows ephemeral range (49152+) so it will not collide with an
// OS-allocated outbound port. Override with AGLINK_WEB_PORT.
const defaultPort = 48219

const portEnv = "AGLINK_WEB_PORT"

// dataDir returns the aglink data directory, creating it if necessary:
// $AGLINK_HOME if set, else ~/.aglink. The host process owns one-time legacy
// ~/.teleclaude migration; helper apps should not split back to the old dir.
func dataDir() (string, error) {
	if v := strings.TrimSpace(os.Getenv("AGLINK_HOME")); v != "" {
		if err := os.MkdirAll(v, 0o700); err != nil {
			return "", err
		}
		return v, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(home, ".aglink")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	return dir, nil
}

// portFilePath is <dataDir>/aglink-web.port, written by the daemon on start
// and read by the bridge so the two agree on the port even if AGLINK_WEB_PORT
// changed the default. The extension uses the fixed default (see README).
func portFilePath() (string, error) {
	dir, err := dataDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "aglink-web.port"), nil
}

// configuredPort resolves the port to bind/dial: AGLINK_WEB_PORT if set and
// valid, else defaultPort.
func configuredPort() int {
	if v := strings.TrimSpace(os.Getenv(portEnv)); v != "" {
		if p, err := strconv.Atoi(v); err == nil && p > 0 && p < 65536 {
			return p
		}
	}
	return defaultPort
}

// writePort records the live daemon port to the port file.
func writePort(port int) error {
	p, err := portFilePath()
	if err != nil {
		return err
	}
	return os.WriteFile(p, []byte(strconv.Itoa(port)), 0o600)
}

// readPort returns the port recorded by a running daemon, falling back to
// configuredPort() when the file is missing or unparseable (a stale/corrupt
// file must not brick the bridge, same as aglink-screen's preset store).
func readPort() int {
	p, err := portFilePath()
	if err != nil {
		return configuredPort()
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return configuredPort()
	}
	if n, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil && n > 0 && n < 65536 {
		return n
	}
	return configuredPort()
}

// daemonBaseURL is the localhost HTTP base for the bridge daemon.
func daemonBaseURL(port int) string {
	return fmt.Sprintf("http://127.0.0.1:%d", port)
}
