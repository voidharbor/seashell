/**
 * The native shell starts the bundled node with LD_LIBRARY_PATH pointing at
 * the libraries it carries beside it (libatomic, which minimal distros lack;
 * core_proc.cpp, fetch-node.sh) and names that folder in SEASHELL_NODE_LIB.
 * The loader has read it by the time any JS runs, so both come out of
 * process.env here, before anything copies it: no pane or child inherits them.
 * Imported first by index.ts for that reason.
 */
export function scrubNodeLib(env: NodeJS.ProcessEnv): void {
  const lib = env.SEASHELL_NODE_LIB
  if (lib === undefined) return
  delete env.SEASHELL_NODE_LIB
  const kept = (env.LD_LIBRARY_PATH ?? '').split(':').filter((entry) => entry !== '' && entry !== lib)
  if (kept.length > 0) env.LD_LIBRARY_PATH = kept.join(':')
  else delete env.LD_LIBRARY_PATH
}

scrubNodeLib(process.env)
