/**
 * MCP Gateway Dashboard — Single-file HTML dashboard.
 *
 * Serves a full dark-themed control panel at GET /dashboard.
 * Polls /api/health/stats every 3 seconds. Pauses when tab is hidden.
 *
 * Security: All dynamic content is escaped via esc() before insertion.
 * This is an internal admin dashboard served on localhost only.
 */

export function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MCP Gateway Dashboard</title>
<style>
  :root {
    --bg: #1e1e1e;
    --bg-alt: #252526;
    --card: #2d2d30;
    --card-hover: #37373d;
    --border: #3e3e42;
    --text: #cccccc;
    --text-dim: #808080;
    --text-bright: #e0e0e0;
    --accent: #0e639c;
    --accent-hover: #1177bb;
    --success: #4ec9b0;
    --warning: #dcdcaa;
    --error: #f44747;
    --info: #569cd6;
    --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace;
    --mono: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
    --radius: 6px;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: var(--font);
    background: var(--bg);
    color: var(--text);
    font-size: 13px;
    line-height: 1.5;
    overflow-x: hidden;
  }

  /* ── Header ──────────────────────────────────────────────── */
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 20px;
    background: var(--bg-alt);
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    z-index: 100;
  }
  .header-left {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .header h1 {
    font-size: 15px;
    font-weight: 600;
    color: var(--text-bright);
  }
  .header .badge {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 10px;
    font-weight: 500;
  }
  .badge-ok { background: rgba(78,201,176,0.15); color: var(--success); }
  .badge-disabled { background: rgba(244,71,71,0.15); color: var(--error); }
  .header-right {
    display: flex;
    align-items: center;
    gap: 16px;
    font-size: 12px;
    color: var(--text-dim);
  }
  .stat-pill {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .stat-pill .value { color: var(--text-bright); font-family: var(--mono); }

  /* ── Grid Layout ─────────────────────────────────────────── */
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    padding: 16px 20px;
    max-width: 1600px;
    margin: 0 auto;
  }
  @media (max-width: 900px) {
    .grid { grid-template-columns: 1fr; }
  }
  .grid-full { grid-column: 1 / -1; }

  /* ── Cards ───────────────────────────────────────────────── */
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-alt);
  }
  .card-header h2 {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-dim);
  }
  .card-body { padding: 14px; }

  /* ── Tool Table ──────────────────────────────────────────── */
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  th {
    text-align: left;
    padding: 6px 10px;
    font-weight: 600;
    color: var(--text-dim);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    user-select: none;
    white-space: nowrap;
  }
  th:hover { color: var(--text-bright); }
  th .sort-arrow { margin-left: 4px; font-size: 10px; }
  td {
    padding: 5px 10px;
    border-bottom: 1px solid rgba(62,62,66,0.4);
    font-family: var(--mono);
    font-size: 12px;
  }
  tr:hover td { background: rgba(255,255,255,0.03); }
  .td-name { font-family: var(--font); font-weight: 500; color: var(--text-bright); }
  .td-error { color: var(--error); }
  .td-ok { color: var(--success); }
  .td-warn { color: var(--warning); }
  .td-dim { color: var(--text-dim); }
  .empty-state {
    padding: 30px 14px;
    text-align: center;
    color: var(--text-dim);
    font-style: italic;
  }

  /* ── Server Cards ────────────────────────────────────────── */
  .server-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 10px;
  }
  .server-card {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px;
    transition: border-color 0.15s;
  }
  .server-card:hover { border-color: var(--accent); }
  .server-card.disabled { opacity: 0.5; }
  .server-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }
  .server-name {
    font-weight: 600;
    color: var(--text-bright);
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 140px;
  }
  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;
    flex-shrink: 0;
  }
  .status-running { background: var(--success); box-shadow: 0 0 4px var(--success); }
  .status-idle { background: var(--text-dim); }
  .status-error { background: var(--error); box-shadow: 0 0 4px var(--error); }
  .server-meta {
    font-size: 11px;
    color: var(--text-dim);
    margin-bottom: 8px;
    line-height: 1.6;
  }
  .server-meta span { margin-right: 10px; }
  .server-actions {
    display: flex;
    gap: 6px;
  }

  /* ── Buttons ─────────────────────────────────────────────── */
  .btn {
    padding: 4px 10px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-alt);
    color: var(--text);
    font-size: 11px;
    cursor: pointer;
    transition: all 0.15s;
    font-family: var(--font);
    white-space: nowrap;
  }
  .btn:hover { background: var(--card-hover); border-color: var(--accent); color: var(--text-bright); }
  .btn-danger { border-color: var(--error); color: var(--error); }
  .btn-danger:hover { background: rgba(244,71,71,0.15); }
  .btn-primary { background: var(--accent); border-color: var(--accent); color: white; }
  .btn-primary:hover { background: var(--accent-hover); }
  .btn-sm { padding: 2px 8px; font-size: 10px; }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }

  /* ── Timeline Chart ──────────────────────────────────────── */
  .timeline-container {
    position: relative;
    height: 120px;
    overflow: hidden;
  }
  .timeline-svg {
    width: 100%;
    height: 100%;
  }
  .timeline-label {
    position: absolute;
    font-size: 10px;
    color: var(--text-dim);
  }
  .timeline-label.tl-left { left: 6px; bottom: 4px; }
  .timeline-label.tl-right { right: 6px; bottom: 4px; }

  /* ── Control Bar ─────────────────────────────────────────── */
  .control-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 20px;
    background: var(--bg-alt);
    border-top: 1px solid var(--border);
    gap: 16px;
    flex-wrap: wrap;
  }
  .control-group {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  /* ── Toggle ──────────────────────────────────────────────── */
  .toggle-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
  }
  .toggle {
    width: 36px;
    height: 20px;
    border-radius: 10px;
    background: var(--border);
    position: relative;
    cursor: pointer;
    transition: background 0.2s;
  }
  .toggle.on { background: var(--success); }
  .toggle .knob {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: white;
    position: absolute;
    top: 2px;
    left: 2px;
    transition: left 0.2s;
  }
  .toggle.on .knob { left: 18px; }

  /* ── Install Form ────────────────────────────────────────── */
  .install-form {
    display: none;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .install-form.show { display: flex; }
  .install-form input {
    padding: 4px 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg);
    color: var(--text);
    font-size: 12px;
    font-family: var(--mono);
  }
  .install-form input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .install-form input::placeholder { color: var(--text-dim); }

  /* ── Toast Notifications ─────────────────────────────────── */
  .toast-container {
    position: fixed;
    top: 60px;
    right: 20px;
    z-index: 200;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .toast {
    padding: 8px 14px;
    border-radius: var(--radius);
    font-size: 12px;
    animation: slideIn 0.2s ease;
    max-width: 320px;
  }
  .toast-ok { background: rgba(78,201,176,0.2); border: 1px solid var(--success); color: var(--success); }
  .toast-error { background: rgba(244,71,71,0.2); border: 1px solid var(--error); color: var(--error); }
  @keyframes slideIn {
    from { transform: translateX(100%); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }

  /* ── Scrollable table wrapper ────────────────────────────── */
  .table-wrap {
    max-height: 340px;
    overflow-y: auto;
  }
  .table-wrap::-webkit-scrollbar { width: 6px; }
  .table-wrap::-webkit-scrollbar-track { background: transparent; }
  .table-wrap::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
</style>
</head>
<body>

<!-- Header -->
<div class="header">
  <div class="header-left">
    <h1>MCP Gateway</h1>
    <span class="badge badge-ok" id="gateway-badge">Running</span>
  </div>
  <div class="header-right">
    <div class="stat-pill">Uptime: <span class="value" id="stat-uptime">--</span></div>
    <div class="stat-pill">Requests: <span class="value" id="stat-requests">--</span></div>
    <div class="stat-pill">Errors: <span class="value" id="stat-errors">--</span></div>
    <div class="stat-pill">Memory: <span class="value" id="stat-memory">--</span></div>
    <div class="stat-pill">Servers: <span class="value" id="stat-servers">--</span></div>
  </div>
</div>

<!-- Toast container -->
<div class="toast-container" id="toasts"></div>

<!-- Main grid -->
<div class="grid">

  <!-- Tool Performance -->
  <div class="card">
    <div class="card-header">
      <h2>Tool Performance</h2>
      <span class="td-dim" id="tool-count"></span>
    </div>
    <div class="card-body" style="padding:0">
      <div class="table-wrap">
        <table id="tool-table">
          <thead>
            <tr>
              <th data-sort="name">Name <span class="sort-arrow"></span></th>
              <th data-sort="calls">Calls <span class="sort-arrow"></span></th>
              <th data-sort="errors">Errors <span class="sort-arrow"></span></th>
              <th data-sort="errorRate">Err% <span class="sort-arrow"></span></th>
              <th data-sort="avgMs">Avg <span class="sort-arrow"></span></th>
              <th data-sort="p99Ms">P99 <span class="sort-arrow"></span></th>
              <th data-sort="lastCalledAt">Last <span class="sort-arrow"></span></th>
            </tr>
          </thead>
          <tbody id="tool-body"></tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- Server Health -->
  <div class="card">
    <div class="card-header">
      <h2>Server Health</h2>
    </div>
    <div class="card-body">
      <div class="server-grid" id="server-grid"></div>
    </div>
  </div>

  <!-- Activity Timeline -->
  <div class="card grid-full">
    <div class="card-header">
      <h2>Activity Timeline (60 min)</h2>
      <span class="td-dim" id="timeline-peak"></span>
    </div>
    <div class="card-body" style="padding: 8px 14px">
      <div class="timeline-container">
        <svg class="timeline-svg" id="timeline-svg" preserveAspectRatio="none"></svg>
        <span class="timeline-label tl-left" id="tl-start"></span>
        <span class="timeline-label tl-right" id="tl-end">now</span>
      </div>
    </div>
  </div>

  <!-- Sessions -->
  <div class="card">
    <div class="card-header">
      <h2>Active Sessions</h2>
      <span class="td-dim" id="session-count"></span>
    </div>
    <div class="card-body" style="padding:0">
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Session</th>
              <th>Client PID</th>
              <th>Servers</th>
              <th>Children</th>
              <th>Last Activity</th>
            </tr>
          </thead>
          <tbody id="session-body"></tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- Clients -->
  <div class="card">
    <div class="card-header">
      <h2>AI Clients</h2>
    </div>
    <div class="card-body" style="padding:0">
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Tool</th>
              <th>Config Path</th>
              <th>Servers</th>
              <th>Registered</th>
            </tr>
          </thead>
          <tbody id="client-body"></tbody>
        </table>
      </div>
    </div>
  </div>

</div>

<!-- Control Bar -->
<div class="control-bar">
  <div class="control-group">
    <div class="toggle-wrap">
      <div class="toggle on" id="gateway-toggle" onclick="toggleGateway()">
        <div class="knob"></div>
      </div>
      <span id="gateway-label">Gateway Enabled</span>
    </div>
    <button class="btn" onclick="toggleInstallForm()">Install Server</button>
    <div class="install-form" id="install-form">
      <input type="text" id="install-name" placeholder="name" style="width:100px">
      <input type="text" id="install-cmd" placeholder="command" style="width:120px">
      <input type="text" id="install-args" placeholder="args (comma-sep)" style="width:150px">
      <button class="btn btn-primary" onclick="installServer()">Add</button>
      <button class="btn" onclick="toggleInstallForm()">Cancel</button>
    </div>
  </div>
  <div class="control-group">
    <span class="td-dim" id="poll-status">Polling...</span>
  </div>
</div>

<script>
(function() {
  'use strict';

  // ── State ─────────────────────────────────────────────────
  var data = null;
  var pollTimer = null;
  var sortCol = 'calls';
  var sortAsc = false;
  var POLL_MS = 3000;

  // ── DOM refs ──────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }

  // ── Escaping — all dynamic values go through this ─────────
  function esc(s) {
    if (!s) return '';
    var el = document.createElement('span');
    el.textContent = s;
    return el.innerHTML;
  }

  // ── Formatting ────────────────────────────────────────────
  function fmtUptime(s) {
    if (s >= 86400) return Math.floor(s/86400) + 'd ' + Math.floor((s%86400)/3600) + 'h';
    if (s >= 3600) return Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'm';
    if (s >= 60) return Math.floor(s/60) + 'm ' + (s%60) + 's';
    return s + 's';
  }
  function fmtAgo(ts) {
    if (!ts) return '--';
    var sec = Math.floor((Date.now() - ts) / 1000);
    if (sec < 5) return 'just now';
    if (sec < 60) return sec + 's ago';
    if (sec < 3600) return Math.floor(sec/60) + 'm ago';
    if (sec < 86400) return Math.floor(sec/3600) + 'h ago';
    return Math.floor(sec/86400) + 'd ago';
  }
  function fmtNum(n) {
    if (n >= 1000000) return (n/1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n/1000).toFixed(1) + 'K';
    return String(n);
  }
  function fmtMs(ms) { return ms < 1000 ? ms + 'ms' : (ms/1000).toFixed(1) + 's'; }
  function fmtPct(rate) { return (rate * 100).toFixed(1) + '%'; }
  function fmtTime(ts) {
    var d = new Date(ts);
    return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
  }
  function shortenPath(p) {
    if (!p) return '--';
    var parts = p.split('/');
    if (parts.length <= 3) return p;
    return '.../' + parts.slice(-2).join('/');
  }

  // ── Toast ─────────────────────────────────────────────────
  function toast(msg, ok) {
    var el = document.createElement('div');
    el.className = 'toast ' + (ok ? 'toast-ok' : 'toast-error');
    el.textContent = msg;
    $('toasts').appendChild(el);
    setTimeout(function() { el.remove(); }, 3000);
  }

  // ── API helpers ───────────────────────────────────────────
  function api(method, path, body) {
    var opts = { method: method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    return fetch(path, opts)
      .then(function(res) { return res.json(); })
      .then(function(json) {
        if (json.error) { toast(json.error, false); return null; }
        return json;
      })
      .catch(function(e) {
        toast('Request failed: ' + e.message, false);
        return null;
      });
  }

  // ── Poll ──────────────────────────────────────────────────
  function poll() {
    fetch('/api/health/stats')
      .then(function(res) { return res.json(); })
      .then(function(json) {
        data = json;
        render();
        $('poll-status').textContent = 'Updated ' + new Date().toLocaleTimeString();
      })
      .catch(function() {
        $('poll-status').textContent = 'Connection lost';
      });
  }

  function startPolling() {
    poll();
    pollTimer = setInterval(poll, POLL_MS);
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  document.addEventListener('visibilitychange', function() {
    if (document.hidden) stopPolling();
    else startPolling();
  });

  // ── Render ────────────────────────────────────────────────
  function render() {
    if (!data) return;
    renderHeader();
    renderToolTable();
    renderServers();
    renderTimeline();
    renderSessions();
    renderClients();
    renderControls();
  }

  function renderHeader() {
    var badge = $('gateway-badge');
    if (data.gatewayEnabled) {
      badge.textContent = 'Running';
      badge.className = 'badge badge-ok';
    } else {
      badge.textContent = 'Disabled';
      badge.className = 'badge badge-disabled';
    }
    $('stat-uptime').textContent = fmtUptime(data.uptimeSeconds);
    $('stat-requests').textContent = fmtNum(data.totalRequests);
    $('stat-errors').textContent = fmtNum(data.totalErrors);
    $('stat-memory').textContent = data.memoryMB + ' MB';
    $('stat-servers').textContent = String(data.servers.length);
  }

  function renderToolTable() {
    var entries = Object.entries(data.toolStats || {});
    $('tool-count').textContent = entries.length + ' tools';

    // Sort
    entries.sort(function(a, b) {
      var va, vb;
      if (sortCol === 'name') { va = a[0]; vb = b[0]; }
      else { va = a[1][sortCol]; vb = b[1][sortCol]; }
      if (typeof va === 'string') return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
      return sortAsc ? va - vb : vb - va;
    });

    var tbody = $('tool-body');
    // Clear existing rows
    while (tbody.firstChild) tbody.removeChild(tbody.firstChild);

    if (entries.length === 0) {
      var emptyTd = document.createElement('td');
      emptyTd.colSpan = 7;
      emptyTd.className = 'empty-state';
      emptyTd.textContent = 'No tool calls yet';
      var emptyTr = document.createElement('tr');
      emptyTr.appendChild(emptyTd);
      tbody.appendChild(emptyTr);
      return;
    }

    for (var i = 0; i < entries.length; i++) {
      var name = entries[i][0];
      var s = entries[i][1];
      var errClass = s.errorRate > 0.1 ? 'td-error' : s.errorRate > 0.01 ? 'td-warn' : 'td-ok';
      var tr = document.createElement('tr');

      var cells = [
        { text: name, cls: 'td-name' },
        { text: fmtNum(s.calls), cls: '' },
        { text: String(s.errors), cls: s.errors > 0 ? 'td-error' : '' },
        { text: fmtPct(s.errorRate), cls: errClass },
        { text: fmtMs(s.avgMs), cls: '' },
        { text: fmtMs(s.p99Ms), cls: '' },
        { text: fmtAgo(s.lastCalledAt), cls: 'td-dim' }
      ];

      for (var j = 0; j < cells.length; j++) {
        var td = document.createElement('td');
        td.textContent = cells[j].text;
        if (cells[j].cls) td.className = cells[j].cls;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
  }

  function renderServers() {
    var grid = $('server-grid');
    // Clear existing
    while (grid.firstChild) grid.removeChild(grid.firstChild);

    if (!data.servers.length) {
      var empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No servers registered';
      grid.appendChild(empty);
      return;
    }

    for (var i = 0; i < data.servers.length; i++) {
      var s = data.servers[i];
      var card = document.createElement('div');
      card.className = 'server-card' + (s.enabled ? '' : ' disabled');

      var dotClass = s.status === 'running' ? 'status-running' :
                     s.status === 'error' ? 'status-error' : 'status-idle';
      var modeBadge = s.mode === 'stateful' ? 'stateful' : 'shared';

      // Top row: name + status dot
      var top = document.createElement('div');
      top.className = 'server-top';
      var nameEl = document.createElement('span');
      nameEl.className = 'server-name';
      nameEl.title = s.name;
      nameEl.textContent = s.name;
      var dot = document.createElement('span');
      dot.className = 'status-dot ' + dotClass;
      dot.title = s.status;
      top.appendChild(nameEl);
      top.appendChild(dot);

      // Meta
      var meta = document.createElement('div');
      meta.className = 'server-meta';
      var spans = [modeBadge, s.activeChildren + ' children', fmtNum(s.totalRequests) + ' reqs'];
      for (var j = 0; j < spans.length; j++) {
        var sp = document.createElement('span');
        sp.textContent = spans[j];
        meta.appendChild(sp);
      }

      // Actions
      var actions = document.createElement('div');
      actions.className = 'server-actions';

      var reconnBtn = document.createElement('button');
      reconnBtn.className = 'btn btn-sm';
      reconnBtn.textContent = 'Reconnect';
      reconnBtn.setAttribute('data-server', s.name);
      reconnBtn.onclick = function() { window.reconnectServer(this.getAttribute('data-server')); };

      var toggleBtn = document.createElement('button');
      toggleBtn.setAttribute('data-server', s.name);
      if (s.enabled) {
        toggleBtn.className = 'btn btn-sm btn-danger';
        toggleBtn.textContent = 'Disable';
        toggleBtn.onclick = function() { window.disableServer(this.getAttribute('data-server')); };
      } else {
        toggleBtn.className = 'btn btn-sm btn-primary';
        toggleBtn.textContent = 'Enable';
        toggleBtn.onclick = function() { window.enableServer(this.getAttribute('data-server')); };
      }

      actions.appendChild(reconnBtn);
      actions.appendChild(toggleBtn);

      card.appendChild(top);
      card.appendChild(meta);
      card.appendChild(actions);
      grid.appendChild(card);
    }
  }

  function renderTimeline() {
    var svg = $('timeline-svg');
    var timeline = data.timeline || [];
    // Clear SVG
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    if (!timeline.length) return;

    var w = svg.clientWidth || 800;
    var h = svg.clientHeight || 120;
    var pad = { top: 8, right: 4, bottom: 20, left: 4 };
    var cw = w - pad.left - pad.right;
    var ch = h - pad.top - pad.bottom;

    var maxReqs = 1;
    for (var i = 0; i < timeline.length; i++) {
      if (timeline[i].requests > maxReqs) maxReqs = timeline[i].requests;
    }

    $('timeline-peak').textContent = 'Peak: ' + maxReqs + ' req/min';

    // Grid lines
    var ns = 'http://www.w3.org/2000/svg';
    for (var g = 1; g <= 3; g++) {
      var line = document.createElementNS(ns, 'line');
      var gy = pad.top + (ch * g / 4);
      line.setAttribute('x1', pad.left);
      line.setAttribute('y1', gy);
      line.setAttribute('x2', pad.left + cw);
      line.setAttribute('y2', gy);
      line.setAttribute('stroke', 'rgba(62,62,66,0.5)');
      line.setAttribute('stroke-dasharray', '2,4');
      svg.appendChild(line);
    }

    // Build request area path
    var reqD = 'M ' + pad.left + ' ' + (pad.top + ch);
    for (var i = 0; i < timeline.length; i++) {
      var x = pad.left + (i / Math.max(1, timeline.length - 1)) * cw;
      var y = pad.top + ch - (timeline[i].requests / maxReqs) * ch;
      reqD += ' L ' + x.toFixed(1) + ' ' + y.toFixed(1);
    }
    reqD += ' L ' + (pad.left + cw) + ' ' + (pad.top + ch) + ' Z';

    var reqPath = document.createElementNS(ns, 'path');
    reqPath.setAttribute('d', reqD);
    reqPath.setAttribute('fill', 'rgba(14,99,156,0.3)');
    reqPath.setAttribute('stroke', 'rgba(14,99,156,0.8)');
    reqPath.setAttribute('stroke-width', '1.5');
    svg.appendChild(reqPath);

    // Build error line path
    var hasErrors = false;
    for (var i = 0; i < timeline.length; i++) {
      if (timeline[i].errors > 0) { hasErrors = true; break; }
    }
    if (hasErrors) {
      var errScale = maxReqs;
      for (var i = 0; i < timeline.length; i++) {
        if (timeline[i].errors > errScale) errScale = timeline[i].errors;
      }
      var errD = '';
      for (var i = 0; i < timeline.length; i++) {
        var x = pad.left + (i / Math.max(1, timeline.length - 1)) * cw;
        var y = pad.top + ch - (timeline[i].errors / errScale) * ch;
        errD += (i === 0 ? 'M ' : ' L ') + x.toFixed(1) + ' ' + y.toFixed(1);
      }
      var errPath = document.createElementNS(ns, 'path');
      errPath.setAttribute('d', errD);
      errPath.setAttribute('fill', 'none');
      errPath.setAttribute('stroke', 'rgba(244,71,71,0.8)');
      errPath.setAttribute('stroke-width', '1.5');
      svg.appendChild(errPath);
    }

    // Time labels
    var intervals = [0, Math.floor(timeline.length/4), Math.floor(timeline.length/2), Math.floor(3*timeline.length/4), timeline.length-1];
    for (var k = 0; k < intervals.length; k++) {
      var idx = intervals[k];
      if (idx < timeline.length) {
        var tx = pad.left + (idx / Math.max(1, timeline.length - 1)) * cw;
        var label = document.createElementNS(ns, 'text');
        label.setAttribute('x', tx);
        label.setAttribute('y', h - 4);
        label.setAttribute('fill', '#808080');
        label.setAttribute('font-size', '9');
        label.setAttribute('text-anchor', 'middle');
        label.textContent = fmtTime(timeline[idx].minuteTs);
        svg.appendChild(label);
      }
    }

    // Time range labels
    if (timeline.length > 0) {
      $('tl-start').textContent = fmtTime(timeline[0].minuteTs);
    }
  }

  function renderSessions() {
    var sessions = data.sessions || [];
    $('session-count').textContent = sessions.length + ' sessions';

    var tbody = $('session-body');
    while (tbody.firstChild) tbody.removeChild(tbody.firstChild);

    if (!sessions.length) {
      var emptyTd = document.createElement('td');
      emptyTd.colSpan = 5;
      emptyTd.className = 'empty-state';
      emptyTd.textContent = 'No active sessions';
      var emptyTr = document.createElement('tr');
      emptyTr.appendChild(emptyTd);
      tbody.appendChild(emptyTr);
      return;
    }

    for (var i = 0; i < sessions.length; i++) {
      var s = sessions[i];
      var tr = document.createElement('tr');
      var cells = [
        { text: s.sessionId.slice(0,8), cls: 'td-dim', title: s.sessionId },
        { text: s.clientPid ? String(s.clientPid) : '--', cls: '' },
        { text: s.servers.join(', '), cls: 'td-name' },
        { text: String(s.childCount), cls: '' },
        { text: fmtAgo(s.lastActivityAt), cls: 'td-dim' }
      ];
      for (var j = 0; j < cells.length; j++) {
        var td = document.createElement('td');
        td.textContent = cells[j].text;
        if (cells[j].cls) td.className = cells[j].cls;
        if (cells[j].title) td.title = cells[j].title;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
  }

  function renderClients() {
    var clients = data.clients || [];
    var tbody = $('client-body');
    while (tbody.firstChild) tbody.removeChild(tbody.firstChild);

    if (!clients.length) {
      var emptyTd = document.createElement('td');
      emptyTd.colSpan = 4;
      emptyTd.className = 'empty-state';
      emptyTd.textContent = 'No AI clients registered';
      var emptyTr = document.createElement('tr');
      emptyTr.appendChild(emptyTd);
      tbody.appendChild(emptyTr);
      return;
    }

    for (var i = 0; i < clients.length; i++) {
      var c = clients[i];
      var tr = document.createElement('tr');
      var cells = [
        { text: c.tool, cls: 'td-name' },
        { text: shortenPath(c.configPath), cls: 'td-dim', title: c.configPath },
        { text: String(c.serverCount), cls: '' },
        { text: fmtAgo(c.registeredAt), cls: 'td-dim' }
      ];
      for (var j = 0; j < cells.length; j++) {
        var td = document.createElement('td');
        td.textContent = cells[j].text;
        if (cells[j].cls) td.className = cells[j].cls;
        if (cells[j].title) td.title = cells[j].title;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
  }

  function renderControls() {
    var toggle = $('gateway-toggle');
    var label = $('gateway-label');
    if (data.gatewayEnabled) {
      toggle.className = 'toggle on';
      label.textContent = 'Gateway Enabled';
    } else {
      toggle.className = 'toggle';
      label.textContent = 'Gateway Disabled';
    }
  }

  // ── Actions (exposed globally) ────────────────────────────
  window.reconnectServer = function(name) {
    api('POST', '/api/servers/' + encodeURIComponent(name) + '/reconnect')
      .then(function(res) { if (res) { toast('Reconnected: ' + name, true); poll(); } });
  };

  window.disableServer = function(name) {
    api('POST', '/api/servers/' + encodeURIComponent(name) + '/disable')
      .then(function(res) { if (res) { toast('Disabled: ' + name, true); poll(); } });
  };

  window.enableServer = function(name) {
    api('POST', '/api/servers/' + encodeURIComponent(name) + '/enable')
      .then(function(res) { if (res) { toast('Enabled: ' + name, true); poll(); } });
  };

  window.toggleGateway = function() {
    var endpoint = data.gatewayEnabled ? '/api/gateway/disable' : '/api/gateway/enable';
    api('POST', endpoint)
      .then(function(res) { if (res) { toast(data.gatewayEnabled ? 'Gateway disabled' : 'Gateway enabled', true); poll(); } });
  };

  window.toggleInstallForm = function() {
    var form = $('install-form');
    form.classList.toggle('show');
    if (form.classList.contains('show')) $('install-name').focus();
  };

  window.installServer = function() {
    var name = $('install-name').value.trim();
    var command = $('install-cmd').value.trim();
    var argsStr = $('install-args').value.trim();
    if (!name || !command) { toast('Name and command are required', false); return; }
    var args = argsStr ? argsStr.split(',').map(function(a) { return a.trim(); }).filter(Boolean) : undefined;
    api('POST', '/api/servers/install', { name: name, command: command, args: args })
      .then(function(res) {
        if (res) {
          toast('Installed: ' + name, true);
          $('install-name').value = '';
          $('install-cmd').value = '';
          $('install-args').value = '';
          window.toggleInstallForm();
          poll();
        }
      });
  };

  // ── Sort ──────────────────────────────────────────────────
  var sortHeaders = document.querySelectorAll('#tool-table th[data-sort]');
  for (var k = 0; k < sortHeaders.length; k++) {
    sortHeaders[k].addEventListener('click', function() {
      var col = this.getAttribute('data-sort');
      if (sortCol === col) sortAsc = !sortAsc;
      else { sortCol = col; sortAsc = col === 'name'; }

      // Update arrows
      var arrows = document.querySelectorAll('#tool-table th .sort-arrow');
      for (var a = 0; a < arrows.length; a++) arrows[a].textContent = '';
      this.querySelector('.sort-arrow').textContent = sortAsc ? '\\u25B2' : '\\u25BC';

      renderToolTable();
    });
  }

  // ── Start ─────────────────────────────────────────────────
  startPolling();
})();
</script>
</body>
</html>`;
}
