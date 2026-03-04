package handler

import (
	"runtime"

	"golang.org/x/sys/unix"
)

// hostMemoryMB returns the total host RAM in MB.
// On macOS, uses sysctl hw.memsize (64-bit) for accurate host-level memory.
func hostMemoryMB() int {
	if total, err := unix.SysctlUint64("hw.memsize"); err == nil {
		return int(total / 1024 / 1024)
	}
	// fallback
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	return int(ms.Sys / 1024 / 1024)
}
