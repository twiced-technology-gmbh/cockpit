// Pipeline Controller UI

let currentTab = 'runs';
let expandedRunId = null;
let autoRefreshTimer = null;

// --- API helpers ---

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

// --- Toast ---

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<i class="fas fa-${type === 'success' ? 'check-circle' : type === 'error' ? 'exclamation-circle' : 'info-circle'}"></i> ${escapeHtml(message)}`;
  container.appendChild(el);
  setTimeout(() => { el.remove(); }, 4000);
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// --- Tab switching ---

document.querySelectorAll('.tab[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => {
    switchTab(btn.dataset.tab);
  });
});

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('tab-runs').classList.toggle('hidden', tab !== 'runs');
  document.getElementById('tab-projects').classList.toggle('hidden', tab !== 'projects');
  document.getElementById('tab-gateways').classList.toggle('hidden', tab !== 'gateways');
  refreshCurrentTab();
}

// --- Refresh ---

function refreshCurrentTab() {
  if (currentTab === 'runs') loadRuns();
  else if (currentTab === 'projects') loadProjects();
  else if (currentTab === 'gateways') loadGateways();
}

function startAutoRefresh() {
  clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(refreshCurrentTab, 30000);
}

// --- Time helpers ---

function formatDuration(startStr, endStr) {
  if (!startStr) return '-';
  const start = new Date(startStr + 'Z');
  const end = endStr ? new Date(endStr + 'Z') : new Date();
  const diffMs = end - start;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

function formatTime(str) {
  if (!str) return '-';
  const d = new Date(str + 'Z');
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// --- State badge ---

function stateClass(state) {
  if (state === 'DONE') return 'pipeline-state-done';
  if (state === 'FAILED') return 'pipeline-state-failed';
  if (state === 'AWAITING_MERGE' || state === 'MERGED') return 'pipeline-state-merge';
  if (['DEVELOPING', 'REVIEWING', 'TESTING', 'DEPLOYING', 'VERIFYING', 'WORKTREE_SETUP', 'DEV_COMPLETE', 'REVIEW_DECIDED', 'TEST_DECIDED', 'CLEANUP'].includes(state)) return 'pipeline-state-active';
  if (state === 'RECEIVED') return 'pipeline-state-idle';
  return 'pipeline-state-idle';
}

function stateBadge(state) {
  return `<span class="pipeline-state ${stateClass(state)}">${escapeHtml(state)}</span>`;
}

// --- Pipeline Runs ---

async function loadRuns() {
  const loading = document.getElementById('runs-loading');
  const content = document.getElementById('runs-content');

  try {
    const [runs, stats, stuck] = await Promise.all([
      api('/runs'),
      api('/stats'),
      api('/stuck'),
    ]);

    renderStats(stats);
    renderStuckBanner(stuck);
    renderRuns(runs);

    loading.classList.add('hidden');
    content.classList.remove('hidden');
  } catch (err) {
    loading.innerHTML = `<div class="info-box info-box-red"><i class="fas fa-exclamation-triangle"></i> Failed to load: ${escapeHtml(err.message)}</div>`;
  }
}

function renderStats(stats) {
  const bar = document.getElementById('stats-bar');
  const rbs = stats.runsByState || {};
  const total = Object.values(rbs).reduce((a, b) => a + b, 0);
  const active = Object.entries(rbs)
    .filter(([s]) => s !== 'DONE' && s !== 'FAILED')
    .reduce((a, [, v]) => a + v, 0);

  bar.innerHTML = `
    <div class="pipeline-stat">
      <div><div class="pipeline-stat-value">${total}</div><div class="pipeline-stat-label">Total</div></div>
    </div>
    <div class="pipeline-stat">
      <div><div class="pipeline-stat-value" style="color:#60a5fa;">${active}</div><div class="pipeline-stat-label">Active</div></div>
    </div>
    <div class="pipeline-stat">
      <div><div class="pipeline-stat-value" style="color:#4ade80;">${rbs.DONE || 0}</div><div class="pipeline-stat-label">Completed</div></div>
    </div>
    <div class="pipeline-stat">
      <div><div class="pipeline-stat-value" style="color:#f87171;">${rbs.FAILED || 0}</div><div class="pipeline-stat-label">Failed</div></div>
    </div>
  `;
}

function renderStuckBanner(stuck) {
  const banner = document.getElementById('stuck-banner');
  if (!stuck.stuck || stuck.stuck.length === 0) {
    banner.classList.add('hidden');
    return;
  }
  banner.classList.remove('hidden');
  banner.innerHTML = `<div class="pipeline-stuck-banner flex items-center gap-2">
    <i class="fas fa-exclamation-triangle" style="color:#fde047;"></i>
    <span class="text-sm" style="color:#fde047;">${stuck.count} stuck run(s) detected</span>
    <span class="text-xs text-secondary" style="margin-left:8px;">${stuck.stuck.map(s => escapeHtml(s.reason)).join('; ')}</span>
  </div>`;
}

function renderRuns(runs) {
  const tbody = document.getElementById('runs-tbody');
  const empty = document.getElementById('runs-empty');

  if (!runs.length) {
    tbody.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  tbody.innerHTML = runs.map(run => {
    const isExpanded = expandedRunId === run.id;
    return `
      <tr class="pipeline-run-row" onclick="toggleRunExpand('${run.id}')">
        <td data-label=""><i class="fas fa-chevron-${isExpanded ? 'down' : 'right'}" style="font-size:10px;color:var(--text-secondary);"></i></td>
        <td data-label="Issue">${escapeHtml(run.issue_id)}</td>
        <td data-label="Project">${escapeHtml(run.project)}</td>
        <td data-label="State">${stateBadge(run.state)}</td>
        <td data-label="Branch">${run.branch ? `<code style="font-size:11px;">${escapeHtml(run.branch)}</code>` : '-'}</td>
        <td data-label="PR">${run.pr_url ? `<a href="${escapeHtml(run.pr_url)}" target="_blank" class="accent-link" onclick="event.stopPropagation();">PR</a>` : '-'}</td>
        <td data-label="Started">${formatTime(run.created_at)}</td>
        <td data-label="Duration">${formatDuration(run.created_at, run.state === 'DONE' || run.state === 'FAILED' ? run.updated_at : null)}</td>
        <td data-label="Actions" onclick="event.stopPropagation();">
          ${run.state === 'FAILED' ? `<button class="btn btn-red" style="padding:3px 8px;font-size:11px;" onclick="retryRun('${run.id}')"><i class="fas fa-redo"></i> Retry</button>` : ''}
          ${run.state === 'AWAITING_MERGE' ? `<button class="btn btn-green" style="padding:3px 8px;font-size:11px;" onclick="approveMerge('${run.id}')"><i class="fas fa-code-merge"></i> Merge</button>` : ''}
        </td>
      </tr>
      <tr class="pipeline-expand-row ${isExpanded ? '' : 'hidden'}" id="expand-${run.id}">
        <td colspan="9">
          <div class="pipeline-expand-content" id="expand-content-${run.id}">
            ${isExpanded ? '<div class="loading-state" style="padding:12px;"><div class="spinner" style="margin:0 auto;width:20px;height:20px;"></div></div>' : ''}
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

async function toggleRunExpand(runId) {
  if (expandedRunId === runId) {
    expandedRunId = null;
    refreshCurrentTab();
    return;
  }

  expandedRunId = runId;
  refreshCurrentTab();

  try {
    const run = await api(`/runs/${runId}`);
    const container = document.getElementById(`expand-content-${runId}`);
    if (!container) return;

    if (!run.tasks || run.tasks.length === 0) {
      container.innerHTML = '<div class="text-xs text-secondary" style="padding:8px 0;">No agent tasks yet.</div>';
      return;
    }

    container.innerHTML = `
      <table class="dark-table" style="background:transparent;">
        <thead>
          <tr>
            <th>Stage</th>
            <th>Focus</th>
            <th>Model</th>
            <th>Status</th>
            <th>tmux</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody>
          ${run.tasks.map(t => `
            <tr>
              <td data-label="Stage">${escapeHtml(t.stage)}</td>
              <td data-label="Focus">${t.focus ? escapeHtml(t.focus) : '-'}</td>
              <td data-label="Model"><code style="font-size:11px;">${escapeHtml(t.model)}</code></td>
              <td data-label="Status">${taskStatusBadge(t.status, t.result)}</td>
              <td data-label="tmux">${t.tmux_session ? `<code style="font-size:11px;">${escapeHtml(t.tmux_session)}</code>` : '-'}</td>
              <td data-label="Duration">${formatDuration(t.started_at, t.completed_at)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } catch (err) {
    const container = document.getElementById(`expand-content-${runId}`);
    if (container) container.innerHTML = `<div class="info-box info-box-red text-xs">Failed to load tasks: ${escapeHtml(err.message)}</div>`;
  }
}

function taskStatusBadge(status, result) {
  if (status === 'running') return '<span class="pipeline-state pipeline-state-active">running</span>';
  if (status === 'completed' || status === 'success') {
    if (result === 'failure') return '<span class="pipeline-state pipeline-state-failed">failed</span>';
    return '<span class="pipeline-state pipeline-state-done">success</span>';
  }
  if (status === 'failed') return '<span class="pipeline-state pipeline-state-failed">failed</span>';
  return `<span class="pipeline-state pipeline-state-idle">${escapeHtml(status || 'pending')}</span>`;
}

async function retryRun(runId) {
  try {
    await api(`/runs/${runId}/retry`, { method: 'POST' });
    showToast('Run retried', 'success');
    loadRuns();
  } catch (err) {
    showToast(`Retry failed: ${err.message}`, 'error');
  }
}

async function approveMerge(runId) {
  try {
    await api(`/runs/${runId}/approve-merge`, { method: 'POST' });
    showToast('Merge approved', 'success');
    loadRuns();
  } catch (err) {
    showToast(`Merge failed: ${err.message}`, 'error');
  }
}

// --- Projects ---

async function loadProjects() {
  const loading = document.getElementById('projects-loading');
  const content = document.getElementById('projects-content');

  try {
    const projects = await api('/projects');
    loading.classList.add('hidden');
    content.classList.remove('hidden');
    renderProjects(projects);
  } catch (err) {
    loading.innerHTML = `<div class="info-box info-box-red"><i class="fas fa-exclamation-triangle"></i> Failed to load: ${escapeHtml(err.message)}</div>`;
  }
}

function renderProjects(projects) {
  const content = document.getElementById('projects-content');

  if (!projects.length) {
    content.innerHTML = `
      <div class="flex justify-between items-center mb-3">
        <span></span>
        <button class="btn btn-green" onclick="openProjectModal()"><i class="fas fa-plus"></i> Add Project</button>
      </div>
      <div class="surface rounded-lg">
        <div class="empty-state">
          <i class="fas fa-folder-open"></i>
          <h3>No projects configured</h3>
          <p>Add a project to get started.</p>
        </div>
      </div>
    `;
    return;
  }

  content.innerHTML = `
    <div class="flex justify-between items-center mb-3">
      <span class="text-xs text-secondary">${projects.length} project(s)</span>
      <button class="btn btn-green" onclick="openProjectModal()"><i class="fas fa-plus"></i> Add Project</button>
    </div>
    ${projects.map(p => renderProjectCard(p)).join('')}
  `;
}

function renderProjectCard(project) {
  const focuses = project.reviewConfig?.focuses || [];
  const repos = project.repos || [];

  return `
    <div class="surface rounded-lg mb-3">
      <div style="padding:12px 16px;border-bottom:1px solid var(--border);" class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <i class="fas fa-folder" style="color:#60a5fa;font-size:13px;"></i>
          <span class="text-sm font-medium text-emphasis">${escapeHtml(project.project)}</span>
          <span class="text-xs text-secondary">Linear: ${escapeHtml(project.linearTeamId)}</span>
        </div>
        <div class="flex gap-1">
          <button class="icon-btn icon-btn-blue" data-tooltip="Add Repo" onclick="openRepoModal('${escapeHtml(project.project)}')">
            <i class="fas fa-plus" style="font-size:10px;"></i>
          </button>
          <button class="icon-btn icon-btn-neutral" data-tooltip="Edit" onclick="openProjectModal('${escapeHtml(project.project)}')">
            <i class="fas fa-pencil-alt" style="font-size:10px;"></i>
          </button>
          <button class="icon-btn icon-btn-red" data-tooltip="Delete" onclick="deleteProject('${escapeHtml(project.project)}')">
            <i class="fas fa-trash" style="font-size:10px;"></i>
          </button>
        </div>
      </div>
      <div style="padding:12px 16px;">
        ${focuses.length ? `<div class="mb-2 flex gap-1" style="flex-wrap:wrap;">${focuses.map(f => `<span class="tag">${escapeHtml(f)}</span>`).join('')}</div>` : ''}
        ${repos.length ? `
          <table class="dark-table mt-2">
            <thead><tr><th>Path</th><th>Repo URL</th><th>Branch</th><th></th><th></th></tr></thead>
            <tbody>
              ${repos.map(r => `
                <tr>
                  <td data-label="Path"><code style="font-size:11px;">${escapeHtml(r.path)}</code></td>
                  <td data-label="Repo">${r.repoUrl ? `<a href="${escapeHtml(r.repoUrl)}" target="_blank" class="accent-link">${escapeHtml(r.repoUrl.replace('https://github.com/', ''))}</a>` : '-'}</td>
                  <td data-label="Branch">${escapeHtml(r.defaultBranch)}</td>
                  <td data-label="">${r.isPrimary ? '<span class="primary-badge">PRIMARY</span>' : ''}</td>
                  <td data-label="">
                    <button class="icon-btn icon-btn-red" style="width:22px;height:22px;" data-tooltip="Remove" onclick="deleteRepo('${escapeHtml(project.project)}','${escapeHtml(r.path)}')">
                      <i class="fas fa-times" style="font-size:9px;"></i>
                    </button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        ` : '<div class="text-xs text-secondary">No repositories configured.</div>'}
      </div>
    </div>
  `;
}

function openProjectModal(projectName) {
  const modal = document.getElementById('project-modal');
  const title = document.getElementById('project-modal-title');
  const nameInput = document.getElementById('project-name');
  const originalInput = document.getElementById('project-edit-original');

  if (projectName) {
    title.textContent = 'Edit Project';
    originalInput.value = projectName;
    nameInput.value = projectName;
    nameInput.disabled = true;
    api(`/projects/${projectName}`).then(p => {
      document.getElementById('project-linear-team').value = p.linearTeamId || '';
      document.getElementById('project-repo-url').value = p.repoUrl || '';
      document.getElementById('project-default-branch').value = p.defaultBranch || 'main';
      document.getElementById('project-review-focuses').value = (p.reviewConfig?.focuses || []).join(', ');
    });
  } else {
    title.textContent = 'Add Project';
    originalInput.value = '';
    nameInput.value = '';
    nameInput.disabled = false;
    document.getElementById('project-linear-team').value = '';
    document.getElementById('project-repo-url').value = '';
    document.getElementById('project-default-branch').value = 'main';
    document.getElementById('project-review-focuses').value = 'security, quality, fulfillment';
  }

  modal.classList.remove('hidden');
}

async function saveProject() {
  const original = document.getElementById('project-edit-original').value;
  const project = document.getElementById('project-name').value.trim();
  const linearTeamId = document.getElementById('project-linear-team').value.trim();
  const repoUrl = document.getElementById('project-repo-url').value.trim();
  const defaultBranch = document.getElementById('project-default-branch').value.trim() || 'main';
  const focuses = document.getElementById('project-review-focuses').value.split(',').map(s => s.trim()).filter(Boolean);

  if (!project || !linearTeamId) {
    showToast('Project name and Linear Team ID are required', 'error');
    return;
  }

  const body = { project, linearTeamId, repoUrl, defaultBranch, reviewConfig: { focuses } };

  try {
    if (original) {
      await api(`/projects/${original}`, { method: 'PUT', body: JSON.stringify(body) });
      showToast('Project updated', 'success');
    } else {
      await api('/projects', { method: 'POST', body: JSON.stringify(body) });
      showToast('Project created', 'success');
    }
    closeModal('project-modal');
    loadProjects();
  } catch (err) {
    showToast(`Save failed: ${err.message}`, 'error');
  }
}

async function deleteProject(projectName) {
  if (!confirm(`Delete project "${projectName}"? This cannot be undone.`)) return;
  try {
    await api(`/projects/${projectName}`, { method: 'DELETE' });
    showToast('Project deleted', 'success');
    loadProjects();
  } catch (err) {
    showToast(`Delete failed: ${err.message}`, 'error');
  }
}

function openRepoModal(projectName) {
  document.getElementById('repo-project-name').value = projectName;
  document.getElementById('repo-path').value = '';
  document.getElementById('repo-url').value = '';
  document.getElementById('repo-default-branch').value = 'main';
  document.getElementById('repo-is-primary').checked = false;
  document.getElementById('repo-modal').classList.remove('hidden');
}

async function saveRepo() {
  const project = document.getElementById('repo-project-name').value;
  const path = document.getElementById('repo-path').value.trim();
  const repoUrl = document.getElementById('repo-url').value.trim();
  const defaultBranch = document.getElementById('repo-default-branch').value.trim() || 'main';
  const isPrimary = document.getElementById('repo-is-primary').checked;

  if (!path || !repoUrl) {
    showToast('Path and Repo URL are required', 'error');
    return;
  }

  try {
    await api(`/projects/${project}/repos`, {
      method: 'POST',
      body: JSON.stringify({ path, repoUrl, isPrimary, defaultBranch }),
    });
    showToast('Repository added', 'success');
    closeModal('repo-modal');
    loadProjects();
  } catch (err) {
    showToast(`Add failed: ${err.message}`, 'error');
  }
}

async function deleteRepo(project, path) {
  if (!confirm(`Remove repo "${path}" from ${project}?`)) return;
  try {
    await api(`/projects/${project}/repos`, {
      method: 'DELETE',
      body: JSON.stringify({ path }),
    });
    showToast('Repository removed', 'success');
    loadProjects();
  } catch (err) {
    showToast(`Remove failed: ${err.message}`, 'error');
  }
}

// --- Gateways ---

async function loadGateways() {
  const loading = document.getElementById('gateways-loading');
  const content = document.getElementById('gateways-content');

  try {
    const gateways = await api('/gateways');
    loading.classList.add('hidden');
    content.classList.remove('hidden');
    renderGateways(gateways);
    checkGatewayHealth(gateways);
  } catch (err) {
    loading.innerHTML = `<div class="info-box info-box-red"><i class="fas fa-exclamation-triangle"></i> Failed to load: ${escapeHtml(err.message)}</div>`;
  }
}

function renderGateways(gateways) {
  const content = document.getElementById('gateways-content');

  if (!gateways.length) {
    content.innerHTML = `
      <div class="flex justify-between items-center mb-3">
        <span></span>
        <button class="btn btn-green" onclick="openGatewayModal()"><i class="fas fa-plus"></i> Add Gateway</button>
      </div>
      <div class="surface rounded-lg">
        <div class="empty-state">
          <i class="fas fa-network-wired"></i>
          <h3>No gateways configured</h3>
          <p>Add a gateway to connect to OpenClaw.</p>
        </div>
      </div>
    `;
    return;
  }

  content.innerHTML = `
    <div class="flex justify-between items-center mb-3">
      <span class="text-xs text-secondary">${gateways.length} gateway(s)</span>
      <button class="btn btn-green" onclick="openGatewayModal()"><i class="fas fa-plus"></i> Add Gateway</button>
    </div>
    <div class="surface rounded-lg overflow-x-auto">
      <table class="dark-table">
        <thead>
          <tr>
            <th>Role</th>
            <th>VM Host</th>
            <th>Port</th>
            <th>Status</th>
            <th>ttyd</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${gateways.map(gw => `
            <tr>
              <td data-label="Role"><span class="text-emphasis font-medium">${escapeHtml(gw.role)}</span></td>
              <td data-label="VM Host"><code style="font-size:11px;">${escapeHtml(gw.vmHost)}</code></td>
              <td data-label="Port">${gw.gatewayPort}</td>
              <td data-label="Status" id="gw-health-${escapeAttr(gw.role)}"><span class="health-dot health-dot-gray"></span> <span class="text-xs text-secondary">checking...</span></td>
              <td data-label="ttyd">${gw.ttydPort ? `<a href="http://${escapeHtml(gw.vmHost)}:${gw.ttydPort}" target="_blank" class="accent-link">:${gw.ttydPort}</a>` : '-'}</td>
              <td data-label="Actions">
                <button class="icon-btn icon-btn-neutral" data-tooltip="Edit" onclick='openGatewayModal(${JSON.stringify(gw).replace(/'/g, "&#39;")})'>
                  <i class="fas fa-pencil-alt" style="font-size:10px;"></i>
                </button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function escapeAttr(str) {
  return str.replace(/[^a-zA-Z0-9_-]/g, '_');
}

async function checkGatewayHealth(gateways) {
  for (const gw of gateways) {
    const cell = document.getElementById(`gw-health-${escapeAttr(gw.role)}`);
    if (!cell) continue;

    try {
      const res = await fetch(`http://${gw.vmHost}:${gw.gatewayPort}/`, { mode: 'no-cors', signal: AbortSignal.timeout(5000) });
      cell.innerHTML = '<span class="health-dot health-dot-green"></span> <span class="text-xs" style="color:#4ade80;">reachable</span>';
    } catch {
      cell.innerHTML = '<span class="health-dot health-dot-red"></span> <span class="text-xs" style="color:#f87171;">unreachable</span>';
    }
  }
}

function openGatewayModal(gw) {
  document.getElementById('gw-role').value = gw?.role || '';
  document.getElementById('gw-role').disabled = !!gw;
  document.getElementById('gw-vm-host').value = gw?.vmHost || '';
  document.getElementById('gw-port').value = gw?.gatewayPort || 18789;
  document.getElementById('gw-token').value = gw?.gatewayToken || '';
  document.getElementById('gw-ssh-key').value = gw?.sshKeyPath || '';
  document.getElementById('gw-ttyd-port').value = gw?.ttydPort || 7681;
  document.getElementById('gateway-modal').classList.remove('hidden');
}

async function saveGateway() {
  const role = document.getElementById('gw-role').value.trim();
  const vmHost = document.getElementById('gw-vm-host').value.trim();
  const gatewayPort = parseInt(document.getElementById('gw-port').value) || 18789;
  const gatewayToken = document.getElementById('gw-token').value.trim();
  const sshKeyPath = document.getElementById('gw-ssh-key').value.trim();
  const ttydPort = parseInt(document.getElementById('gw-ttyd-port').value) || 7681;

  if (!role || !vmHost || !gatewayToken || !sshKeyPath) {
    showToast('Role, VM Host, Token, and SSH Key Path are required', 'error');
    return;
  }

  try {
    await api(`/gateways/${role}`, {
      method: 'PUT',
      body: JSON.stringify({ vmHost, gatewayPort, gatewayToken, sshKeyPath, ttydPort }),
    });
    showToast('Gateway saved', 'success');
    closeModal('gateway-modal');
    loadGateways();
  } catch (err) {
    showToast(`Save failed: ${err.message}`, 'error');
  }
}

// --- Modal helpers ---

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

// Close modals on backdrop click
document.querySelectorAll('.modal-backdrop').forEach(modal => {
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.add('hidden');
  });
});

// Close modals on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-backdrop:not(.hidden)').forEach(m => m.classList.add('hidden'));
  }
});

// --- Init ---

loadRuns();
startAutoRefresh();
