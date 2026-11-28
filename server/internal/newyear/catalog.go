package newyear

import (
	"crypto/rand"
	"fmt"
	"math/big"
	"slices"
)

// Rarity describes the API v1 catalog in ascending rarity order.
type Rarity struct {
	Name   string
	Weight int
	Items  []string
}

// Catalog returns the immutable v1 catalog as independent slices.
func Catalog() []Rarity {
	return []Rarity{
		{"common", 60, []string{"ball-red", "ball-gold", "ball-blue", "candy-cane", "pine-cone", "snowflake"}},
		{"rare", 25, []string{"ball-glass-house", "bell-gold", "ribbon-bow", "icicle-silver"}},
		{"epic", 12, []string{"ball-aurora", "snow-globe", "gingerbread-house"}},
		{"legendary", 3, []string{"star-topper", "deer-gold", "clock-midnight"}},
	}
}

func knownItem(id string) bool {
	for _, rarity := range Catalog() {
		if slices.Contains(rarity.Items, id) {
			return true
		}
	}
	return false
}

func secureDraw(bound int) (int, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(int64(bound)))
	if err != nil {
		return 0, err
	}
	return int(n.Int64()), nil
}

func (s *Service) drawItem() (string, error) {
	roll, err := s.boundedDraw(100)
	if err != nil {
		return "", err
	}
	for _, rarity := range Catalog() {
		if roll < rarity.Weight {
			index, err := s.boundedDraw(len(rarity.Items))
			if err != nil {
				return "", err
			}
			return rarity.Items[index], nil
		}
		roll -= rarity.Weight
	}
	return "", fmt.Errorf("catalog weights do not cover the roll")
}

func (s *Service) boundedDraw(bound int) (int, error) {
	n, err := s.draw(bound)
	if err != nil {
		return 0, fmt.Errorf("draw New Year reward: %w", err)
	}
	if n < 0 || n >= bound {
		return 0, fmt.Errorf("New Year draw outside bound %d", bound)
	}
	return n, nil
}
