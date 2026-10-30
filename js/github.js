// Minimal GitHub client for the private data repository. Runs in the browser on both devices.

const CONFIG_KEY = 'syncConfig';

/** { owner, repo, token, pages } – stored per device, never synced. */
export function getConfig() {
  try {
    return JSON.parse(localStorage.getItem(CONFIG_KEY)) || null;
  } catch (e) {
    return null;
  }
}

export function setConfig(cfg) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}

export function clearConfig() {
  localStorage.removeItem(CONFIG_KEY);
}

export class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const encodePath = p => p.split('/').map(encodeURIComponent).join('/');

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function request(path, { method = 'GET', body, raw = false } = {}) {
  const cfg = getConfig();
  if (!cfg) throw new GitHubError(0, 'Sync is not set up');
  const base = cfg.apiBase || 'https://api.github.com';
  // no-store: the API allows 60 s of caching, which would hide what the other device just wrote
  const res = await fetch(`${base}/repos/${cfg.owner}/${cfg.repo}${path}`, {
    method,
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      message = (await res.json()).message || message;
    } catch (e) { /* no JSON body */ }
    throw new GitHubError(res.status, message);
  }
  return raw ? res.text() : res.json();
}

/** Check that the token can read and write the repository. */
export async function checkAccess() {
  const repo = await request('');
  if (!repo.private) throw new GitHubError(0, `"${repo.full_name}" is public. Your courses must stay private: make the repository private first.`);
  if (repo.permissions && !repo.permissions.push) throw new GitHubError(0, 'The token cannot write to this repository (it needs Contents: Read and write).');
  return repo;
}

/** { text, sha } of a file, or null if it does not exist yet. */
export async function getFile(path) {
  let meta;
  try {
    meta = await request(`/contents/${encodePath(path)}`);
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
  return { sha: meta.sha, text: await request(`/git/blobs/${meta.sha}`, { raw: true }) };
}

/** Create or update a file. Throws GitHubError 409/422 if `sha` is no longer the current version. */
export async function putFile(path, text, sha, message) {
  const res = await request(`/contents/${encodePath(path)}`, {
    method: 'PUT',
    body: { message, content: toBase64(text), ...(sha ? { sha } : {}) },
  });
  return res.content.sha;
}

/** Map of path -> blob sha for all files in the repository. */
export async function listFiles() {
  const res = await request('/git/trees/HEAD?recursive=1');
  return new Map(res.tree.filter(e => e.type === 'blob').map(e => [e.path, e.sha]));
}

export const getBlob = sha => request(`/git/blobs/${sha}`, { raw: true });

/** One commit that writes `files` (path -> text) and removes `remove` (paths). */
export async function commitFiles(files, remove, message) {
  const repo = await request('');
  const branch = repo.default_branch;
  let ref;
  try {
    ref = await request(`/git/ref/heads/${encodeURIComponent(branch)}`);
  } catch (e) {
    if (e.status !== 409 && e.status !== 404) throw e;
    // a brand-new, empty repository has no commit to build on yet
    await putFile('README.md', 'Private data of the Opening Trainer app.\n', null, 'Start');
    ref = await request(`/git/ref/heads/${encodeURIComponent(branch)}`);
  }
  const parent = await request(`/git/commits/${ref.object.sha}`);
  const tree = await request('/git/trees', {
    method: 'POST',
    body: {
      base_tree: parent.tree.sha,
      tree: [
        ...Object.entries(files).map(([path, content]) => ({ path, mode: '100644', type: 'blob', content })),
        ...remove.map(path => ({ path, mode: '100644', type: 'blob', sha: null })),
      ],
    },
  });
  const commit = await request('/git/commits', {
    method: 'POST', body: { message, tree: tree.sha, parents: [ref.object.sha] },
  });
  await request(`/git/refs/heads/${encodeURIComponent(branch)}`, { method: 'PATCH', body: { sha: commit.sha } });
}
