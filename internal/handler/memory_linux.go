package handler

import (
	"bufio"
	"os"
	"runtime"
	"strconv"
	"strings"
)

// hostMemoryMB returns the total host RAM in MB.
// On Linux, reads /proc/meminfo for accurate host-level memory.
func hostMemoryMB() int {
	if f, err := os.Open("/proc/meminfo"); err == nil {
		defer f.Close()
		scanner := bufio.NewScanner(f)
		for scanner.Scan() {
			line := scanner.Text()
			if strings.HasPrefix(line, "MemTotal:") {
				fields := strings.Fields(line)
				if len(fields) >= 2 {
					if kb, err := strconv.Atoi(fields[1]); err == nil {
						return kb / 1024
					}
				}
				break
			}
		}
	}
	// fallback
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	return int(ms.Sys / 1024 / 1024)
}
