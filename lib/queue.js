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
  constructor(options = {}) {
    this._tail = Promise.resolve();
    this._activeCount = 0;
    this._waitingCount = 0;
    this.maxDepth = options.maxDepth ?? (parseInt(process.env.GLMP_QUEUE_MAX_DEPTH, 10) || 50);
  }

  get activeCount() {
    return this._activeCount;
  }

  get waitingCount() {
    return this._waitingCount;
  }

  /**
   * Enqueues an execution slot.
   * Resolves with a `release` function when the slot is ready.
   * Call `release()` when the upstream response stream completes (ends or errors).
   *
   * @returns {Promise<() => void>} release callback
   */
  async acquire() {
    if (process.env.GLMP_QUEUE === "0") {
      return () => {};
    }

    if (this._waitingCount >= this.maxDepth) {
      throw Object.assign(
        new Error(`In-flight queue depth exceeded limit (${this.maxDepth})`),
        { code: "QUEUE_OVERFLOW", status: 429 }
      );
    }

    this._waitingCount++;
    let releaseLock;
    const nextLock = new Promise((resolve) => { releaseLock = resolve; });
    const currentTail = this._tail;
    // Always attach via catch to prevent prior unhandled rejections from poisoning the queue
    this._tail = currentTail.catch(() => {}).then(() => nextLock);

    try {
      await currentTail;
    } catch (_) {
      // Prior job error should never prevent the next job from acquiring
    } finally {
      this._waitingCount--;
    }

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
