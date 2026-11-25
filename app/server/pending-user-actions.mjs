// These maps are the managers' actual live request registries (not a second queue).
// The desktop needs only one bit, even when different sessions or teams are waiting.
export function createPendingUserActionQueues(onChange) {
  let waiting = false;
  function refresh() {
    const next = queues.some(queue => queue.size > 0);
    if (next === waiting) return;
    waiting = next;
    try { onChange(next); } catch { /* A desktop indicator must not affect the request. */ }
  }
  class PendingMap extends Map {
    set(id, entry) { super.set(id, entry); refresh(); return this; }
    delete(id) { const removed = super.delete(id); if (removed) refresh(); return removed; }
    clear() { super.clear(); refresh(); }
  }
  const Queue = typeof onChange === 'function' ? PendingMap : Map;
  const queues = [new Queue(), new Queue(), new Queue()];
  const [approvals, questions, teamConfigurations] = queues;
  return { approvals, questions, teamConfigurations };
}
