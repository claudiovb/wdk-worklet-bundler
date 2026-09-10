/** Shared lifecycle wiring for both IPC transports. */
export function generateLifecycleCode (): string {
  return `
function runLifecycle (resource, method) {
  try {
    if (!resource || typeof resource[method] !== 'function') return
    Promise.resolve(resource[method]()).catch((error) => {
      logger.error('Worklet lifecycle ' + method + ' failed:', error)
    })
  } catch (error) {
    logger.error('Worklet lifecycle ' + method + ' failed:', error)
  }
}

function runHttpLifecycle (method) {
  // Bare's public require.cache contains the modules the wallet HTTP stack
  // actually loaded, including nested package versions and lazy imports.
  // Reading it adds no HTTP dependency to bare-pack's static module graph.
  const seen = new Set()
  for (const [url, loaded] of Object.entries(require.cache)) {
    if (!url.endsWith('/bare-http1/index.js') && !url.endsWith('/bare-https/index.js')) continue
    const agent = loaded.exports && loaded.exports.globalAgent
    if (!agent || seen.has(agent)) continue
    seen.add(agent)
    runLifecycle(agent, method)
  }
}

if (typeof Bare !== 'undefined' && Bare.on) {
  Bare.on('suspend', () => {
    runHttpLifecycle('suspend')
    runLifecycle(context.moduleRuntime, 'suspendAll')
  })
  Bare.on('resume', () => {
    runHttpLifecycle('resume')
    runLifecycle(context.moduleRuntime, 'resumeAll')
  })
}
`
}
