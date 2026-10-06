// Vendored from 0xB10C/fork-observer (MIT License, Copyright (c) 2021 0xB10C):
//   www/js/main.js   STRATUM_JOB_TTL_MS (:359), stratum feed parser (:389-393), record_stratum_job (:415-424)
//   www/js/blocktree.js  expiry of pools whose last_seen is older than STRATUM_JOB_TTL_MS (:444-447)
// Behaviour is kept equivalent; the only change is an injectable clock so tests can simulate time.
export const STRATUM_JOB_TTL_MS = 120000;

export function createForkObserver({ now = () => Date.now() } = {}) {
  const state_stratum_jobs = new Map();
  function stratum_prevhash_to_display(hex) {
    const words = [];
    for (let i = 0; i < hex.length; i += 8) words.push(hex.slice(i, i + 8));
    return words.reverse().join('');
  }
  const parse = job => job == null || !job.prev_hash || !job.pool_name ? null : {
    pool_name: job.pool_name, prev_hash: stratum_prevhash_to_display(job.prev_hash), height: job.height,
  };
  function record_stratum_job(job) {
    let known = false;
    state_stratum_jobs.forEach(other => { if (other.prev_hash == job.prev_hash) known = true; });
    state_stratum_jobs.set(job.pool_name, { prev_hash: job.prev_hash, height: job.height, last_seen: now() });
    return !known;
  }
  function handle(data) {
    let job; try { job = JSON.parse(data); } catch (_) { return; }
    const parsed = parse(job); if (parsed === null) return;
    record_stratum_job(parsed);
  }
  function expire() {
    const t = now();
    state_stratum_jobs.forEach((job, pool_name) => {
      if (t - job.last_seen > STRATUM_JOB_TTL_MS) state_stratum_jobs.delete(pool_name);
    });
  }
  return { handle, expire, state: state_stratum_jobs };
}
