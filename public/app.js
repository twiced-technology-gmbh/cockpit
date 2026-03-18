// Pipeline Controller UI

let currentTab = localStorage.getItem('cockpit:tab') || 'runs';
let expandedRunId = null;
let autoRefreshTimer = null;
let allRuns = [];
let allLabels = [];
let selectedLabels = new Set(JSON.parse(localStorage.getItem('cockpit:labels') || '[]'));

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
  localStorage.setItem('cockpit:tab', tab);
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
  // Fallback polling (every 60s) in case SSE is unavailable
  autoRefreshTimer = setInterval(refreshCurrentTab, 60000);
}

// Real-time updates via SSE — refreshes runs when pipeline state changes
function connectEvents() {
  const es = new EventSource('/api/events');
  es.addEventListener('run:updated', () => {
    if (currentTab === 'runs') loadRuns();
  });
  es.onerror = () => {
    // Reconnect after 5s if connection drops
    setTimeout(connectEvents, 5000);
    es.close();
  };
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

const STATE_ICONS = {
  DONE: 'fa-check',
  FAILED: 'fa-times',
  AWAITING_MERGE: 'fa-code-branch',
  MERGED: 'fa-code-merge',
  DEVELOPING: 'fa-code',
  REVIEWING: 'fa-search',
  TESTING: 'fa-vial',
  DEPLOYING: 'fa-rocket',
  VERIFYING: 'fa-check-double',
  WORKTREE_SETUP: 'fa-cog',
  DEV_COMPLETE: 'fa-check-circle',
  REVIEW_DECIDED: 'fa-gavel',
  TEST_DECIDED: 'fa-clipboard-check',
  CLEANUP: 'fa-broom',
  RECEIVED: 'fa-inbox',
};

function labelText(s) {
  return s.toLowerCase().replace(/_/g, ' ');
}

function stateBadge(state) {
  const icon = STATE_ICONS[state] || 'fa-circle';
  return `<span class="pipeline-state ${stateClass(state)}"><i class="fas ${icon}" style="margin-right:4px;font-size:9px;"></i>${escapeHtml(labelText(state))}</span>`;
}

// --- Pipeline Runs ---

async function loadRuns() {
  const loading = document.getElementById('runs-loading');
  const content = document.getElementById('runs-content');

  try {
    const [runs, stats, stuck, labels] = await Promise.all([
      api('/runs'),
      api('/stats'),
      api('/stuck'),
      api('/labels'),
    ]);

    allRuns = runs;
    allLabels = labels;

    renderStats(stats);
    renderStuckBanner(stuck);
    renderLabelFilter();
    renderFilteredRuns();

    loading.classList.add('hidden');
    content.classList.remove('hidden');
  } catch (err) {
    loading.innerHTML = `<div class="info-box info-box-red"><i class="fas fa-exclamation-triangle"></i> Failed to load: ${escapeHtml(err.message)}</div>`;
  }
}

function renderLabelFilter() {
  let container = document.getElementById('label-filter');
  if (!container) {
    const statsBar = document.getElementById('stats-bar');
    container = document.createElement('div');
    container.id = 'label-filter';
    container.style.cssText = 'position:relative;display:inline-block;';
    statsBar.parentNode.insertBefore(container, statsBar.nextSibling);
  }

  if (!allLabels.length) { container.innerHTML = ''; return; }

  const activeCount = selectedLabels.size;
  container.innerHTML = `
    <div style="margin-bottom:12px;display:flex;justify-content:flex-end;">
      <button class="btn btn-neutral" id="label-filter-btn" onclick="toggleLabelDropdown()" style="font-size:11px;padding:4px 10px;">
        <i class="fas fa-tags" style="font-size:9px;"></i> Labels${activeCount ? ` (${activeCount})` : ''}
      </button>
      <div id="label-dropdown" class="hidden" style="position:absolute;right:0;top:100%;z-index:60;background:rgba(0,0,0,0.8);border:1px solid var(--border);border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,0.5);min-width:180px;max-height:260px;overflow-y:auto;padding:4px 0;">
        ${allLabels.map(label => {
          const checked = selectedLabels.has(label);
          return `<button class="label-filter-item" onclick="toggleLabel('${escapeHtml(label)}')" style="display:flex;align-items:center;gap:8px;padding:6px 12px;font-size:12px;font-weight:500;color:var(--text-primary);cursor:pointer;border:none;background:none;width:100%;text-align:left;">
            <i class="fas ${checked ? 'fa-check-square' : 'fa-square'}" style="font-size:11px;color:${checked ? '#60a5fa' : 'var(--text-secondary)'};"></i>
            ${escapeHtml(label)}
          </button>`;
        }).join('')}
        ${activeCount ? `<div style="height:1px;background:var(--border);margin:4px 0;"></div>
        <button onclick="clearLabelFilter()" style="display:flex;align-items:center;gap:8px;padding:6px 12px;font-size:11px;font-weight:500;color:var(--text-secondary);cursor:pointer;border:none;background:none;width:100%;text-align:left;">
          <i class="fas fa-times" style="font-size:9px;"></i> Clear filter
        </button>` : ''}
      </div>
    </div>
  `;
}

function toggleLabelDropdown() {
  document.getElementById('label-dropdown').classList.toggle('hidden');
}

function toggleLabel(label) {
  if (selectedLabels.has(label)) selectedLabels.delete(label);
  else selectedLabels.add(label);
  localStorage.setItem('cockpit:labels', JSON.stringify([...selectedLabels]));
  renderLabelFilter();
  renderFilteredRuns();
}

function clearLabelFilter() {
  selectedLabels.clear();
  localStorage.setItem('cockpit:labels', '[]');
  renderLabelFilter();
  renderFilteredRuns();
}

function renderFilteredRuns() {
  if (!selectedLabels.size) { renderRuns(allRuns); return; }
  const filtered = allRuns.filter(run => {
    const runLabels = JSON.parse(run.labels || '[]');
    return [...selectedLabels].some(l => runLabels.includes(l));
  });
  renderRuns(filtered);
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
          ${run.state === 'FAILED' ? `<button class="icon-btn icon-btn-red" data-tooltip="Retry" onclick="retryRun('${run.id}')"><i class="fas fa-redo" style="font-size:10px;"></i></button>` : ''}
          ${run.state === 'AWAITING_MERGE' ? `<button class="icon-btn icon-btn-green" data-tooltip="Merge" onclick="approveMerge('${run.id}')"><i class="fas fa-code-merge" style="font-size:10px;"></i></button>` : ''}
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
    const expandRow = document.getElementById(`expand-${runId}`);
    if (expandRow) expandRow.classList.add('hidden');
    const chevron = document.querySelector(`tr[onclick*="'${runId}'"] .fa-chevron-down`);
    if (chevron) { chevron.classList.remove('fa-chevron-down'); chevron.classList.add('fa-chevron-right'); }
    return;
  }

  // Collapse previous
  if (expandedRunId) {
    const prevRow = document.getElementById(`expand-${expandedRunId}`);
    if (prevRow) prevRow.classList.add('hidden');
    const prevChevron = document.querySelector(`tr[onclick*="'${expandedRunId}'"] .fa-chevron-down`);
    if (prevChevron) { prevChevron.classList.remove('fa-chevron-down'); prevChevron.classList.add('fa-chevron-right'); }
  }

  expandedRunId = runId;
  const expandRow = document.getElementById(`expand-${runId}`);
  if (expandRow) expandRow.classList.remove('hidden');
  const chevron = document.querySelector(`tr[onclick*="'${runId}'"] .fa-chevron-right`);
  if (chevron) { chevron.classList.remove('fa-chevron-right'); chevron.classList.add('fa-chevron-down'); }
  const contentEl = document.getElementById(`expand-content-${runId}`);
  if (contentEl) contentEl.innerHTML = '<div class="loading-state" style="padding:12px;"><div class="spinner" style="margin:0 auto;width:20px;height:20px;"></div></div>';

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
  if (status === 'running') return '<span class="pipeline-state pipeline-state-active"><i class="fas fa-spinner fa-spin" style="margin-right:4px;font-size:9px;"></i>running</span>';
  if (status === 'completed' || status === 'success') {
    if (result === 'failure') return '<span class="pipeline-state pipeline-state-failed"><i class="fas fa-times" style="margin-right:4px;font-size:9px;"></i>failed</span>';
    return '<span class="pipeline-state pipeline-state-done"><i class="fas fa-check" style="margin-right:4px;font-size:9px;"></i>success</span>';
  }
  if (status === 'failed') return '<span class="pipeline-state pipeline-state-failed"><i class="fas fa-times" style="margin-right:4px;font-size:9px;"></i>failed</span>';
  return `<span class="pipeline-state pipeline-state-idle"><i class="fas fa-clock" style="margin-right:4px;font-size:9px;"></i>${escapeHtml(labelText(status || 'pending'))}</span>`;
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

let currentProjects = [];

async function loadProjects() {
  const loading = document.getElementById('projects-loading');
  const content = document.getElementById('projects-content');

  try {
    const projects = await api('/projects');
    currentProjects = projects;
    loading.classList.add('hidden');
    content.classList.remove('hidden');
    renderProjects(projects);
  } catch (err) {
    loading.innerHTML = `<div class="info-box info-box-red"><i class="fas fa-exclamation-triangle"></i> Failed to load: ${escapeHtml(err.message)}</div>`;
  }
}

function renderProjects(projects) {
  const content = document.getElementById('projects-content');

  content.innerHTML = `
    <div class="flex justify-between items-center mb-3">
      <input class="input" id="project-search" placeholder="Search projects..." style="flex:1;max-width:280px;" oninput="filterProjects()">
      <div class="flex gap-2">
        <button class="icon-btn icon-btn-blue" data-tooltip="Find Projects" onclick="openScanDialog()"><i class="fas fa-folder-open" style="font-size:11px;"></i></button>
        <button class="icon-btn icon-btn-green" data-tooltip="Add Project" onclick="openProjectModal()"><i class="fas fa-plus" style="font-size:11px;"></i></button>
      </div>
    </div>
    <div id="projects-list"></div>
  `;

  renderProjectsList(projects);
}

function filterProjects() {
  const q = (document.getElementById('project-search')?.value || '').toLowerCase().trim();
  if (!q) { renderProjectsList(currentProjects); return; }

  // Include a parent if its name matches OR any child name matches
  const childMap = buildChildMap(currentProjects);
  const filtered = currentProjects.filter(p => {
    if (p.parentProject) return false; // handled via parent
    const ownMatch = p.project.toLowerCase().includes(q) ||
                     (p.slackChannel || '').toLowerCase().includes(q) ||
                     (p.linearTeamId || '').toLowerCase().includes(q);
    const childMatch = (childMap[p.project] || []).some(c => c.project.toLowerCase().includes(q));
    return ownMatch || childMatch;
  });
  // Also include orphaned children that match
  const parentNames = new Set(currentProjects.filter(p => !p.parentProject).map(p => p.project));
  const matchingOrphans = currentProjects.filter(p =>
    p.parentProject && !parentNames.has(p.parentProject) && p.project.toLowerCase().includes(q)
  );
  renderProjectsList([...filtered, ...matchingOrphans]);
}

function buildChildMap(projects) {
  const map = {};
  for (const p of projects) {
    if (p.parentProject) {
      (map[p.parentProject] = map[p.parentProject] || []).push(p);
    }
  }
  return map;
}

function renderProjectsList(projects) {
  const list = document.getElementById('projects-list');
  if (!list) return;

  if (!projects.length) {
    list.innerHTML = `
      <div class="surface rounded-lg">
        <div class="empty-state">
          <i class="fas fa-folder-open"></i>
          <h3>No projects configured</h3>
          <p>Add a project or use Find Projects to discover .git repositories.</p>
        </div>
      </div>
    `;
    return;
  }

  const childMap = buildChildMap(projects);
  const parentNames = new Set(projects.filter(p => !p.parentProject).map(p => p.project));
  const topLevel = projects.filter(p => !p.parentProject);
  const orphans = projects.filter(p => p.parentProject && !parentNames.has(p.parentProject));

  let html = '<div class="unparent-zone" id="unparent-zone"><i class="fas fa-arrow-up" style="margin-right:6px;"></i>Drop here to make top-level</div>';
  html += topLevel.map(p => renderParentCard(p, childMap[p.project] || [])).join('');
  if (orphans.length) html += orphans.map(p => renderProjectCard(p)).join('');

  list.innerHTML = html || '<div class="text-xs text-secondary" style="padding:8px 0;">No projects match.</div>';
}

function renderParentCard(project, children) {
  const repos = project.repos || [];
  const isParent = children.length > 0;

  const slackBadge = project.slackChannel
    ? `<span class="tag" style="color:#a78bfa;border-color:#a78bfa33;"><i class="fab fa-slack" style="margin-right:4px;font-size:9px;"></i>${escapeHtml(project.slackChannel)}</span>`
    : '';

  const childRows = children.map(child => {
    const childRepoUrl = child.repos?.[0]?.repoUrl || child.repoUrl || '';
    const childLinear = child.linearTeamId && child.linearTeamId !== project.linearTeamId
      ? `<span class="text-xs text-secondary">${escapeHtml(child.linearTeamId)}</span>`
      : '';
    return `
      <tr class="child-row" data-project="${escapeHtml(child.project)}">
        <td data-label="Repository">
          <span class="drag-handle"><i class="fas fa-grip-vertical" style="font-size:9px;margin-right:4px;"></i></span>
          <i class="fas fa-folder" style="color:#60a5fa;font-size:11px;margin-right:6px;"></i>
          <span class="text-emphasis" style="font-size:12px;">${escapeHtml(child.project)}</span>
        </td>
        <td data-label="Linear">${childLinear}</td>
        <td data-label="Repo">${childRepoUrl ? `<a href="${escapeHtml(childRepoUrl)}" target="_blank" class="accent-link" style="font-size:11px;">${escapeHtml(childRepoUrl.replace('https://github.com/', ''))}</a>` : '<span class="text-secondary" style="font-size:11px;">—</span>'}</td>
        <td data-label="" style="white-space:nowrap;">
          <button class="icon-btn icon-btn-purple" style="width:22px;height:22px;" data-tooltip="Link" onclick="event.stopPropagation();showLinkMenu('${escapeHtml(child.project)}',this)"><i class="fas fa-link" style="font-size:9px;"></i></button>
          <button class="icon-btn icon-btn-amber" style="width:22px;height:22px;" data-tooltip="Edit" onclick="openProjectModal('${escapeHtml(child.project)}')"><i class="fas fa-pencil-alt" style="font-size:9px;"></i></button>
          <button class="icon-btn icon-btn-red" style="width:22px;height:22px;" data-tooltip="Delete" onclick="deleteProject('${escapeHtml(child.project)}')"><i class="fas fa-trash" style="font-size:9px;"></i></button>
        </td>
      </tr>
    `;
  }).join('');

  const subProjectsSection = isParent ? `
    <div class="mt-2">
      <div class="text-xs" style="color:var(--text-secondary);font-weight:500;margin-bottom:6px;">Repositories (${children.length})</div>
      <table class="dark-table">
        <thead><tr><th>Project</th><th>Linear</th><th>Repo</th><th></th></tr></thead>
        <tbody>${childRows}</tbody>
      </table>
    </div>
  ` : '';

  const repoUrl = repos?.[0]?.repoUrl || project.repoUrl || '';

  const iconColor = isParent ? '#a78bfa' : '#60a5fa';
  const iconClass = isParent ? 'fa-sitemap' : 'fa-folder';

  return `
    <div class="project-card surface rounded-lg mb-3" data-project="${escapeHtml(project.project)}">
      <div style="padding:12px 16px;border-bottom:1px solid var(--border);" class="flex items-center justify-between">
        <div class="flex items-center gap-2" style="flex-wrap:wrap;">
          <span class="drag-handle"><i class="fas fa-grip-vertical" style="font-size:10px;"></i></span>
          <i class="fas ${iconClass}" style="color:${iconColor};font-size:13px;"></i>
          <span class="text-sm font-medium text-emphasis">${escapeHtml(project.project)}</span>
          ${project.linearTeamId ? `<span class="text-xs text-secondary">${escapeHtml(project.linearTeamId)}</span>` : ''}
          ${repoUrl ? `<a href="${escapeHtml(repoUrl)}" target="_blank" class="accent-link" style="font-size:11px;">${escapeHtml(repoUrl.replace('https://github.com/', ''))}</a>` : ''}
          ${slackBadge}
        </div>
        <div class="flex gap-1">
          <button class="icon-btn icon-btn-blue" data-tooltip="Add Sub-project" onclick="openProjectModal(null,'${escapeHtml(project.project)}')"><i class="fas fa-folder-plus" style="font-size:10px;"></i></button>
          <button class="icon-btn icon-btn-purple" data-tooltip="Link" onclick="event.stopPropagation();showLinkMenu('${escapeHtml(project.project)}',this)"><i class="fas fa-link" style="font-size:10px;"></i></button>
          <button class="icon-btn icon-btn-amber" data-tooltip="Edit" onclick="openProjectModal('${escapeHtml(project.project)}')"><i class="fas fa-pencil-alt" style="font-size:10px;"></i></button>
          <button class="icon-btn icon-btn-red" data-tooltip="Delete" onclick="deleteProject('${escapeHtml(project.project)}')"><i class="fas fa-trash" style="font-size:10px;"></i></button>
        </div>
      </div>
      <div style="padding:12px 16px;">
        ${subProjectsSection}
      </div>
    </div>
  `;
}

function renderProjectCard(project) {
  return renderParentCard(project, []);
}

function openProjectModal(projectName, presetParent) {
  const modal = document.getElementById('project-modal');
  const title = document.getElementById('project-modal-title');
  const nameInput = document.getElementById('project-name');
  const originalInput = document.getElementById('project-edit-original');

  // Populate parent dropdown with top-level projects
  const parentSelect = document.getElementById('project-parent');
  const topLevel = currentProjects.filter(p => !p.parentProject);
  parentSelect.innerHTML = '<option value="">(none — top-level project)</option>' +
    topLevel.map(p => `<option value="${escapeHtml(p.project)}">${escapeHtml(p.project)}</option>`).join('');

  if (projectName) {
    title.textContent = 'Edit Project';
    originalInput.value = projectName;
    nameInput.value = projectName;
    nameInput.disabled = true;
    api(`/projects/${projectName}`).then(p => {
      document.getElementById('project-linear-team').value = p.linearTeamId || '';
      document.getElementById('project-repo-url').value = p.repoUrl || '';
      document.getElementById('project-default-branch').value = p.defaultBranch || 'main';
      parentSelect.value = p.parentProject || '';
      document.getElementById('project-slack-channel').value = p.slackChannel || '';
    });
  } else {
    title.textContent = presetParent ? `Add Repo to ${presetParent}` : 'Add Project';
    originalInput.value = '';
    nameInput.value = '';
    nameInput.disabled = false;
    document.getElementById('project-linear-team').value = '';
    document.getElementById('project-repo-url').value = '';
    document.getElementById('project-default-branch').value = 'main';
    parentSelect.value = presetParent || '';
    document.getElementById('project-slack-channel').value = '';
  }

  modal.classList.remove('hidden');
}

async function saveProject() {
  const original = document.getElementById('project-edit-original').value;
  const project = document.getElementById('project-name').value.trim();
  const linearTeamId = document.getElementById('project-linear-team').value.trim();
  const repoUrl = document.getElementById('project-repo-url').value.trim();
  const defaultBranch = document.getElementById('project-default-branch').value.trim() || 'main';
  const parentProject = document.getElementById('project-parent').value || null;
  const slackChannel = document.getElementById('project-slack-channel').value.trim() || null;

  if (!project) {
    showToast('Project name is required', 'error');
    return;
  }

  const body = { project, linearTeamId, repoUrl, defaultBranch, parentProject, slackChannel };

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
        <button class="icon-btn icon-btn-green" data-tooltip="Add Gateway" onclick="openGatewayModal()"><i class="fas fa-plus" style="font-size:11px;"></i></button>
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
      <button class="icon-btn icon-btn-green" data-tooltip="Add Gateway" onclick="openGatewayModal()"><i class="fas fa-plus" style="font-size:11px;"></i></button>
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
  await Promise.all(gateways.map(async (gw) => {
    const cell = document.getElementById(`gw-health-${escapeAttr(gw.role)}`);
    if (!cell) return;

    try {
      await fetch(`http://${gw.vmHost}:${gw.gatewayPort}/`, { mode: 'no-cors', signal: AbortSignal.timeout(5000) });
      cell.innerHTML = '<span class="health-dot health-dot-green"></span> <span class="text-xs" style="color:#4ade80;">reachable</span>';
    } catch {
      cell.innerHTML = '<span class="health-dot health-dot-red"></span> <span class="text-xs" style="color:#f87171;">unreachable</span>';
    }
  }));
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

// --- Scan / Find Projects ---

let scanResults = [];
let scanTree = [];
let scanExpanded = new Set();
let scanSelected = new Set();

async function openScanDialog() {
  document.getElementById('scan-modal').classList.remove('hidden');
  scanResults = [];
  scanTree = [];
  scanExpanded = new Set();
  scanSelected = new Set();
  document.getElementById('scan-search').value = '';
  document.getElementById('scan-loading').classList.remove('hidden');
  document.getElementById('scan-tree').innerHTML = '';
  document.getElementById('scan-tree').classList.add('hidden');
  document.getElementById('scan-empty').classList.add('hidden');
  document.getElementById('scan-add-btn').disabled = true;
  document.getElementById('scan-count').textContent = '';

  try {
    scanResults = await api('/scan-projects');
    document.getElementById('scan-loading').classList.add('hidden');

    if (!scanResults.length) {
      document.getElementById('scan-empty').classList.remove('hidden');
      return;
    }

    scanTree = buildScanTree(scanResults);
    for (const node of scanTree) scanExpanded.add(node.path);

    document.getElementById('scan-tree').classList.remove('hidden');
    renderScanTree();
  } catch (err) {
    document.getElementById('scan-loading').innerHTML =
      `<div class="info-box info-box-red" style="margin:16px;"><i class="fas fa-exclamation-triangle"></i> ${escapeHtml(err.message)}</div>`;
  }
}

function buildScanTree(projects) {
  const paths = projects.map(p => p.path);
  let prefix = paths[0];
  for (const p of paths) {
    while (!p.startsWith(prefix)) prefix = prefix.substring(0, prefix.lastIndexOf('/'));
  }
  if (!prefix.endsWith('/')) prefix += '/';

  const nodeMap = {};
  const root = [];

  for (const project of projects) {
    const rel = project.path.substring(prefix.length);
    const parts = rel.split('/').filter(Boolean);
    let parentChildren = root;
    let currentPath = prefix.slice(0, -1);

    for (let i = 0; i < parts.length; i++) {
      currentPath += '/' + parts[i];
      const isLast = i === parts.length - 1;

      if (!nodeMap[currentPath]) {
        const node = { name: parts[i], path: currentPath, children: [], isProject: false, project: null };
        nodeMap[currentPath] = node;
        parentChildren.push(node);
      }
      if (isLast) {
        nodeMap[currentPath].isProject = true;
        nodeMap[currentPath].project = project;
      }
      parentChildren = nodeMap[currentPath].children;
    }
  }

  function sortNodes(nodes) {
    nodes.sort((a, b) => {
      const aIsFolder = a.children.length > 0;
      const bIsFolder = b.children.length > 0;
      if (aIsFolder !== bIsFolder) return aIsFolder ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) sortNodes(n.children);
  }
  sortNodes(root);
  return root;
}

function getAllProjectPaths(node) {
  const paths = [];
  if (node.isProject) paths.push(node.path);
  for (const child of node.children) paths.push(...getAllProjectPaths(child));
  return paths;
}

function findScanNode(nodes, path) {
  for (const node of nodes) {
    if (node.path === path) return node;
    const found = findScanNode(node.children, path);
    if (found) return found;
  }
  return null;
}

function nodeMatchesQuery(node, query) {
  if (node.name.toLowerCase().includes(query)) return true;
  if (node.project?.remoteUrl?.toLowerCase().includes(query)) return true;
  return node.children.some(c => nodeMatchesQuery(c, query));
}

function escapeHtmlAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderScanTree() {
  const container = document.getElementById('scan-tree');
  const query = document.getElementById('scan-search').value.toLowerCase().trim();
  let html = '';

  function renderNode(node, depth) {
    if (query && !nodeMatchesQuery(node, query)) return;

    const hasChildren = node.children.length > 0;
    const isExpanded = scanExpanded.has(node.path);
    const indent = depth * 20;

    const allPaths = getAllProjectPaths(node);
    const selectedCount = allPaths.filter(p => scanSelected.has(p)).length;
    let checkIcon, checkColor;
    if (selectedCount === 0) {
      checkIcon = 'far fa-square'; checkColor = 'var(--text-secondary)';
    } else if (selectedCount === allPaths.length) {
      checkIcon = 'fas fa-check-square'; checkColor = '#60a5fa';
    } else {
      checkIcon = 'fas fa-minus-square'; checkColor = '#60a5fa';
    }

    const folderIcon = node.isProject ? 'fa-code-branch' : (isExpanded ? 'fa-folder-open' : 'fa-folder');
    const iconColor = node.isProject ? '#4ade80' : '#60a5fa';

    let remoteLabel = '';
    if (node.isProject && node.project?.remoteUrl) {
      let remote = node.project.remoteUrl
        .replace(/^git@github\.com:/, '')
        .replace(/^https:\/\/github\.com\//, '')
        .replace(/\.git$/, '');
      remoteLabel = `<span class="scan-tree-remote">${escapeHtml(remote)}</span>`;
    }

    const encodedPath = escapeHtmlAttr(node.path);
    html += `<div class="scan-tree-node" style="padding-left:${indent}px;">`;
    if (hasChildren) {
      html += `<span class="scan-tree-chevron" data-path="${encodedPath}"><i class="fas fa-chevron-${isExpanded ? 'down' : 'right'}"></i></span>`;
    } else {
      html += `<span class="scan-tree-spacer"></span>`;
    }
    html += `<span class="scan-tree-checkbox" data-path="${encodedPath}" style="color:${checkColor};"><i class="${checkIcon}"></i></span>`;
    html += `<i class="fas ${folderIcon} scan-tree-icon" style="color:${iconColor};"></i>`;
    html += `<span class="scan-tree-label">${escapeHtml(node.name)}</span>`;
    html += remoteLabel;
    html += `</div>`;

    if (hasChildren) {
      html += `<div class="scan-tree-children${isExpanded ? '' : ' hidden'}">`;
      for (const child of node.children) renderNode(child, depth + 1);
      html += `</div>`;
    }
  }

  for (const node of scanTree) renderNode(node, 0);
  container.innerHTML = html;

  const totalProjects = scanResults.length;
  const selectedCount = scanSelected.size;
  document.getElementById('scan-count').textContent =
    selectedCount > 0 ? `${selectedCount} of ${totalProjects} selected` : `${totalProjects} found`;
  document.getElementById('scan-add-btn').disabled = selectedCount === 0;
}

function filterScanTree() { renderScanTree(); }

function scanExpandAll() {
  function addAll(nodes) {
    for (const n of nodes) {
      if (n.children.length > 0) { scanExpanded.add(n.path); addAll(n.children); }
    }
  }
  addAll(scanTree);
  renderScanTree();
}

function scanCollapseAll() {
  scanExpanded.clear();
  renderScanTree();
}

function scanToggleAll() {
  const allPaths = [];
  function collect(nodes) {
    for (const n of nodes) { if (n.isProject) allPaths.push(n.path); collect(n.children); }
  }
  collect(scanTree);
  const allSelected = allPaths.every(p => scanSelected.has(p));
  if (allSelected) scanSelected.clear();
  else for (const p of allPaths) scanSelected.add(p);
  renderScanTree();
}

document.addEventListener('click', (e) => {
  const chevron = e.target.closest('.scan-tree-chevron');
  if (chevron) {
    const path = chevron.dataset.path;
    if (scanExpanded.has(path)) scanExpanded.delete(path);
    else scanExpanded.add(path);
    renderScanTree();
    return;
  }

  const checkbox = e.target.closest('.scan-tree-checkbox');
  if (checkbox) {
    const path = checkbox.dataset.path;
    const node = findScanNode(scanTree, path);
    if (!node) return;
    const allPaths = getAllProjectPaths(node);
    const allSelected = allPaths.every(p => scanSelected.has(p));
    for (const p of allPaths) {
      if (allSelected) scanSelected.delete(p);
      else scanSelected.add(p);
    }
    renderScanTree();
  }
});

// Find the immediate parent node of a path in the scan tree
function findTreeParent(nodes, targetPath, parent) {
  for (const node of nodes) {
    if (node.path === targetPath) return parent;
    const found = findTreeParent(node.children, targetPath, node);
    if (found !== undefined) return found;
  }
  return undefined;
}

async function addScannedProjects() {
  const selected = Array.from(scanSelected);
  if (!selected.length) return;

  const btn = document.getElementById('scan-add-btn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin" style="font-size:11px;"></i>';

  // Group selected repos by their immediate non-project parent directory
  const groups = {}; // parentName -> [{ name, remoteUrl }]
  const standalone = [];

  for (const path of selected) {
    const result = scanResults.find(r => r.path === path);
    if (!result) continue;
    const parentNode = findTreeParent(scanTree, path, null);
    if (parentNode && !parentNode.isProject) {
      (groups[parentNode.name] = groups[parentNode.name] || []).push({
        name: result.name, remoteUrl: result.remoteUrl || '',
      });
    } else {
      standalone.push({ name: result.name, remoteUrl: result.remoteUrl || '' });
    }
  }

  let added = 0, skipped = 0;

  // Create grouped parent projects with children
  for (const [parentName, children] of Object.entries(groups)) {
    if (children.length === 1) {
      standalone.push(children[0]);
      continue;
    }

    // Create parent project
    try {
      await api('/projects', {
        method: 'POST',
        body: JSON.stringify({
          project: parentName, linearTeamId: '', repoUrl: '', defaultBranch: 'main',
        }),
      });
      added++;
    } catch { /* already exists */ }

    // Create each child under the parent
    for (const child of children) {
      try {
        await api('/projects', {
          method: 'POST',
          body: JSON.stringify({
            project: child.name, linearTeamId: '', repoUrl: child.remoteUrl,
            defaultBranch: 'main', parentProject: parentName,
          }),
        });
        added++;
      } catch { skipped++; }
    }
  }

  // Create standalone projects (no grouping)
  for (const p of standalone) {
    try {
      await api('/projects', {
        method: 'POST',
        body: JSON.stringify({
          project: p.name, linearTeamId: '', repoUrl: p.remoteUrl,
          defaultBranch: 'main',
        }),
      });
      added++;
    } catch { skipped++; }
  }

  btn.innerHTML = '<i class="fas fa-plus" style="font-size:11px;"></i>';
  btn.disabled = false;
  closeModal('scan-modal');
  showToast(
    `Added ${added} project(s)${skipped > 0 ? `, ${skipped} already existed` : ''}`,
    added > 0 ? 'success' : 'info',
  );
  loadProjects();
}

// --- Link Menu ---

let linkMenuProject = null;

function showLinkMenu(projectName, btnEl) {
  const menu = document.getElementById('link-menu');
  linkMenuProject = projectName;

  const current = currentProjects.find(p => p.project === projectName);
  const currentParent = current?.parentProject || null;
  const topLevel = currentProjects.filter(p => !p.parentProject && p.project !== projectName);

  let html = `<button class="link-menu-item${!currentParent ? ' active' : ''}" onclick="linkProject('${escapeHtml(projectName)}', null)">
    <i class="fas fa-arrow-up" style="font-size:10px;color:var(--text-secondary);"></i> (top-level)
  </button>`;

  if (topLevel.length) html += '<div class="link-menu-separator"></div>';

  for (const p of topLevel) {
    const isActive = currentParent === p.project;
    html += `<button class="link-menu-item${isActive ? ' active' : ''}" onclick="linkProject('${escapeHtml(projectName)}', '${escapeHtml(p.project)}')">
      <i class="fas fa-sitemap" style="font-size:10px;color:#a78bfa;"></i> ${escapeHtml(p.project)}
    </button>`;
  }

  menu.innerHTML = html;
  menu.classList.remove('hidden');

  const rect = btnEl.getBoundingClientRect();
  menu.style.top = (rect.bottom + 4) + 'px';
  menu.style.left = Math.min(rect.left, window.innerWidth - 200) + 'px';
}

function hideLinkMenu() {
  document.getElementById('link-menu').classList.add('hidden');
  linkMenuProject = null;
}

async function linkProject(projectName, parentName) {
  hideLinkMenu();
  try {
    await api(`/projects/${projectName}`, {
      method: 'PUT',
      body: JSON.stringify({ parentProject: parentName }),
    });
    showToast(parentName ? `Moved "${projectName}" under "${parentName}"` : `"${projectName}" is now top-level`, 'success');
    loadProjects();
  } catch (err) {
    showToast(`Link failed: ${err.message}`, 'error');
  }
}

// Close link menu on outside click
document.addEventListener('click', (e) => {
  const menu = document.getElementById('link-menu');
  if (!menu.classList.contains('hidden') && !menu.contains(e.target) && !e.target.closest('[data-tooltip="Link"]')) {
    hideLinkMenu();
  }
});

// --- Drag & Drop (custom mouse-based) ---

let dragState = null; // { project, sourceEl, clone }

function getDropTarget(x, y) {
  // Temporarily hide clone so elementFromPoint sees through it
  if (dragState?.clone) dragState.clone.style.display = 'none';
  const el = document.elementFromPoint(x, y);
  if (dragState?.clone) dragState.clone.style.display = '';

  if (!el) return null;
  const card = el.closest('.project-card[data-project]');
  if (card && card.dataset.project !== dragState?.project) return { type: 'card', el: card, project: card.dataset.project };
  const zone = el.closest('#unparent-zone');
  if (zone) return { type: 'zone', el: zone, project: null };
  return null;
}

document.addEventListener('mousedown', (e) => {
  const handle = e.target.closest('.drag-handle');
  if (!handle) return;

  const card = handle.closest('.project-card[data-project]');
  const row = handle.closest('.child-row[data-project]');
  const source = card || row;
  if (!source) return;

  e.preventDefault();

  const projectName = source.dataset.project;
  const clone = document.createElement('div');
  clone.className = 'drag-clone';
  clone.innerHTML = `<i class="fas fa-grip-vertical"></i>${escapeHtml(projectName)}`;
  clone.style.left = e.clientX + 'px';
  clone.style.top = (e.clientY - 16) + 'px';
  document.body.appendChild(clone);

  source.classList.add('dragging');

  const zone = document.getElementById('unparent-zone');
  if (zone) zone.classList.add('visible');

  dragState = { project: projectName, sourceEl: source, clone };
});

document.addEventListener('mousemove', (e) => {
  if (!dragState) return;

  dragState.clone.style.left = e.clientX + 'px';
  dragState.clone.style.top = (e.clientY - 16) + 'px';

  // Clear old highlights
  document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));

  // Highlight current target
  const target = getDropTarget(e.clientX, e.clientY);
  if (target) target.el.classList.add('drag-over');
});

document.addEventListener('mouseup', async (e) => {
  if (!dragState) return;

  const target = getDropTarget(e.clientX, e.clientY);

  // Cleanup
  dragState.sourceEl.classList.remove('dragging');
  dragState.clone.remove();
  document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
  const zone = document.getElementById('unparent-zone');
  if (zone) zone.classList.remove('visible');

  const projectName = dragState.project;
  dragState = null;

  if (!target) return;

  try {
    await api(`/projects/${projectName}`, {
      method: 'PUT',
      body: JSON.stringify({ parentProject: target.project }),
    });
    showToast(target.project ? `Moved "${projectName}" under "${target.project}"` : `"${projectName}" is now top-level`, 'success');
    loadProjects();
  } catch (err) {
    showToast(`Move failed: ${err.message}`, 'error');
  }
});

// --- Modal helpers ---

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

// Close label dropdown on outside click
document.addEventListener('click', (e) => {
  const filter = document.getElementById('label-filter');
  if (filter && !filter.contains(e.target)) {
    const dd = document.getElementById('label-dropdown');
    if (dd) dd.classList.add('hidden');
  }
});

// Close modals on backdrop click
document.querySelectorAll('.modal-backdrop').forEach(modal => {
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.add('hidden');
  });
});

// Close modals on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideLinkMenu();
    document.querySelectorAll('.modal-backdrop:not(.hidden)').forEach(m => m.classList.add('hidden'));
  }
});

// --- Init ---

// Show dev mode badge if server reports dev mode
api('/health').then(d => {
  if (d.dev) {
    const badge = document.getElementById('dev-mode-badge');
    badge.style.display = 'inline-flex';
    badge.classList.remove('hidden');
  }
}).catch(() => {});

switchTab(currentTab);
startAutoRefresh();
connectEvents();
