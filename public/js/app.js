/**
 * public/js/app.js
 * ContextForge Client Orchestration Entrypoint.
 * Bootstraps modules and binds top-level event handlers.
 */

import { state, subscribe, notifyStateChange } from './state.js';
import { showToast } from './shared/toast.js';
import { performUndo, performRedo, updateHistoryUI, initHistoryShortcuts } from './history/history.js';
import { handleQuickPaste, applyClipboardContentDirectly, openClipboardModal } from './clipboard/clipboard.js';
import { openConsoleModal, updateConsoleBadge, fetchConsoleLogs } from './terminal/terminal.js';
import {
  ensureDevServerRunning,
  stopManagedDevServer,
  togglePreviewPanel,
  reloadPreviewIframe,
  runHtmlFile,
  playGameInNewTab,
  updateDevServerUiState
} from './preview/preview.js';
import { updateSidebarTree, selectFile, saveRawFile, projectDiskFiles } from './sidebar/tree.js';
import { openIssueReportModal, copyIssuePrompt } from './issue/issue-modal.js';

// Export for module consumers
export {
  state,
  subscribe,
  showToast,
  performUndo,
  performRedo,
  updateHistoryUI,
  handleQuickPaste,
  applyClipboardContentDirectly,
  openClipboardModal,
  openConsoleModal,
  updateConsoleBadge,
  fetchConsoleLogs,
  ensureDevServerRunning,
  stopManagedDevServer,
  togglePreviewPanel,
  reloadPreviewIframe,
  runHtmlFile,
  playGameInNewTab,
  updateSidebarTree,
  selectFile,
  saveRawFile,
  openIssueReportModal,
  copyIssuePrompt,
  projectDiskFiles
};

// Expose on window for inline event handlers and browser tests
window.ContextForge = {
  state,
  showToast,
  performUndo,
  performRedo,
  updateHistoryUI,
  handleQuickPaste,
  applyClipboardContentDirectly,
  openClipboardModal,
  openConsoleModal,
  updateConsoleBadge,
  fetchConsoleLogs,
  ensureDevServerRunning,
  stopManagedDevServer,
  togglePreviewPanel,
  reloadPreviewIframe,
  runHtmlFile,
  playGameInNewTab,
  updateSidebarTree,
  selectFile,
  saveRawFile,
  openIssueReportModal,
  copyIssuePrompt
};

// Wire up global keyboard shortcuts (Ctrl+Z, Ctrl+Y)
initHistoryShortcuts();
