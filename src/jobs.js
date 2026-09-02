import crypto from 'node:crypto';

/**
 * Background jobs: scan, sync, verify.
 *
 * These run for minutes on a large library, so the HTTP layer starts one and
 * hands back an id to poll. One job per type at a time — two concurrent scans
 * of the same drive would fight over the same rows and finish slower than one.
 */

const KEEP_FINISHED = 20;

export class JobManager {
  constructor() {
    this.jobs = new Map();
  }

  /** The running job of this type, if there is one. */
  active(type) {
    for (const job of this.jobs.values()) {
      if (job.type === type && job.status === 'running') return job;
    }
    return null;
  }

  start(type, run) {
    const existing = this.active(type);
    if (existing) return existing;

    const controller = new AbortController();
    const job = {
      id: crypto.randomUUID(),
      type,
      status: 'running',
      progress: { phase: 'starting', processed: 0, total: 0, current: null },
      result: null,
      error: null,
      startedAt: Date.now(),
      finishedAt: null,
    };
    this.jobs.set(job.id, job);
    this.prune();

    const onProgress = (progress) => {
      if (job.status === 'running') job.progress = { ...job.progress, ...progress };
    };

    Promise.resolve()
      .then(() => run({ onProgress, signal: controller.signal }))
      .then((result) => {
        job.status = 'done';
        job.result = result ?? null;
      })
      .catch((err) => {
        job.status = err?.cancelled || controller.signal.aborted ? 'cancelled' : 'error';
        job.error = err?.message ?? String(err);
      })
      .finally(() => {
        job.finishedAt = Date.now();
        job.controller = null;
      });

    job.controller = controller;
    return job;
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'running') return false;
    job.controller?.abort();
    return true;
  }

  cancelAll() {
    for (const job of this.jobs.values()) {
      if (job.status === 'running') job.controller?.abort();
    }
  }

  get(id) {
    return this.jobs.get(id) ?? null;
  }

  list() {
    return [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt).map(publicView);
  }

  prune() {
    const finished = [...this.jobs.values()]
      .filter((job) => job.status !== 'running')
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
    for (const job of finished.slice(KEEP_FINISHED)) this.jobs.delete(job.id);
  }
}

/** Strip the AbortController before a job crosses the API boundary. */
export function publicView(job) {
  if (!job) return null;
  const { controller, ...rest } = job;
  return rest;
}
