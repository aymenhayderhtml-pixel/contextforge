/**
 * public/js/graph/render.js
 * D3 Force-Directed Dependency Graph Visualization.
 * Handles zooming, panning, clustering, search, focus mode, and orphan node grouping.
 */

import { state, subscribe, notifyStateChange } from '../state.js';

export const TYPE_COLORS = {
  scene:  '#ef4444',
  script: '#a855f7',
  module: '#60a5fa',
  asset:  '#10b981'
};

export const EDGE_COLORS = {
  ext_resource:      '#3f3f46',
  signal_connection: '#ef4444',
  import:            '#71717a',
  asset_ref:         '#10b981',
  requires:          '#d97706'
};

export let simulation = null;
export let currentZoom = null;
export let currentSvg = null;
export let isFocusMode = false;
export let searchQuery = '';
export let clusterThreshold = 20;
export let expandedFolders = new Set();
export let clusterEnabled = true;
export let groupOrphansEnabled = true;
export let pinnedNodePositions = new Map(); // id -> { fx, fy } for T041

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escJsArg(str) {
  if (!str) return '';
  return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function basename(path) {
  return (path || '').split('/').pop();
}

export function getNodeFolder(nodeId) {
  const idx = (nodeId || '').lastIndexOf('/');
  return idx > 0 ? nodeId.substring(0, idx) : '.';
}

export function fitToView() {
  if (!currentSvg || !currentZoom) return;
  const graphContainer = document.getElementById('graph-container');
  if (!graphContainer) return;

  const nodesData = d3.selectAll('.node-group').data();
  if (!nodesData || nodesData.length === 0) return;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  nodesData.forEach(d => {
    if (d.x !== undefined && d.y !== undefined) {
      if (d.x < minX) minX = d.x;
      if (d.x > maxX) maxX = d.x;
      if (d.y < minY) minY = d.y;
      if (d.y > maxY) maxY = d.y;
    }
  });

  if (minX === Infinity) return;

  const width = graphContainer.clientWidth;
  const height = graphContainer.clientHeight;
  const dx = Math.max(maxX - minX, 100);
  const dy = Math.max(maxY - minY, 100);
  const scale = Math.max(0.15, Math.min(2.5, 0.82 / Math.max(dx / width, dy / height)));
  const tx = (width - scale * (minX + maxX)) / 2;
  const ty = (height - scale * (minY + maxY)) / 2;

  currentSvg.transition().duration(600).call(
    currentZoom.transform,
    d3.zoomIdentity.translate(tx, ty).scale(scale)
  );
}

export function handleSearchInput() {
  const searchInput = document.getElementById('search-input');
  searchQuery = (searchInput?.value || '').trim().toLowerCase();
  applyGraphFilters();
}

export function searchAndCenterFirstMatch() {
  handleSearchInput();
  const graphContainer = document.getElementById('graph-container');
  if (!searchQuery || !currentSvg || !currentZoom || !graphContainer) return;

  const nodesData = d3.selectAll('.node-group').data();
  const match = nodesData.find(d =>
    (d.id && d.id.toLowerCase().includes(searchQuery)) ||
    (d.label && d.label.toLowerCase().includes(searchQuery))
  );

  if (match && match.x !== undefined && match.y !== undefined) {
    const width = graphContainer.clientWidth;
    const height = graphContainer.clientHeight;
    const scale = 1.5;
    const tx = width / 2 - match.x * scale;
    const ty = height / 2 - match.y * scale;

    currentSvg.transition().duration(500).call(
      currentZoom.transform,
      d3.zoomIdentity.translate(tx, ty).scale(scale)
    );

    if (!match.isCluster && window.ContextForge && window.ContextForge.selectNode) {
      window.ContextForge.selectNode(match.id);
    }
  }
}

export function highlightNode(nodeId) {
  applyGraphFilters();
}

export function applyGraphFilters() {
  const manifest = state.manifest;
  if (!manifest) return;

  let focusNeighborhood = null;
  if (isFocusMode && state.selectedNodeId) {
    focusNeighborhood = new Set([state.selectedNodeId]);
    manifest.edges.forEach(e => {
      if (e.from === state.selectedNodeId) focusNeighborhood.add(e.to);
      if (e.to === state.selectedNodeId) focusNeighborhood.add(e.from);
    });
  }

  const nodesSel = d3.selectAll('.node-group');
  const linksSel = d3.selectAll('.link-line');
  const edgeLabelsSel = d3.selectAll('.edge-label');

  nodesSel.each(function(d) {
    let matchesSearch = true;
    if (searchQuery) {
      matchesSearch = (d.id && d.id.toLowerCase().includes(searchQuery)) ||
                      (d.label && d.label.toLowerCase().includes(searchQuery));
    }

    let inFocus = true;
    if (focusNeighborhood) {
      inFocus = focusNeighborhood.has(d.id);
    }

    const visible = matchesSearch && inFocus;
    d3.select(this)
      .transition()
      .duration(200)
      .style('opacity', visible ? 1 : 0.08)
      .style('pointer-events', visible ? 'all' : 'none');
  });

  linksSel.each(function(d) {
    let opacity = 0.6;
    const sId = typeof d.source === 'object' ? d.source.id : d.source;
    const tId = typeof d.target === 'object' ? d.target.id : d.target;

    if (searchQuery) {
      const sMatch = sId && sId.toLowerCase().includes(searchQuery);
      const tMatch = tId && tId.toLowerCase().includes(searchQuery);
      if (!sMatch && !tMatch) opacity = 0.05;
    }

    if (focusNeighborhood) {
      const sInFocus = focusNeighborhood.has(sId);
      const tInFocus = focusNeighborhood.has(tId);
      if (!sInFocus || !tInFocus) opacity = 0.03;
    }

    d3.select(this).attr('stroke-opacity', opacity);
  });

  edgeLabelsSel.style('opacity', (searchQuery || focusNeighborhood) ? 0.2 : 1);
}

export function handleResize() {
  const graphContainer = document.getElementById('graph-container');
  if (!currentSvg || !graphContainer) return;
  const width = graphContainer.clientWidth;
  const height = graphContainer.clientHeight;
  currentSvg.attr('width', width).attr('height', height);
}

export function renderGraph() {
  const manifest = state.manifest;
  if (!manifest) return;

  d3.select('#graph-container svg').remove();
  if (simulation) simulation.stop();

  const legend = document.getElementById('legend');
  if (legend) legend.style.display = 'block';

  const container = document.getElementById('graph-container');
  if (!container) return;
  const width = container.clientWidth;
  const height = container.clientHeight;

  // 1. Identify orphan nodes
  const connectedNodeIds = new Set();
  for (const e of manifest.edges) {
    connectedNodeIds.add(e.from);
    connectedNodeIds.add(e.to);
  }

  const orphanNodes = manifest.nodes.filter(n => !connectedNodeIds.has(n.id));
  const unconnectedPanel = document.getElementById('unconnected-panel');
  const unconnectedCount = document.getElementById('unconnected-count');
  const unconnectedList = document.getElementById('unconnected-list');

  if (orphanNodes.length > 0 && groupOrphansEnabled) {
    if (unconnectedPanel) unconnectedPanel.style.display = 'block';
    if (unconnectedCount) unconnectedCount.textContent = orphanNodes.length;
    if (unconnectedList) {
      unconnectedList.innerHTML = orphanNodes.map(n =>
        `<li class="unconnected-item" title="${esc(n.id)}" onclick="window.ContextForge.selectNode('${escJsArg(n.id)}')">📄 ${esc(basename(n.id))}</li>`
      ).join('');
    }
  } else {
    if (unconnectedPanel) unconnectedPanel.style.display = 'none';
  }

  let graphRawNodes = manifest.nodes;
  if (groupOrphansEnabled && orphanNodes.length > 0) {
    graphRawNodes = manifest.nodes.filter(n => connectedNodeIds.has(n.id));
  }

  // 2. Folder-based clustering
  const shouldCluster = clusterEnabled && manifest.nodes.length > clusterThreshold;
  let displayNodes = [];
  const nodeToDisplayId = new Map();

  if (shouldCluster) {
    const folderGroups = new Map();
    for (const n of graphRawNodes) {
      const folder = getNodeFolder(n.id);
      if (!folderGroups.has(folder)) folderGroups.set(folder, []);
      folderGroups.get(folder).push(n);
    }

    for (const [folder, groupNodes] of folderGroups.entries()) {
      if (groupNodes.length <= 1 || expandedFolders.has(folder)) {
        for (const n of groupNodes) {
          nodeToDisplayId.set(n.id, n.id);
          displayNodes.push({ ...n, isCluster: false });
        }
      } else {
        const clusterId = `cluster:${folder}`;
        for (const n of groupNodes) {
          nodeToDisplayId.set(n.id, clusterId);
        }
        const mainType = groupNodes[0].type;
        displayNodes.push({
          id: clusterId,
          label: `${folder} (${groupNodes.length})`,
          folder,
          type: mainType,
          isCluster: true,
          count: groupNodes.length
        });
      }
    }
  } else {
    for (const n of graphRawNodes) {
      nodeToDisplayId.set(n.id, n.id);
      displayNodes.push({ ...n, isCluster: false });
    }
  }

  // Build edges
  const edgeKeyMap = new Map();
  for (const e of manifest.edges) {
    const sourceDisplay = nodeToDisplayId.get(e.from);
    const targetDisplay = nodeToDisplayId.get(e.to);
    if (!sourceDisplay || !targetDisplay) continue;
    if (sourceDisplay === targetDisplay) continue;

    const key = `${sourceDisplay}->${targetDisplay}:${e.edge_type}`;
    if (!edgeKeyMap.has(key)) {
      edgeKeyMap.set(key, {
        source: sourceDisplay,
        target: targetDisplay,
        edge_type: e.edge_type,
        count: 1
      });
    } else {
      edgeKeyMap.get(key).count++;
    }
  }

  const displayEdges = Array.from(edgeKeyMap.values());

  // Restore pinned positions
  displayNodes.forEach(d => {
    if (pinnedNodePositions.has(d.id)) {
      const pos = pinnedNodePositions.get(d.id);
      d.fx = pos.fx;
      d.fy = pos.fy;
    }
  });

  // SVG Setup
  const svg = d3.select(container)
    .append('svg')
    .attr('width', width)
    .attr('height', height);

  currentSvg = svg;

  const g = svg.append('g');

  const zoom = d3.zoom()
    .scaleExtent([0.1, 5])
    .on('zoom', (event) => {
      g.attr('transform', event.transform);
    });

  currentZoom = zoom;
  svg.call(zoom);

  // Markers
  const defs = svg.append('defs');
  Object.keys(EDGE_COLORS).forEach(type => {
    defs.append('marker')
      .attr('id', `arrow-${type}`)
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 22)
      .attr('refY', 0)
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-5L10,0L0,5')
      .attr('fill', EDGE_COLORS[type]);
  });

  // Simulation
  simulation = d3.forceSimulation(displayNodes)
    .force('link', d3.forceLink(displayEdges).id(d => d.id).distance(d => d.isCluster ? 140 : 100))
    .force('charge', d3.forceManyBody().strength(d => d.isCluster ? -450 : -280))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collision', d3.forceCollide().radius(d => d.isCluster ? 38 : 26))
    .alphaDecay(0.04)
    .alphaMin(0.001);

  // Links
  const link = g.append('g')
    .attr('class', 'links')
    .selectAll('line')
    .data(displayEdges)
    .enter().append('line')
    .attr('class', 'link-line')
    .attr('stroke', d => EDGE_COLORS[d.edge_type] || '#475569')
    .attr('stroke-width', d => Math.min(4, 1.2 + Math.log2(d.count || 1)))
    .attr('stroke-opacity', 0.6)
    .attr('stroke-dasharray', d => d.edge_type === 'requires' ? '4,4' : null)
    .attr('marker-end', d => `url(#arrow-${d.edge_type})`);

  // Nodes
  const node = g.append('g')
    .attr('class', 'nodes')
    .selectAll('.node-group')
    .data(displayNodes)
    .enter().append('g')
    .attr('class', 'node-group')
    .call(d3.drag()
      .on('start', (event, d) => {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on('drag', (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on('end', (event, d) => {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = event.x;
        d.fy = event.y;
        pinnedNodePositions.set(d.id, { fx: event.x, fy: event.y });
      })
    );

  // Cluster shape vs node circle
  node.each(function(d) {
    const el = d3.select(this);
    if (d.isCluster) {
      el.append('rect')
        .attr('class', 'cluster-shape')
        .attr('x', -24)
        .attr('y', -24)
        .attr('width', 48)
        .attr('height', 48)
        .attr('rx', 8)
        .attr('fill', '#1c1c1c')
        .attr('stroke', TYPE_COLORS[d.type] || '#60a5fa')
        .attr('stroke-width', 2)
        .attr('stroke-dasharray', '4,2');

      el.append('text')
        .attr('text-anchor', 'middle')
        .attr('dy', 5)
        .attr('fill', '#f4f4f5')
        .attr('font-size', '11px')
        .attr('font-weight', '700')
        .text(d.count);
    } else {
      el.append('circle')
        .attr('r', 16)
        .attr('fill', '#141414')
        .attr('stroke', TYPE_COLORS[d.type] || '#a1a1aa')
        .attr('stroke-width', 2);

      // Lock ring if locked
      if (state.currentLocks && state.currentLocks[d.id]) {
        el.append('circle')
          .attr('class', 'lock-ring')
          .attr('r', 20)
          .attr('fill', 'none')
          .attr('stroke', '#fbbf24')
          .attr('stroke-width', 2)
          .attr('stroke-dasharray', '3,3');
      }
    }
  });

  // Labels
  node.append('text')
    .attr('class', 'node-label-substrate')
    .attr('x', 0)
    .attr('y', d => d.isCluster ? 36 : 28)
    .attr('text-anchor', 'middle')
    .text(d => d.label || basename(d.id));

  node.append('text')
    .attr('class', 'node-label')
    .attr('x', 0)
    .attr('y', d => d.isCluster ? 36 : 28)
    .attr('text-anchor', 'middle')
    .text(d => d.label || basename(d.id));

  // Hover — purely visual without simulation restart (T039)
  const tooltip = document.getElementById('tooltip');
  node.on('mouseenter', (event, d) => {
    d3.select(event.currentTarget).select('circle, rect')
      .attr('stroke-width', 3.5);

    if (tooltip) {
      tooltip.style.display = 'block';
      tooltip.style.left = (event.clientX + 14) + 'px';
      tooltip.style.top = (event.clientY + 14) + 'px';
      tooltip.innerHTML = d.isCluster
        ? `<strong>Folder:</strong> ${esc(d.folder)}<br><strong>Files:</strong> ${d.count} (Click to expand)`
        : `<strong>${esc(basename(d.id))}</strong><br><span style="color:var(--dim); font-size:0.7rem;">${esc(d.id)}</span>`;
    }
  }).on('mousemove', (event) => {
    if (tooltip && tooltip.style.display === 'block') {
      tooltip.style.left = (event.clientX + 14) + 'px';
      tooltip.style.top = (event.clientY + 14) + 'px';
    }
  }).on('mouseleave', (event) => {
    d3.select(event.currentTarget).select('circle, rect')
      .attr('stroke-width', 2);
    if (tooltip) tooltip.style.display = 'none';
  });

  // Click
  node.on('click', (event, d) => {
    event.stopPropagation();
    if (d.isCluster) {
      expandedFolders.add(d.folder);
      renderGraph();
    } else {
      if (window.ContextForge && window.ContextForge.selectNode) {
        window.ContextForge.selectNode(d.id);
      }
    }
  });

  simulation.on('tick', () => {
    link
      .attr('x1', d => d.source.x)
      .attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x)
      .attr('y2', d => d.target.y);

    node.attr('transform', d => `translate(${d.x},${d.y})`);
  });
}
