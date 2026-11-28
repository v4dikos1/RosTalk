package integration

import (
	"encoding/json"
	"errors"
	"maps"
	"os"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/v4dikos1/RosTalk/server/internal/newyear"
	"gopkg.in/yaml.v3"
)

func TestNewYearOpenAPIContract(t *testing.T) {
	raw, err := os.ReadFile("../../../docs/openapi.yaml")
	if errors.Is(err, os.ErrNotExist) {
		t.Skip("mount docs/openapi.yaml when running the test outside a repository checkout")
	}
	if err != nil {
		t.Fatal(err)
	}
	var spec struct {
		Components struct {
			Schemas   map[string]yaml.Node
			Responses map[string]struct{ Description string }
		}
		Paths map[string]map[string]struct {
			Responses map[string]yaml.Node
		}
	}
	if err := yaml.Unmarshal(raw, &spec); err != nil {
		t.Fatal(err)
	}

	var catalog struct {
		Example struct {
			Rarities        []newyear.Rarity
			SpinCost        int `yaml:"spinCost"`
			DuplicateRefund int `yaml:"duplicateRefund"`
		}
	}
	schema := spec.Components.Schemas["NewYearCatalog"]
	if err := schema.Decode(&catalog); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(catalog.Example.Rarities, newyear.Catalog()) ||
		catalog.Example.SpinCost != newyear.SpinCost || catalog.Example.DuplicateRefund != newyear.SpinRefund {
		t.Fatalf("OpenAPI catalog and defaults differ from the server catalog: %+v", catalog.Example)
	}

	for name, shape := range map[string]any{
		"NewYearSupport":    newyear.Support{},
		"NewYearState":      newyear.State{},
		"NewYearLayout":     newyear.Layout{},
		"NewYearPlacement":  newyear.Placement{},
		"NewYearReceipt":    newyear.Receipt{},
		"NewYearClaimReply": newyear.ClaimResponse{},
		"NewYearSpinReply":  newyear.SpinResponse{},
		"NewYearTreeReply":  newyear.TreeResponse{},
	} {
		var documented struct {
			Required []string
			Example  map[string]any
		}
		schema := spec.Components.Schemas[name]
		if err := schema.Decode(&documented); err != nil {
			t.Fatal(err)
		}
		encoded, err := json.Marshal(shape)
		if err != nil {
			t.Fatal(err)
		}
		var object map[string]any
		if err := json.Unmarshal(encoded, &object); err != nil {
			t.Fatal(err)
		}
		keys := slices.Sorted(maps.Keys(object))
		slices.Sort(documented.Required)
		if !slices.Equal(keys, documented.Required) {
			t.Errorf("%s JSON keys = %v, OpenAPI requires %v", name, keys, documented.Required)
		}
		if documented.Example != nil && !slices.Equal(keys, slices.Sorted(maps.Keys(documented.Example))) {
			t.Errorf("%s example keys = %v, want %v", name, slices.Sorted(maps.Keys(documented.Example)), keys)
		}
	}

	const read = "200 400 401 403 404"
	const state = read + " 409 500"
	const mutation = read + " 409 413 415 429 500"
	for _, route := range []struct{ path, method, statuses string }{
		{"/support", "get", read}, {"/me", "get", state},
		{"/me/enrollment", "put", mutation}, {"/me/claim", "post", mutation}, {"/me/water", "post", mutation},
		{"/me/spins", "post", mutation}, {"/me/layout", "put", mutation}, {"/trees/{id}", "get", state},
	} {
		methods := spec.Paths["/events/new-year"+route.path]
		got := slices.Sorted(maps.Keys(methods[route.method].Responses))
		if len(methods) != 1 || !slices.Equal(got, strings.Fields(route.statuses)) {
			t.Errorf("%s %s statuses = %v, want %s", route.method, route.path, got, route.statuses)
		}
	}
	codes := spec.Components.Responses["NewYearConflict"].Description
	for _, code := range []newyear.RuleError{
		newyear.ErrClosed, newyear.ErrNotEnrolled, newyear.ErrDayChanged, newyear.ErrAlreadyClaimed,
		newyear.ErrAlreadyWatered, newyear.ErrNoWater, newyear.ErrInsufficientFlakes, newyear.ErrLayoutConflict,
		newyear.ErrNotOwned, newyear.ErrBackgroundLocked,
	} {
		if !strings.Contains(codes, "`"+string(code)+"`") {
			t.Errorf("OpenAPI does not document conflict %s", code)
		}
	}
}
