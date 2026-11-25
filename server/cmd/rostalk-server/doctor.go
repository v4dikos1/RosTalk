package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"strings"

	"github.com/v4dikos1/RosTalk/server/internal/doctor"
)

// runDoctor prints the diagnostics report. It exits non-zero only on failures,
// not on warnings: a router without hairpin NAT is normal and must not turn a
// working installation red.
func runDoctor(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("doctor", flag.ContinueOnError)
	fs.SetOutput(stderr)
	dataDir := fs.String("data", envString("ROSTALK_DATA", "./data"), "server data directory (ROSTALK_DATA)")
	listen := fs.String("listen", envString("ROSTALK_LISTEN", ":7443"), "control plane listen address (ROSTALK_LISTEN)")
	publicHost := fs.String("public-host", envString("ROSTALK_PUBLIC_HOST", ""), "host used in invite links (ROSTALK_PUBLIC_HOST)")
	domain := fs.String("domain", envString("ROSTALK_DOMAIN", ""), "domain mode (ROSTALK_DOMAIN)")
	natMode := fs.String("nat", envString("ROSTALK_NAT", "auto"), "router probe mode: auto, off, upnp or pmp (ROSTALK_NAT)")
	offline := fs.Bool("offline", false, "skip STUN, router and public-address probes")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected arguments: %s", strings.Join(fs.Args(), " "))
	}

	report := doctor.Run(context.Background(), doctor.Options{
		DataDir:    *dataDir,
		Listen:     *listen,
		PublicHost: *publicHost,
		Domain:     *domain,
		NATMode:    *natMode,
		Offline:    *offline,
	})

	_, _ = fmt.Fprintln(stdout, "RosTalk doctor")
	counts := map[doctor.Status]int{}
	var fixes []string
	for _, check := range report.Checks {
		counts[check.Status]++
		label := map[doctor.Status]string{
			doctor.StatusOK:   " OK ",
			doctor.StatusWarn: "WARN",
			doctor.StatusFail: "FAIL",
			doctor.StatusInfo: "info",
		}[check.Status]
		_, _ = fmt.Fprintf(stdout, "[%s] %s: %s\n", label, check.Name, check.Detail)
		if check.Fix != "" && (check.Status == doctor.StatusWarn || check.Status == doctor.StatusFail) {
			fixes = append(fixes, fmt.Sprintf("%s: %s", check.Name, check.Fix))
		}
	}
	_, _ = fmt.Fprintf(stdout, "\n%d ok, %d warning(s), %d problem(s), %d note(s)\n",
		counts[doctor.StatusOK], counts[doctor.StatusWarn], counts[doctor.StatusFail], counts[doctor.StatusInfo])
	if len(fixes) > 0 {
		_, _ = fmt.Fprintln(stdout, "\nWhat to fix:")
		for _, fix := range fixes {
			_, _ = fmt.Fprintf(stdout, "  - %s\n", fix)
		}
	}
	if counts[doctor.StatusFail] > 0 {
		return fmt.Errorf("doctor found %d problem(s)", counts[doctor.StatusFail])
	}
	return nil
}
