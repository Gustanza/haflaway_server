// A tiny semaphore — caps how many render jobs (each one a full headless
// Chromium instance) run at once. See src/config.js for how the limit itself
// is derived from the VPS's RAM.
function createLimiter(maxConcurrent) {
  let active = 0
  const queue = []

  function next() {
    if (active >= maxConcurrent || queue.length === 0) return
    active++
    const { fn, resolve, reject } = queue.shift()
    fn().then(resolve, reject).finally(() => {
      active--
      next()
    })
  }

  return function run(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject })
      next()
    })
  }
}

module.exports = { createLimiter }
