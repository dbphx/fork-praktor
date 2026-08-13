package natsbus

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dbphx/fork-praktor/internal/config"
	"github.com/nats-io/nats.go"
)

// startSimulatedAgent mirrors the agent-runner startup sequence: connect to
// NATS, subscribe to the input subject, flush (which guarantees the broker
// has registered the subscription), then publish ready.
//
// The optional startupDelay simulates Node.js + container boot time. The
// returned connection is registered with t.Cleanup so the test framework
// closes it deterministically.
func startSimulatedAgent(t *testing.T, url, agentID string, startupDelay time.Duration, counter *atomic.Int32) {
	t.Helper()
	if startupDelay > 0 {
		time.Sleep(startupDelay)
	}
	nc, err := nats.Connect(url)
	if err != nil {
		t.Errorf("simulated agent %s: connect: %v", agentID, err)
		return
	}
	t.Cleanup(func() { nc.Close() })

	if _, err := nc.Subscribe(TopicAgentInput(agentID), func(*nats.Msg) {
		counter.Add(1)
	}); err != nil {
		t.Errorf("simulated agent %s: subscribe: %v", agentID, err)
		return
	}
	if err := nc.Flush(); err != nil {
		t.Errorf("simulated agent %s: flush: %v", agentID, err)
		return
	}
	if err := nc.Publish(TopicAgentReady(agentID), []byte(`{"status":"ready"}`)); err != nil {
		t.Errorf("simulated agent %s: publish ready: %v", agentID, err)
		return
	}
}

// TestReadyWaiter_NoRaceWhenAgentsStartSimultaneously demonstrates that the
// readiness check correctly waits for THIS agent's subscriptions to be
// registered, even when another agent connects to NATS concurrently.
//
// The Phase 1 ReadyWaiter (Bus.NumClients() polling) is expected to FAIL
// this test: the fast agent's TCP connection bumps the global client count,
// satisfying the slow agent's wait condition before the slow agent has
// connected at all. The host then publishes to the slow agent's input
// subject, NATS Core drops the message (no subscriber), and the slow agent
// silently misses its prompt — exactly the production symptom on 2026-05-09.
//
// Phase 2 (per-agent subscription on agent.{id}.ready) makes this test pass.
func TestReadyWaiter_NoRaceWhenAgentsStartSimultaneously(t *testing.T) {
	bus, err := NewForTest(config.NATSConfig{DataDir: t.TempDir()})
	if err != nil {
		t.Fatalf("new bus: %v", err)
	}
	defer bus.Close()

	hostClient, err := NewClient(bus)
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	defer hostClient.Close()

	var fastReceived, slowReceived atomic.Int32

	// Snapshot BOTH waiters before either fake agent connects. This mirrors
	// the production sequence in orchestrator.executeMessage where two
	// goroutines (one per scheduled task) capture clientsBefore back-to-back
	// before either container has reached NATS.
	fastWaiter, err := PrepareReadyWaiter(hostClient, "fast")
	if err != nil {
		t.Fatalf("prepare fast waiter: %v", err)
	}
	defer fastWaiter.Close()

	slowWaiter, err := PrepareReadyWaiter(hostClient, "slow")
	if err != nil {
		t.Fatalf("prepare slow waiter: %v", err)
	}
	defer slowWaiter.Close()

	var wg sync.WaitGroup
	wg.Add(4) // 2 host goroutines + 2 agent setup goroutines

	// Fast path: agent connects immediately.
	go func() {
		defer wg.Done()
		startSimulatedAgent(t, bus.ClientURL(), "fast", 0, &fastReceived)
	}()
	go func() {
		defer wg.Done()
		if err := fastWaiter.Wait(context.Background(), 5*time.Second); err != nil {
			t.Errorf("fast waiter: %v", err)
			return
		}
		if err := hostClient.Publish(TopicAgentInput("fast"), []byte("hi fast")); err != nil {
			t.Errorf("publish fast input: %v", err)
		}
		_ = hostClient.Flush()
	}()

	// Slow path: agent's container takes 2s to boot before connecting.
	// Setup runs concurrently with the host's wait loop. Under the buggy
	// algorithm, the host publishes to slow.input long before the slow
	// agent has subscribed — and NATS drops the message.
	go func() {
		defer wg.Done()
		startSimulatedAgent(t, bus.ClientURL(), "slow", 2*time.Second, &slowReceived)
	}()
	go func() {
		defer wg.Done()
		if err := slowWaiter.Wait(context.Background(), 5*time.Second); err != nil {
			t.Errorf("slow waiter: %v", err)
			return
		}
		if err := hostClient.Publish(TopicAgentInput("slow"), []byte("hi slow")); err != nil {
			t.Errorf("publish slow input: %v", err)
		}
		_ = hostClient.Flush()
	}()

	wg.Wait()

	// Allow any in-flight messages to reach subscribers.
	time.Sleep(300 * time.Millisecond)

	if got := fastReceived.Load(); got != 1 {
		t.Errorf("fast agent received %d messages, want 1", got)
	}
	if got := slowReceived.Load(); got != 1 {
		t.Errorf("slow agent received %d messages, want 1 — race in readiness check (host published before agent subscribed)", got)
	}
}
