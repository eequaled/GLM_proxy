import assert from "node:assert/strict";
import { InFlightQueue } from "../lib/queue.js";

async function testQueueSequential() {
  const q = new InFlightQueue();
  const order = [];

  async function job(id, durationMs) {
    const release = await q.acquire();
    order.push(`start-${id}`);
    await new Promise((r) => setTimeout(r, durationMs));
    order.push(`end-${id}`);
    release();
  }

  await Promise.all([job(1, 40), job(2, 20), job(3, 10)]);

  assert.deepEqual(order, [
    "start-1", "end-1",
    "start-2", "end-2",
    "start-3", "end-3",
  ]);
  assert.equal(q.activeCount, 0);
  console.log("  ✓ in-flight queue serializes concurrent jobs strictly in FIFO order");
}

async function testQueueErrorSafety() {
  const q = new InFlightQueue();
  let job2Ran = false;

  async function job1() {
    const release = await q.acquire();
    try {
      throw new Error("fail");
    } finally {
      release();
    }
  }

  async function job2() {
    const release = await q.acquire();
    job2Ran = true;
    release();
  }

  await assert.rejects(job1(), /fail/);
  await job2();

  assert.equal(job2Ran, true);
  assert.equal(q.activeCount, 0);
  console.log("  ✓ in-flight queue releases lock even if an in-flight job throws");
}

async function testQueuePoisonResistance() {
  const q = new InFlightQueue();
  // Simulate a rejected promise directly on _tail
  q._tail = Promise.reject(new Error("unhandled upstream crash"));
  // Next acquire should not reject
  const release = await q.acquire();
  assert.equal(typeof release, "function");
  release();
  console.log("  ✓ in-flight queue recovers cleanly if previous tail promise rejected");
}

async function testQueueDisableToggle() {
  process.env.GLMP_QUEUE = "0";
  try {
    const q = new InFlightQueue();
    const release = await q.acquire();
    assert.equal(typeof release, "function");
    release();
    assert.equal(q.activeCount, 0);
    console.log("  ✓ GLMP_QUEUE=0 disables queuing and yields no-op release");
  } finally {
    delete process.env.GLMP_QUEUE;
  }
}

(async () => {
  await testQueueSequential();
  await testQueueErrorSafety();
  await testQueuePoisonResistance();
  await testQueueDisableToggle();
})();
