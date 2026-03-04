//go:build !linux && !darwin

package handler

import "runtime"

// hostMemoryMB returns the total host RAM in MB.
// Fallback for unsupported platforms using Go runtime stats.
func hostMemoryMB() int {
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	return int(ms.Sys / 1024 / 1024)
}
