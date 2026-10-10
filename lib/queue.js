/**
 * In-flight request serializer (FIFO queue / Mutex).
 *
 * Upstream AutoClaw (autoglm-api.autoglm.ai) strictly limits accounts to
 * 1 concurrent active generation. Parallel requests (e.g. from subagents,
 * background tools, or simultaneous turns) are rejected by upstream with HTTP 406.
 *
 * This queue ensures that overlapping requests wait in-process until the previous
 * generation stream completes, then immediately dispatch to upstream.
 */
export class InFlightQueue {
  constructor() {
    this._tail = Promise.resolve();
    this._activeCount = 0;
  }

  get activeCount() {
    return this._activeCount;
  }

  /**
   * Enqueues an execution slot.
   * Resolves with a `release` function when the slot is ready.
   * Call `release()` when the upstream response stream completes (ends or errors).
   *
   * @returns {Promise<() => void>} release callback
   */
  async acquire() {
    let releaseLock;
    const nextLock = new Promise((resolve) => { releaseLock = resolve; });
    const currentTail = this._tail;
    this._tail = currentTail.then(() => nextLock);

    await currentTail;
    this._activeCount++;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this._activeCount--;
      releaseLock();
    };
  }
}

// Global shared queue instance across entrypoints
export const globalInFlightQueue = new InFlightQueue();
