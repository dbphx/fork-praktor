package natsbus

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/nats-io/nats.go"
)

// ErrReadyTimeout is returned by ReadyWaiter.Wait when the agent does not
// signal readiness within the configured timeout. Callers typically log
// and proceed (publishing to the input topic anyway).
var ErrReadyTimeout = errors.New("agent ready timeout")

// ReadyWaiter blocks the caller until an agent container is ready to
// receive input on its NATS subjects. It subscribes to TopicAgentReady
// before the container is started and resolves when the agent-runner
// publishes its ready marker — which it does AFTER flushing its input/
// control/route subscriptions to the broker.
//
// This avoids the cross-agent race in the previous NumClients()-based
// implementation, where the first concurrent agent's connection would
// satisfy every concurrent waiter regardless of which agent it was.
//
// PrepareReadyWaiter must be called BEFORE the container is started so
// the subscription is registered with the broker first; otherwise the
// agent could publish ready into the void and the waiter would block
// until timeout. Callers MUST Close the waiter when done (defer is fine).
type ReadyWaiter struct {
	sub     *nats.Subscription
	ch      chan struct{}
	agentID string
}

// PrepareReadyWaiter subscribes to the agent's ready topic and returns a
// waiter that resolves on the first ready signal.
func PrepareReadyWaiter(client *Client, agentID string) (*ReadyWaiter, error) {
	ch := make(chan struct{}, 1)
	sub, err := client.Subscribe(TopicAgentReady(agentID), func(*nats.Msg) {
		select {
		case ch <- struct{}{}:
		default:
		}
	})
	if err != nil {
		return nil, fmt.Errorf("subscribe to ready: %w", err)
	}
	// Flush so the subscription is registered with the broker before the
	// caller starts the container. Without this, an agent that publishes
	// ready very quickly could race the subscription registration.
	if err := client.Flush(); err != nil {
		_ = sub.Unsubscribe()
		return nil, fmt.Errorf("flush ready subscription: %w", err)
	}
	return &ReadyWaiter{sub: sub, ch: ch, agentID: agentID}, nil
}

// Wait blocks until the agent is ready, the timeout elapses, or ctx is
// cancelled. Returns nil on success, ErrReadyTimeout on timeout, or
// ctx.Err() on cancellation.
func (w *ReadyWaiter) Wait(ctx context.Context, timeout time.Duration) error {
	select {
	case <-w.ch:
		slog.Info("agent container ready", "agent", w.agentID)
		return nil
	case <-time.After(timeout):
		slog.Warn("agent ready timeout", "agent", w.agentID)
		return ErrReadyTimeout
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Close unsubscribes the underlying ready subscription. Safe to call
// multiple times.
func (w *ReadyWaiter) Close() {
	if w.sub != nil {
		_ = w.sub.Unsubscribe()
		w.sub = nil
	}
}
