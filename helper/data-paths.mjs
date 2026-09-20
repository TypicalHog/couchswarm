import os from 'node:os';
import path from 'node:path';

// Where a helper keeps a host's movies and the log of what went wrong. Windows puts both under the one per-user
// folder helper/Launcher.cs already names and writes its own log to; everywhere else the XDG base directories
// split downloaded data from state, and their published defaults are the folders a desktop Linux expects.
// A relative XDG value is ignored, as the specification says to: resolved against the helper's own directory it
// would put movies inside the package an update replaces.
const folder = (variable, ...fallback) => {
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'CouchSwarm');
  const base = process.env[variable] || '';
  return path.join(path.isAbsolute(base) ? base : path.join(os.homedir(), ...fallback), 'CouchSwarm');
};
export const defaultDownloads = path.join(folder('XDG_DATA_HOME', '.local', 'share'), 'downloads');
export const helperLog = path.join(folder('XDG_STATE_HOME', '.local', 'state'), 'helper.log');
