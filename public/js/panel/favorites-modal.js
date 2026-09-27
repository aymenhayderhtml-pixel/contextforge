/**
 * public/js/panel/favorites-modal.js
 * Cross-project favorites library UI & Slot Contract filtering (T124, T126).
 */

import { state } from '../state.js';
import { showToast } from '../shared/toast.js';

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function basename(p) {
  if (!p) return '';
  const parts = p.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1];
}

/**
 * Checks if a favorite asset satisfies the target slot contract (reusing Phase 7 validation logic).
 * @param {object} fav - Favorite asset object
 * @param {object} slotContract - Target slot contract
 * @returns {{ compatible: boolean, reasons: string[] }}
 */
export function checkFavoriteCompatibility(fav, slotContract) {
  const reasons = [];
  if (!slotContract) return { compatible: true, reasons: [] };

  const expectedFormat = (slotContract.format || '').toLowerCase();
  const actualFormat = (fav.format || fav.assetInfo?.format || '').toLowerCase();

  // 1. Format check
  if (expectedFormat && actualFormat && expectedFormat !== actualFormat) {
    const isGlbPair = (expectedFormat === 'glb' && actualFormat === 'gltf') || (expectedFormat === 'gltf' && actualFormat === 'glb');
    const isJpgPair = (expectedFormat === 'jpg' && actualFormat === 'jpeg') || (expectedFormat === 'jpeg' && actualFormat === 'jpg');
    if (!isGlbPair && !isJpgPair) {
      reasons.push(`Format: requires "${expectedFormat}", asset is "${actualFormat}"`);
    }
  }

  const assetInfo = fav.assetInfo || {};

  // 2. Expected animations check
  if (Array.isArray(slotContract.expected_animations) && slotContract.expected_animations.length > 0) {
    const assetAnims = new Set(assetInfo.animations || []);
    const missing = slotContract.expected_animations.filter(a => !assetAnims.has(a));
    if (missing.length > 0) {
      reasons.push(`Missing animation(s): ${missing.join(', ')}`);
    }
  }

  // 3. Rigged requirement
  if (slotContract.rigged === true && assetInfo.rigged === false) {
    reasons.push('Rigging: slot requires rigged model with bones/skin');
  }

  // 4. Dimensions check
  if (slotContract.dimensions && assetInfo.dimensions && slotContract.dimensions !== assetInfo.dimensions) {
    reasons.push(`Dimensions: requires "${slotContract.dimensions}", got "${assetInfo.dimensions}"`);
  }

  // 5. Max size check
  if (slotContract.max_size_kb && fav.fileSize) {
    const sizeKb = fav.fileSize / 1024;
    if (sizeKb > slotContract.max_size_kb) {
      reasons.push(`Size: ${sizeKb.toFixed(1)} KB exceeds limit of ${slotContract.max_size_kb} KB`);
    }
  }

  return {
    compatible: reasons.length === 0,
    reasons
  };
}

/**
 * Opens the Favorites Picker modal filtered by target slot contract.
 * @param {object} node - Target asset node in manifest
 * @param {object} [callbacks] - Optional callbacks { onSwapped: (fav) => void }
 */
export async function openFavoritesPickerModal(node, callbacks = {}) {
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;

  const slotContract = node?.slot || node?.contract?.slot || {};
  let filterCompatible = true;
  let searchQuery = '';
  let selectedTag = '';

  let allFavorites = [];

  async function fetchFavoritesList() {
    try {
      const res = await fetch('/favorites');
      const data = await res.json();
      if (data && Array.isArray(data.favorites)) {
        allFavorites = data.favorites;
      }
    } catch (err) {
      console.error('Failed to load favorites:', err);
      allFavorites = [];
    }
  }

  await fetchFavoritesList();

  function renderModal() {
    // Compute compatibility for each favorite
    const evaluated = allFavorites.map(fav => ({
      fav,
      check: checkFavoriteCompatibility(fav, slotContract)
    }));

    const compatibleCount = evaluated.filter(e => e.check.compatible).length;

    // Collect unique tags
    const tagSet = new Set();
    allFavorites.forEach(f => {
      if (Array.isArray(f.tags)) f.tags.forEach(t => tagSet.add(t));
    });
    const tags = Array.from(tagSet);

    // Apply filtering
    let visible = evaluated;
    if (filterCompatible && Object.keys(slotContract).length > 0) {
      visible = visible.filter(e => e.check.compatible);
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      visible = visible.filter(e =>
        e.fav.name.toLowerCase().includes(q) ||
        (Array.isArray(e.fav.tags) && e.fav.tags.some(t => t.toLowerCase().includes(q)))
      );
    }
    if (selectedTag) {
      visible = visible.filter(e => Array.isArray(e.fav.tags) && e.fav.tags.includes(selectedTag));
    }

    modalRoot.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal" style="max-width: 680px; max-height: 85vh; display:flex; flex-direction:column;">
          <div class="modal-header">
            <h2 style="font-size:1rem; margin:0; display:flex; align-items:center; gap:0.4rem;">
              <span>⭐</span> Cross-Project Favorites Library
            </h2>
            <button class="modal-close" id="btn-close-fav-modal">✕</button>
          </div>

          <div class="modal-body" style="flex:1; overflow-y:auto; padding:1rem; font-size:0.8rem;">
            <!-- Target Slot Context -->
            <div style="background:rgba(30,41,59,0.5); border:1px solid var(--border); border-radius:6px; padding:0.6rem 0.8rem; margin-bottom:0.8rem;">
              <div style="font-size:0.75rem; color:var(--dim); margin-bottom:0.2rem;">Target Slot:</div>
              <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.4rem;">
                <code style="font-size:0.8rem; color:var(--text); font-weight:600;">${esc(node?.id || 'Unnamed slot')}</code>
                <div style="display:flex; gap:0.3rem;">
                  <span class="slot-chip">${esc((slotContract.format || 'any').toUpperCase())}</span>
                  ${slotContract.rigged ? '<span class="slot-chip">RIGGED</span>' : ''}
                  ${slotContract.dimensions ? `<span class="slot-chip">${esc(slotContract.dimensions)}</span>` : ''}
                  ${(slotContract.expected_animations && slotContract.expected_animations.length > 0) ? `<span class="slot-chip">🎬 ${slotContract.expected_animations.length} Anims</span>` : ''}
                </div>
              </div>
            </div>

            <!-- Filter Controls -->
            <div style="display:flex; gap:0.6rem; align-items:center; margin-bottom:0.8rem; flex-wrap:wrap;">
              <input type="text" id="fav-search-input" placeholder="Search favorites by name or tag..." value="${esc(searchQuery)}" style="flex:1; min-width:180px; font-size:0.75rem; padding:0.3rem 0.6rem; background:rgba(0,0,0,0.3); border:1px solid var(--border); border-radius:4px; color:var(--text);" />
              
              <label style="display:inline-flex; align-items:center; gap:0.3rem; font-size:0.75rem; color:var(--text); cursor:pointer; user-select:none;">
                <input type="checkbox" id="chk-filter-compatible" ${filterCompatible ? 'checked' : ''} />
                <span>Show compatible only (${compatibleCount}/${allFavorites.length})</span>
              </label>
            </div>

            ${tags.length > 0 ? `
              <div style="display:flex; gap:0.3rem; flex-wrap:wrap; margin-bottom:0.8rem; align-items:center;">
                <span style="font-size:0.7rem; color:var(--dim);">Tags:</span>
                <span class="slot-chip ${!selectedTag ? 'active' : ''}" style="cursor:pointer;" id="tag-filter-all">all</span>
                ${tags.map(t => `
                  <span class="slot-chip ${selectedTag === t ? 'active' : ''}" style="cursor:pointer;" data-tag="${esc(t)}">#${esc(t)}</span>
                `).join('')}
              </div>
            ` : ''}

            <!-- Favorites List -->
            <div id="favorites-cards-container" style="display:flex; flex-direction:column; gap:0.6rem;">
              ${visible.length === 0 ? `
                <div style="text-align:center; padding:2rem 1rem; color:var(--dim); background:rgba(0,0,0,0.15); border-radius:6px;">
                  <div style="font-size:1.5rem; margin-bottom:0.4rem;">📦</div>
                  <div style="font-weight:600; margin-bottom:0.2rem;">No matching favorite assets found</div>
                  <div style="font-size:0.72rem;">${allFavorites.length === 0 ? 'Star an asset in your project or upload below to build your library.' : 'Try unchecking "Show compatible only" or clearing search filters.'}</div>
                </div>
              ` : visible.map(({ fav, check }) => `
                <div class="favorite-card" style="display:flex; gap:0.8rem; align-items:center; background:rgba(15,23,42,0.6); border:1px solid ${check.compatible ? 'rgba(34,197,94,0.3)' : 'var(--border)'}; border-radius:6px; padding:0.6rem 0.8rem;">
                  <div style="width:48px; height:48px; border-radius:4px; background:#1e293b; display:flex; align-items:center; justify-content:center; overflow:hidden; flex-shrink:0;">
                    ${fav.thumbnail ? `<img src="${esc(fav.thumbnail)}" style="width:100%; height:100%; object-fit:cover;" />` : `<span style="font-size:1.3rem;">🎨</span>`}
                  </div>

                  <div style="flex:1; min-width:0;">
                    <div style="display:flex; align-items:center; gap:0.4rem; flex-wrap:wrap; margin-bottom:0.2rem;">
                      <strong style="color:var(--text); font-size:0.82rem; overflow:hidden; text-overflow:ellipsis;">${esc(fav.name)}</strong>
                      <span class="slot-chip">${esc((fav.format || '').toUpperCase())}</span>
                      ${fav.assetInfo?.rigged ? '<span class="slot-chip">RIGGED</span>' : ''}
                      ${check.compatible ? '<span style="font-size:0.68rem; color:#4ade80; font-weight:600;">✓ Compatible</span>' : '<span style="font-size:0.68rem; color:#f87171; font-weight:600;">⚠️ Incompatible</span>'}
                    </div>

                    ${Array.isArray(fav.tags) && fav.tags.length > 0 ? `
                      <div style="display:flex; gap:0.25rem; flex-wrap:wrap; margin-bottom:0.2rem;">
                        ${fav.tags.map(t => `<span style="font-size:0.65rem; color:var(--dim); background:rgba(255,255,255,0.05); padding:1px 4px; border-radius:3px;">#${esc(t)}</span>`).join('')}
                      </div>
                    ` : ''}

                    ${!check.compatible && check.reasons.length > 0 ? `
                      <div style="font-size:0.68rem; color:#f87171; margin-top:0.2rem;">
                        ${check.reasons.map(r => `• ${esc(r)}`).join(' ')}
                      </div>
                    ` : ''}
                  </div>

                  <div style="display:flex; gap:0.35rem; align-items:center; flex-shrink:0;">
                    <button type="button" class="btn-swap-fav" data-id="${esc(fav.id)}" style="background:${check.compatible ? '#238636' : '#334155'}; color:#fff; border:none; padding:0.3rem 0.75rem; border-radius:4px; font-size:0.75rem; font-weight:600; cursor:pointer;" ${!check.compatible ? 'title="Asset does not satisfy contract requirements"' : ''}>
                      ⚡ Swap In
                    </button>
                    <button type="button" class="secondary btn-del-fav" data-id="${esc(fav.id)}" title="Remove from favorites" style="font-size:0.75rem; padding:0.3rem 0.5rem;">
                      🗑
                    </button>
                  </div>
                </div>
              `).join('')}
            </div>

            <!-- Upload / Star to Library Section -->
            <div style="margin-top:1.2rem; border-top:1px solid var(--border); padding-top:0.8rem;">
              <details style="font-size:0.75rem; color:var(--dim);">
                <summary style="cursor:pointer; font-weight:600; color:var(--text); margin-bottom:0.5rem; user-select:none;">
                  ➕ Star Current Project Asset or Upload New Asset to Library
                </summary>

                <div style="background:rgba(0,0,0,0.25); border:1px solid var(--border); border-radius:6px; padding:0.8rem; margin-top:0.4rem;">
                  <div style="display:flex; flex-direction:column; gap:0.5rem;">
                    <div>
                      <label style="display:block; margin-bottom:0.2rem; font-weight:600; color:var(--text);">Asset Name</label>
                      <input type="text" id="new-fav-name" placeholder="e.g. Hero_Knight.glb" value="${esc(basename(node?.id || ''))}" style="width:100%; box-sizing:border-box; font-size:0.75rem; padding:0.3rem 0.5rem; background:rgba(0,0,0,0.3); border:1px solid var(--border); border-radius:4px; color:var(--text);" />
                    </div>

                    <div>
                      <label style="display:block; margin-bottom:0.2rem; font-weight:600; color:var(--text);">Tags (comma-separated)</label>
                      <input type="text" id="new-fav-tags" placeholder="e.g. character, player, fantasy, rigged" style="width:100%; box-sizing:border-box; font-size:0.75rem; padding:0.3rem 0.5rem; background:rgba(0,0,0,0.3); border:1px solid var(--border); border-radius:4px; color:var(--text);" />
                    </div>

                    <div style="display:flex; justify-content:space-between; align-items:center; margin-top:0.3rem;">
                      <button type="button" id="btn-star-current-file" class="secondary" style="font-size:0.75rem; padding:0.3rem 0.7rem; display:inline-flex; align-items:center; gap:0.3rem;">
                        ⭐ Star Current Slot Asset (${esc(basename(node?.id || ''))})
                      </button>

                      <label class="secondary" style="font-size:0.75rem; padding:0.3rem 0.7rem; display:inline-flex; align-items:center; gap:0.3rem; cursor:pointer;">
                        📁 Upload File to Library
                        <input type="file" id="new-fav-file-input" style="display:none;" />
                      </label>
                    </div>
                  </div>
                </div>
              </details>
            </div>
          </div>

          <div class="modal-footer" style="justify-content:flex-end;">
            <button class="secondary" id="btn-close-fav-footer">Done</button>
          </div>
        </div>
      </div>
    `;

    bindEvents();
  }

  function bindEvents() {
    const closeFn = () => { modalRoot.innerHTML = ''; };
    document.getElementById('btn-close-fav-modal')?.addEventListener('click', closeFn);
    document.getElementById('btn-close-fav-footer')?.addEventListener('click', closeFn);

    const searchInput = document.getElementById('fav-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        searchQuery = e.target.value.trim();
        renderModal();
      });
    }

    const chkFilter = document.getElementById('chk-filter-compatible');
    if (chkFilter) {
      chkFilter.addEventListener('change', (e) => {
        filterCompatible = e.target.checked;
        renderModal();
      });
    }

    document.getElementById('tag-filter-all')?.addEventListener('click', () => {
      selectedTag = '';
      renderModal();
    });

    document.querySelectorAll('[data-tag]').forEach(el => {
      el.addEventListener('click', () => {
        selectedTag = el.getAttribute('data-tag');
        renderModal();
      });
    });

    // Swap In handlers
    document.querySelectorAll('.btn-swap-fav').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        btn.disabled = true;
        btn.textContent = '⏳ Swapping...';

        try {
          const res = await fetch(`/favorites/${encodeURIComponent(id)}/swap-into`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              nodeId: node.id,
              projectPath: state.projectPath
            })
          });
          const data = await res.json();
          if (res.ok && data.success) {
            showToast(`✓ Swapped in favorite "${data.favoriteName}" into ${basename(node.id)}!`, 'success');
            closeFn();
            if (callbacks.onSwapped) callbacks.onSwapped(data);
            if (window.ContextForge && window.ContextForge.doExtract) {
              window.ContextForge.doExtract(state.projectPath);
            }
          } else {
            showToast(data.error || 'Failed to swap favorite', 'error');
            btn.disabled = false;
            btn.textContent = '⚡ Swap In';
          }
        } catch (err) {
          showToast(`Swap failed: ${err.message}`, 'error');
          btn.disabled = false;
          btn.textContent = '⚡ Swap In';
        }
      });
    });

    // Remove from favorites handlers
    document.querySelectorAll('.btn-del-fav').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        if (!confirm('Remove this asset from your cross-project favorites library?')) return;
        try {
          const res = await fetch(`/favorites/${encodeURIComponent(id)}`, { method: 'DELETE' });
          if (res.ok) {
            showToast('✓ Removed favorite', 'info');
            await fetchFavoritesList();
            renderModal();
          }
        } catch (err) {
          showToast(`Delete failed: ${err.message}`, 'error');
        }
      });
    });

    // Star current disk asset
    document.getElementById('btn-star-current-file')?.addEventListener('click', async () => {
      const nameInput = document.getElementById('new-fav-name');
      const tagsInput = document.getElementById('new-fav-tags');
      const name = nameInput?.value.trim() || basename(node.id);
      const tags = tagsInput?.value.split(',').map(s => s.trim()).filter(Boolean) || [];

      try {
        // Read file content from project
        const contentRes = await fetch(`/file-content?projectPath=${encodeURIComponent(state.projectPath)}&filePath=${encodeURIComponent(node.id)}`);
        // Note: For binary glb, we read via /validate-asset or custom buffer
        const favRes = await fetch('/favorites', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            tags,
            sourceProject: state.projectPath,
            assetInfo: node.slot || node.contract?.slot || {}
          })
        });
        const favData = await favRes.json();
        if (favRes.ok && favData.success) {
          showToast(`✓ Starred "${name}" to favorites!`, 'success');
          await fetchFavoritesList();
          renderModal();
        } else {
          showToast(favData.error || 'Failed to star asset', 'error');
        }
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    // Upload custom file directly to favorites
    document.getElementById('new-fav-file-input')?.addEventListener('change', async (e) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;
      const file = files[0];
      const tagsInput = document.getElementById('new-fav-tags');
      const tags = tagsInput?.value.split(',').map(s => s.trim()).filter(Boolean) || [];

      const reader = new FileReader();
      reader.onload = async () => {
        const base64 = reader.result.split(',')[1];
        try {
          const res = await fetch('/favorites', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: file.name,
              tags,
              fileContent: base64,
              sourceProject: state.projectPath
            })
          });
          const data = await res.json();
          if (res.ok && data.success) {
            showToast(`✓ Added "${file.name}" to favorites!`, 'success');
            await fetchFavoritesList();
            renderModal();
          } else {
            showToast(data.error || 'Failed to add favorite', 'error');
          }
        } catch (err) {
          showToast(err.message, 'error');
        }
      };
      reader.readAsDataURL(file);
    });
  }

  renderModal();
}
